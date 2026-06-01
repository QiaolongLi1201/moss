import { truncateToolOutput } from '../../context/tool-output-truncate.js';
import { getRootLogger } from '../../logger.js';
import type { LLMMessage } from '../llm/llm-provider.js';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import {
  executeOneToolCall,
  outcomeToResult,
  type ExecuteToolCallOutcome,
} from '../tools/execute-tool-call.js';
import { maybeSuppressRedundantWebFetchAfterOpenUrl } from '../tools/open-url-web-fetch-guard.js';
import { notePendingAbortedToolCalls } from './pending-tool-aborts.js';
import type { Message, ContentBlock } from '../session/session-jsonl.js';
import type { Tool, ToolContext, ToolResultOutcome } from '../tools/tool-types.js';
import type { ToolHookRegistry } from '../tools/tool-hooks.js';
import { findReplayableToolResultContent } from '../tools/tool-idempotent-replay.js';
import {
  formatToolResultForSsePreview,
  groupToolCallsForExecution,
  skipToolCall,
  syncAssistantToolUseInput,
} from './agent-loop-tool-helpers.js';
import {
  formatToolLoopGuardMessage,
  shouldShortCircuitToolCall,
  type ToolLoopGuardState,
} from '../tools/tool-loop-guard.js';

const log = getRootLogger().child('agent:loop');

export interface AgentLoopToolExecutionMetrics {
  totalToolCalls: number;
  toolErrors: number;
  consecutiveToolErrors: number;
  toolCallsByName: Record<string, number>;
  prepNextTurnParallelMs: number;
}

export interface ExecuteAgentLoopToolCallsParams {
  sessionKey: string;
  currentMessages: Message[];
  assistantContent: ContentBlock[];
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  resolveToolsForRun: () => Tool[];
  toolCtx: ToolContext;
  toolHooks?: ToolHookRegistry;
  abortSignal: AbortSignal;
  toolTimeoutMs: number;
  toolHeartbeatIntervalMs: number;
  skipHeartbeatToolNames: Set<string>;
  checkToolApproval?: (call: {
    id: string;
    name: string;
    input: unknown;
  }) => Promise<{ approved: boolean; decision: string; reason?: string } | null>;
  toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;
  enrichToolContext?: (baseCtx: ToolContext, sessionKey: string) => ToolContext;
  parallelSafeTools: Set<string>;
  loadToolsMetaName?: string;
  toolLoopGuard: ToolLoopGuardState;
  metrics: AgentLoopToolExecutionMetrics;
  evaluateSteering: () => Message[];
  appendMessage: (sessionKey: string, msg: Message) => Promise<void>;
  push: (event: MiniAgentEvent) => void;
}

export async function executeAgentLoopToolCalls(
  params: ExecuteAgentLoopToolCallsParams,
): Promise<{ pendingMessages: Message[] }> {
  const {
    sessionKey,
    currentMessages,
    assistantContent,
    toolCalls,
    resolveToolsForRun,
    toolCtx,
    toolHooks,
    abortSignal,
    toolTimeoutMs,
    toolHeartbeatIntervalMs,
    skipHeartbeatToolNames,
    checkToolApproval,
    toolAbortSignalFor,
    enrichToolContext,
    parallelSafeTools,
    loadToolsMetaName,
    toolLoopGuard,
    metrics,
    evaluateSteering,
    appendMessage,
    push,
  } = params;

  const toolResults: ContentBlock[] = [];
  let steeringMessages: Message[] | null = null;
  // Type bridge: slice preserves Message type compatibility
  const historyBeforeAssistant = currentMessages.slice(0, -1) as unknown as LLMMessage[];

  const preflightToolCall = (
    call: { id: string; name: string; input: Record<string, unknown> },
  ): ExecuteToolCallOutcome | null => {
    const loopReason = shouldShortCircuitToolCall(toolLoopGuard, call.name, call.input);
    if (loopReason) {
      log.warn('tool loop guard short-circuited tool call', {
        tool: call.name,
        reason: loopReason,
        sessionKey,
      });
      return {
        kind: 'pre-blocked',
        text: formatToolLoopGuardMessage(loopReason, call.name),
      };
    }

    const fetchSuppressed =
      call.name === 'web_fetch'
        ? maybeSuppressRedundantWebFetchAfterOpenUrl(
            historyBeforeAssistant,
            String((call.input as Record<string, unknown>)?.url ?? ''),
          )
        : null;
    if (fetchSuppressed) {
      log.info('web_fetch suppressed (open_url already opened the page)', {
        url: (call.input as Record<string, unknown>)?.url,
      });
      return {
        kind: 'completed',
        text: fetchSuppressed,
        isError: false,
        durationMs: 0,
        outcome: 'suppressed',
      };
    }

    const resolvedTools = resolveToolsForRun();
    const toolMeta = resolvedTools.find((t) => t.name === call.name)?.metadata;
    const replayed = findReplayableToolResultContent(
      historyBeforeAssistant,
      call.name,
      call.input,
      6,
      toolMeta?.sideEffectClass,
    );
    if (replayed) {
      log.info('tool replay: reusing recent identical-params result', {
        tool: call.name,
      });
      return {
        kind: 'completed',
        text: replayed,
        isError: false,
        durationMs: 0,
        outcome: 'replayed',
      };
    }

    return null;
  };

  const recordToolOutcome = (
    call: { id: string; name: string; input: Record<string, unknown> },
    outcome: ExecuteToolCallOutcome,
  ): void => {
    syncAssistantToolUseInput(assistantContent, call);
    if (outcome.kind !== 'completed') {
      push({
        type: 'tool_execution_start',
        toolCallId: call.id,
        toolName: call.name,
        args: call.input,
      });
    }

    const { text: result, isError, structuredContent: rawStructuredContent } = outcomeToResult(outcome);
    const toolOutcome: ToolResultOutcome =
      outcome.kind === 'completed'
        ? outcome.outcome ?? (isError ? 'error' : 'ok')
        : outcome.kind === 'denied'
          ? 'denied'
          : 'blocked';
    const durationMs = outcome.kind === 'completed' ? outcome.durationMs : 0;
    const MAX_STRUCTURED_SIZE = 12_000;
    let structuredContent = rawStructuredContent;
    if (structuredContent && structuredContent.length > 0) {
      const serialized = JSON.stringify(structuredContent);
      if (serialized.length > MAX_STRUCTURED_SIZE) {
        structuredContent = [{ type: 'text', text: `[structured content truncated: ${serialized.length} chars exceeded ${MAX_STRUCTURED_SIZE} limit]` }];
      }
    }
    metrics.totalToolCalls++;
    metrics.toolCallsByName[call.name] = (metrics.toolCallsByName[call.name] ?? 0) + 1;
    if (isError) {
      metrics.toolErrors++;
      metrics.consecutiveToolErrors++;
    } else {
      metrics.consecutiveToolErrors = 0;
    }

    const truncatedResult = truncateToolOutput(call.name, result);
    const preview =
      outcome.kind === 'hook-blocked' || outcome.kind === 'denied'
        ? truncatedResult
        : formatToolResultForSsePreview(truncatedResult, isError);

    push({
      type: 'tool_execution_end',
      toolCallId: call.id,
      toolName: call.name,
      result: preview,
      isError,
      args: call.input,
      outcome: toolOutcome,
      durationMs,
      content: truncatedResult,
      ...(outcome.kind === 'completed' && outcome.aborted
        ? { aborted: outcome.aborted }
        : {}),
      ...(structuredContent ? { structuredContent } : {}),
    });
    toolResults.push({
      type: 'tool_result',
      tool_use_id: call.id,
      name: call.name,
      content: truncatedResult,
      is_error: isError,
      outcome: toolOutcome,
      durationMs,
      ...(outcome.kind === 'completed' && outcome.aborted
        ? { aborted: outcome.aborted }
        : {}),
      ...(structuredContent ? { structuredContent } : {}),
    });
  };

  const skipRemainingToolCalls = (
    calls: { id: string; name: string }[],
  ): void => {
    for (const skipped of calls) {
      push({
        type: 'tool_skipped',
        toolCallId: skipped.id,
        toolName: skipped.name,
      });
      toolResults.push(skipToolCall(skipped));
    }
  };

  const effectiveParallelSafeTools = checkToolApproval
    ? new Set<string>()
    : parallelSafeTools;
  const toolGroups = groupToolCallsForExecution(
    toolCalls,
    effectiveParallelSafeTools,
    loadToolsMetaName,
  );

  for (const group of toolGroups) {
    const toolsForRun = resolveToolsForRun();
    if (steeringMessages) {
      skipRemainingToolCalls(group.calls);
      continue;
    }

    // Defense: when checkToolApproval is set (approval required), effectiveParallelSafeTools
    // is forced to an empty Set, so the parallel branch is never taken — every tool call
    // goes through the serial path where checkToolApproval is invoked per-call.
    if (group.parallel && group.calls.length > 1) {
      const settled = await Promise.allSettled(
        group.calls.map((call) => {
          const execCall = {
            id: call.id,
            name: call.name,
            input: { ...call.input },
          };
          const preflight = preflightToolCall(execCall);
          if (preflight) return Promise.resolve(preflight);
          const perToolTimeout = toolsForRun.find((t) => t.name === call.name)?.metadata?.timeoutMs;
          return executeOneToolCall(execCall, {
            toolsForRun,
            toolCtx,
            sessionKey,
            toolHooks,
            abortSignal,
            toolTimeoutMs: perToolTimeout ?? toolTimeoutMs,
            enableHeartbeat: true,
            heartbeatIntervalMs: toolHeartbeatIntervalMs,
            skipHeartbeatToolNames,
            checkToolApproval: undefined,
            toolAbortSignalFor,
            enrichToolContext,
            push,
            onBeforeStartEmit: (input) => {
              execCall.input = input;
              syncAssistantToolUseInput(assistantContent, execCall);
            },
          }).then((outcome) => {
            call.input = execCall.input;
            return outcome;
          });
        }),
      );
      for (let j = 0; j < group.calls.length; j++) {
        const call = group.calls[j];
        const s = settled[j];
        const outcome: ExecuteToolCallOutcome =
          s.status === 'fulfilled'
            ? s.value
            : {
                kind: 'pre-blocked',
                text: `Execution error: ${String((s as PromiseRejectedResult).reason)}`,
              };
        recordToolOutcome(call, outcome);
      }
      const steering = evaluateSteering();
      if (steering.length > 0) {
        steeringMessages = steering;
      }
    } else {
      for (let gi = 0; gi < group.calls.length; gi++) {
        const call = group.calls[gi];
        const preflight = preflightToolCall(call);
        if (preflight) {
          recordToolOutcome(call, preflight);
          continue;
        }

        const serialToolsForRun = resolveToolsForRun();
        const perToolTimeout = serialToolsForRun.find((t) => t.name === call.name)?.metadata?.timeoutMs;
        const outcome = await executeOneToolCall(call, {
          toolsForRun: serialToolsForRun,
          toolCtx,
          sessionKey,
          toolHooks,
          abortSignal,
          toolTimeoutMs: perToolTimeout ?? toolTimeoutMs,
          enableHeartbeat: true,
          heartbeatIntervalMs: toolHeartbeatIntervalMs,
          skipHeartbeatToolNames,
          checkToolApproval,
          toolAbortSignalFor,
          enrichToolContext,
          push,
          onBeforeStartEmit: (input) => {
            syncAssistantToolUseInput(assistantContent, { ...call, input });
          },
        });

        if (outcome.kind === 'hook-blocked') {
          recordToolOutcome(call, outcome);
          const steering = evaluateSteering();
          if (steering.length > 0) {
            steeringMessages = steering;
          }
          if (steeringMessages) {
            skipRemainingToolCalls(group.calls.slice(gi + 1));
            break;
          }
          continue;
        }

        if (outcome.kind === 'denied') {
          recordToolOutcome(call, outcome);
          const steering = evaluateSteering();
          if (steering.length > 0) {
            steeringMessages = steering;
            skipRemainingToolCalls(group.calls.slice(gi + 1));
          }
          if (steeringMessages) break;
          continue;
        }

        recordToolOutcome(call, outcome);

        const steering = evaluateSteering();
        if (steering.length > 0) {
          steeringMessages = steering;
          skipRemainingToolCalls(group.calls.slice(gi + 1));
          break;
        }
      }
    }
  }

  const resultMsg: Message = {
    role: 'user',
    content: toolResults,
    timestamp: Date.now(),
  };

  // If the run was already aborted, do NOT persist or push the stale tool result —
  // a new run may have already rewritten the session file.
  if (abortSignal.aborted) {
    notePendingAbortedToolCalls(
      sessionKey,
      toolCalls.map((c) => ({ id: c.id, name: c.name })),
    );
    return { pendingMessages: [] };
  }

  let toolResultMsgPersisted = false;
  let newSteering: Message[] = [];
  try {
    const parallelStartMs = Date.now();
    // Persist the tool result first — if this fails, we must not mark
    // tools as aborted (they ran successfully, just weren't persisted).
    await appendMessage(sessionKey, resultMsg);
    toolResultMsgPersisted = true;
    // Fetch steering in parallel after persist succeeds.
    newSteering = evaluateSteering();
    metrics.prepNextTurnParallelMs += Date.now() - parallelStartMs;
  } finally {
    if (abortSignal.aborted && !toolResultMsgPersisted) {
      notePendingAbortedToolCalls(
        sessionKey,
        toolCalls.map((c) => ({ id: c.id, name: c.name })),
      );
    }
  }
  // Persist BEFORE mutating in-memory: if persist crashes, in-memory stays clean.
  currentMessages.push(resultMsg);

  return {
    pendingMessages: steeringMessages && steeringMessages.length > 0
      ? steeringMessages
      : newSteering,
  };
}
