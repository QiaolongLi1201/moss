/**
 * Unified single-tool-call executor — used by BOTH the parallel and the serial
 * branches inside runAgentLoop. Eliminates the historical duplication between
 * `runParallelSafeToolCall` and the inline serial loop.
 *
 * Pipeline (in order, each gate emits a single result on early exit):
 *   1. Resolve tool by name (unknown → error result)
 *   2. JSON-Schema validate input
 *   3. Run pre-tool hook chain (host-injected pre-hooks, e.g. open-url-web-fetch-guard)
 *   4. (optional) Tool approval (allow-once / allow-always / deny)
 *   5. ToolHookRegistry.runPreHooks (block / modify / allow)
 *   6. Emit tool_execution_start exactly once (idempotent emitStart helper)
 *   7. Optional periodic tool_execution_progress heartbeat
 *   8. Execute with timeout race + abort signal
 *   9. ToolHookRegistry.runPostHooks
 *  10. ToolHookRegistry.runPostFailureHooks (only if errFlag && reachedExecute)
 *
 * The function is intentionally outcome-agnostic: it does not record metrics
 * (totalToolCalls, toolErrors), does not push tool_execution_end, and does not
 * read or mutate steering state. Those concerns stay in runAgentLoop because
 * they affect cross-call decisions (skipping siblings, etc.).
 */

import type { Tool, ToolContext, ToolContentBlock, ToolResultOutcome } from './tool-types.js';
import type { ToolHookRegistry } from './tool-hooks.js';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import { abortable, combineAbortSignals } from '../agent/abort.js';
import { describeError, isTimeoutError, isTransientError } from '../../provider/errors.js';
import { getRootLogger } from '../../logger.js';
import { runPreToolHookChain, validateToolInputObject } from './tool-pipeline.js';
import { DmossError, ErrorCode } from '../../errors.js';

const logger = getRootLogger();

/** Tool names eligible for internal transient retry (readonly, no side effects). */
const TRANSIENT_RETRY_TOOLS = new Set(['read_file', 'search_code', 'search_files']);
/** Max additional attempts after the initial failure (3 total including initial call). */
const MAX_RETRY_ATTEMPTS = 2;

function resolveMaxMissedHeartbeats(
  toolTimeoutMs: number,
  heartbeatIntervalMs: number,
  explicitMaxMissed?: number,
): number {
  if (explicitMaxMissed !== undefined) return Math.max(1, explicitMaxMissed);
  const normalizedIntervalMs = Math.max(1, heartbeatIntervalMs);
  return Math.max(1, Math.ceil(toolTimeoutMs / normalizedIntervalMs));
}

function textFromStructuredContent(content: ToolContentBlock[]): string {
  const text = content
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'resource' && typeof block.text === 'string') return block.text;
      return '';
    })
    .filter((part) => part.length > 0)
    .join('\n');
  if (text) return text;
  if (content.length > 0) {
    return `[${content.length} content block(s): ${content.map((block) => block.type).join(', ')}]`;
  }
  return '';
}

export interface ExecuteToolCallDeps {
  toolsForRun: Tool[];
  toolCtx: ToolContext;
  sessionKey: string;
  toolHooks?: ToolHookRegistry;
  abortSignal: AbortSignal;
  toolTimeoutMs: number;
  /** When false, no setInterval heartbeat is started. */
  enableHeartbeat: boolean;
  /** Heartbeat tick (ignored when enableHeartbeat=false). */
  heartbeatIntervalMs: number;
  /** Tool names that emit their own progress; agent-level heartbeat is skipped. */
  skipHeartbeatToolNames: ReadonlySet<string>;
  /** Optional per-tool abort signal used by legacy DmossAgent streamChat hosts. */
  toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;
  /** Optional host context enrichment, run at the per-tool boundary. */
  enrichToolContext?: (baseCtx: ToolContext, sessionKey: string) => ToolContext;
  /** Approval gate. Returning null means "no approval required for this call". */
  checkToolApproval?: (call: {
    id: string;
    name: string;
    input: unknown;
  }) => Promise<{ approved: boolean; decision: string; reason?: string } | null>;
  /**
   * Push handler for SSE-style events. Mirrors the local stream.push from
   * runAgentLoop. The executor pushes:
   *   - tool_execution_start (once)
   *   - tool_execution_progress (periodic, when enableHeartbeat=true)
   *   - tool_approval_request / tool_approval_resolved (when approval gate fires)
   * `tool_execution_end` is intentionally NOT pushed here — runAgentLoop owns
   * the truncation + preview-formatting logic right before pushing it.
   */
  push: (event: MiniAgentEvent) => void;
  /**
   * Hook fired exactly once before the tool actually starts executing.
   * Used by the caller to sync the assistantContent tool_use input with
   * any modifications applied by hooks/normalizers. Always called BEFORE
   * the tool_execution_start event is pushed.
   */
  onBeforeStartEmit?: (mutatedInput: Record<string, unknown>) => void;
  /**
   * C4 watchdog: max consecutive heartbeats with no tool progress before forced abort.
   * Defaults to the full tool timeout window so heartbeats don't preempt timeoutMs.
   */
  maxMissedHeartbeats?: number;
}

/**
 * Discriminated result. The caller maps these to tool_execution_end + tool_result
 * blocks; for `denied` the caller also breaks the rest of the group.
 */
export type ExecuteToolCallOutcome =
  | {
      kind: 'completed';
      text: string;
      isError: boolean;
      durationMs: number;
      outcome?: ToolResultOutcome;
      aborted?: { by: 'user' | 'timeout' };
      structuredContent?: ToolContentBlock[];
    }
  | {
      kind: 'unknown-tool';
      text: string;
    }
  | {
      kind: 'pre-blocked';
      text: string;
    }
  | {
      kind: 'hook-blocked';
      text: string;
    }
  | {
      kind: 'denied';
      text: string;
    };

export async function executeOneToolCall(
  call: { id: string; name: string; input: Record<string, unknown> },
  deps: ExecuteToolCallDeps,
): Promise<ExecuteToolCallOutcome> {
  try {
  // ── 1. Resolve tool ─────────────────────────────────────────
  const tool = deps.toolsForRun.find((t) => t.name === call.name);
  if (!tool) {
    return { kind: 'unknown-tool', text: `Unknown tool: ${call.name}` };
  }

  // ── 2. Schema validate ──────────────────────────────────────
  const schemaCheck = validateToolInputObject(tool, call.input);
  if (!schemaCheck.ok) {
    return { kind: 'pre-blocked', text: schemaCheck.message };
  }

  // ── 3. Pre-tool hook chain ──────────────────────────────────
  const hooked = await runPreToolHookChain(call.name, schemaCheck.value, deps.sessionKey);
  if (!hooked.ok) {
    return { kind: 'pre-blocked', text: hooked.message };
  }
  call.input = hooked.input;

  const perToolAbortSignal = deps.toolAbortSignalFor?.(call.id);
  const effectiveAbortSignal = combineAbortSignals(deps.abortSignal, perToolAbortSignal) ?? deps.abortSignal;
  let callToolCtx: ToolContext = {
    ...deps.toolCtx,
    abortSignal: effectiveAbortSignal,
    toolCallId: call.id,
  };
  if (deps.enrichToolContext) {
    callToolCtx = deps.enrichToolContext(callToolCtx, deps.sessionKey);
  }

  // ── 4. Approval ─────────────────────────────────────────────
  let approvalTriggered = false;
  if (deps.checkToolApproval) {
    const approval = await deps.checkToolApproval(call);
    if (approval !== null) {
      approvalTriggered = true;
      const decision = approval.decision as 'allow-once' | 'allow-always' | 'deny';
      deps.push({
        type: 'tool_approval_request',
        toolCallId: call.id,
        toolName: call.name,
        args: call.input,
      });
      deps.push({
        type: 'tool_approval_resolved',
        toolCallId: call.id,
        toolName: call.name,
        decision,
      });
      if (!approval.approved) {
        const reason = approval.reason?.trim();
        return {
          kind: 'denied',
          text: reason ? `Tool execution denied: ${reason}` : 'Tool execution denied by user.',
        };
      }
    }
  }

  // ── 5. ToolHookRegistry pre-hooks ───────────────────────────
  if (deps.toolHooks) {
    const { decision, hookName } = await deps.toolHooks.runPreHooks({
      tool,
      input: call.input,
      ctx: callToolCtx,
      sessionId: deps.sessionKey,
    });
    if (decision.action === 'block') {
      return { kind: 'hook-blocked', text: `[${hookName}] ${decision.reason}` };
    }
    if (decision.action === 'modify') {
      call.input = decision.input;
    }
  }

  // ── 6. Emit start (once) ────────────────────────────────────
  let startEmitted = false;
  const emitStart = () => {
    if (startEmitted) return;
    startEmitted = true;
    deps.onBeforeStartEmit?.(call.input);
    deps.push({
      type: 'tool_execution_start',
      toolCallId: call.id,
      toolName: call.name,
      args: call.input,
    });
  };

  // ── 7+8. Heartbeat + Execute with timeout (with internal transient retry) ─
  const startMs = Date.now();
  let text = '';
  let errFlag = false;
  let reachedExecute = false;
  let aborted: { by: 'user' | 'timeout' } | undefined;
  let structuredBlocks: ToolContentBlock[] | undefined;

  const skipAgentHeartbeat =
    !deps.enableHeartbeat || deps.skipHeartbeatToolNames.has(call.name);

  let retriesUsed = 0;
  const eligibleForRetry =
    (tool.metadata?.transientRetry ?? TRANSIENT_RETRY_TOOLS.has(call.name)) && !approvalTriggered;

  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    // Abort check before (re)attempt — preserves cancelled semantics
    if (deps.abortSignal.aborted) {
      aborted = { by: 'user' };
      text = text || 'Execution error: aborted_by_user: cancelled before retry';
      errFlag = true;
      break;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
    let attemptErrFlag = false;
    let attemptText = '';
    let attemptTimeout = false;
    const timeoutAbortCtrl = new AbortController();

    try {
      const toolTimeoutPromise = new Promise<never>(
        (_, reject) =>
          (timeoutHandle = setTimeout(
            () => {
              try { timeoutAbortCtrl.abort(); } catch { /* noop */ }
              reject(
                new DmossError({ code: ErrorCode.TOOL_EXECUTION_TIMEOUT, message: `Tool ${call.name} timed out (${deps.toolTimeoutMs / 1000}s)` }),
              );
            },
            deps.toolTimeoutMs,
          )),
      );
      // Combine timeout signal with the existing abort signal so tools that
      // listen on ctx.abortSignal can cooperatively cancel on timeout too.
      const attemptSignal =
        combineAbortSignals(effectiveAbortSignal, timeoutAbortCtrl.signal) ?? effectiveAbortSignal;
      const attemptCtx: ToolContext = { ...callToolCtx, abortSignal: attemptSignal };
      if (!skipAgentHeartbeat) {
        const heartbeatIntervalMs = Math.max(1, deps.heartbeatIntervalMs);
        const maxMissed = resolveMaxMissedHeartbeats(
          deps.toolTimeoutMs,
          heartbeatIntervalMs,
          deps.maxMissedHeartbeats,
        );
        let beatsFired = 0;
        heartbeatHandle = setInterval(() => {
          const elapsed = Math.round((Date.now() - startMs) / 1000);
          beatsFired++;
          deps.push({
            type: 'tool_execution_progress',
            toolCallId: call.id,
            toolName: call.name,
            elapsed_sec: elapsed,
          });
          // C4 watchdog: force abort after N heartbeats with no tool completion.
          if (beatsFired >= maxMissed) {
            logger.warn(
              `[execute-tool-call] watchdog: ${call.name}(${call.id}) exceeded ${maxMissed} heartbeats — force aborting`,
            );
            try { timeoutAbortCtrl.abort(); } catch { /* noop */ }
          }
        }, heartbeatIntervalMs);
      }
      // Emit start exactly once on the first attempt
      if (attempt === 0) emitStart();
      reachedExecute = true;
      if (tool.executeStructured) {
        const structured = await Promise.race([
          abortable(
            tool.executeStructured(call.input, attemptCtx),
            attemptSignal,
          ),
          toolTimeoutPromise,
        ]);
        structuredBlocks = structured.content;
        attemptText = textFromStructuredContent(structured.content);
        if (structured.isError) {
          attemptErrFlag = true;
        }
      } else {
        attemptText = await Promise.race([
          abortable(
            tool.execute(call.input, attemptCtx),
            attemptSignal,
          ),
          toolTimeoutPromise,
        ]);
      }
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      if (timeoutAbortCtrl.signal.aborted && !deps.abortSignal.aborted && !perToolAbortSignal?.aborted) {
        attemptTimeout = true;
        attemptText = `Execution error: Tool ${call.name} timed out (${deps.toolTimeoutMs / 1000}s)`;
      } else if (deps.abortSignal.aborted || (perToolAbortSignal?.aborted && !deps.abortSignal.aborted)) {
        aborted = { by: 'user' };
        attemptText = 'Execution error: aborted_by_user: cancelled during execution';
      } else if (/timed out/i.test(rawMessage)) {
        attemptTimeout = true;
        attemptText = `Execution error: ${rawMessage}`;
      } else {
        attemptText = `Execution error: ${rawMessage}`;
      }
      attemptErrFlag = true;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (heartbeatHandle) clearInterval(heartbeatHandle);
    }

    // Check retry eligibility before committing to final outcome
    if (attemptErrFlag && eligibleForRetry && attempt < MAX_RETRY_ATTEMPTS && !aborted) {
      const rawMsg = attemptText.replace(/^Execution error:\s*/, '');
      if (isTransientError(rawMsg) || isTimeoutError(rawMsg)) {
        retriesUsed++;
        const delayMs = retriesUsed === 1 ? 500 : 1500;
        logger.debug(
          `[execute-tool-call] retry #${retriesUsed}/${MAX_RETRY_ATTEMPTS} for ${call.name}(${call.id}) after ${delayMs}ms: ${rawMsg.slice(0, 120)}`,
        );
        // Abortable backoff — abort immediately cancels the wait
        let backoffTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          new Promise<void>((resolve) => { backoffTimer = setTimeout(resolve, delayMs); }),
          abortable(
            new Promise<never>(() => {}),
            deps.abortSignal,
          ).catch(() => {}),
        ]);
        if (backoffTimer) clearTimeout(backoffTimer);
        // Re-check abort after backoff; if aborted, break with cancelled path
        if (deps.abortSignal.aborted) {
          aborted = { by: 'user' };
          text = 'Execution error: aborted_by_user: cancelled during retry backoff';
          errFlag = true;
          break;
        }
        continue;
      }
    }

    // Final outcome: commit to timeout abort only on final attempt
    if (attemptTimeout && !aborted) {
      aborted = { by: 'timeout' };
    }
    text = attemptText;
    errFlag = attemptErrFlag;
    break;
  }

  // Make sure start was emitted even on early throws before reachedExecute was set
  emitStart();

  // ── 9. Post hooks ───────────────────────────────────────────
  if (deps.toolHooks) {
    text = await deps.toolHooks.runPostHooks({
      tool,
      input: call.input,
      result: text,
      isError: errFlag,
      durationMs: Date.now() - startMs,
      ctx: callToolCtx,
      sessionId: deps.sessionKey,
    });
  }

  // ── 10. Post-failure hooks ──────────────────────────────────
  if (errFlag && deps.toolHooks && reachedExecute) {
    text = await deps.toolHooks.runPostFailureHooks({
      tool,
      input: call.input,
      result: text,
      durationMs: Date.now() - startMs,
      ctx: callToolCtx,
      sessionId: deps.sessionKey,
    });
  }

  return {
    kind: 'completed',
    text,
    isError: errFlag,
    durationMs: Date.now() - startMs,
    ...(aborted ? { aborted } : {}),
    ...(structuredBlocks ? { structuredContent: structuredBlocks } : {}),
  };
  } catch (err) {
    return { kind: 'pre-blocked', text: `Execution error: ${describeError(err)}` };
  }
}

/**
 * Map an outcome to (text, isError) for the simple cases callers need.
 * Caller still decides what to do with `denied` (steering checks).
 */
export function outcomeToResult(outcome: ExecuteToolCallOutcome): {
  text: string;
  isError: boolean;
  structuredContent?: ToolContentBlock[];
} {
  switch (outcome.kind) {
    case 'completed':
      return {
        text: outcome.text,
        isError: outcome.isError,
        ...(outcome.structuredContent ? { structuredContent: outcome.structuredContent } : {}),
      };
    case 'unknown-tool':
    case 'pre-blocked':
    case 'hook-blocked':
    case 'denied':
      return { text: outcome.text, isError: true };
  }
}
