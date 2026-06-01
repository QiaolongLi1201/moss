/** Core agent loop: orchestrates context prep, LLM turns, tool execution and follow-ups. */

import type {
  EventStream,
} from '../../provider/pi-ai-types.js';
import { getRootLogger } from '../../logger.js';

const log = getRootLogger().child('agent:loop');
import type { Message } from '../session/session-jsonl.js';
import {
  describeError,
} from '../../provider/errors.js';
import {
  classifyLlmError,
} from '../llm/llm-error-classifier.js';
import {
  ensureKeepAliveDispatcherInstalled,
  wasConnectionReused,
} from '../../provider/keep-alive-dispatcher.js';
import { resolveToolFollowupBypassCap } from '../../utils/max-agent-turns.js';
import {
  resolveContextCharsPerTokenUnit,
  estimateMessagesChars,
} from '../../context/tokens.js';
import {
  createMiniAgentStream,
  type MiniAgentEvent,
  type MiniAgentResult,
} from '../subagent/agent-events.js';
import {
  bumpAgentLoopRunEpoch,
  guardMiniAgentStreamPush,
} from './agent-loop-push-guard.js';
import {
  consumePendingAbortedToolSyntheticMessages,
} from './pending-tool-aborts.js';
import {
  getEffectiveContextWindowTokens,
} from '../../context/window-economics.js';
import {
  logLLMUsage,
} from '../../observability/llm-usage.js';
import { readEnv, readEnvFlag } from '../../utils/env-compat.js';
import { isPromptPrefixDebugEnabled } from '../llm/prompt-prefix-cache.js';
import {
  createToolLoopGuardState,
} from '../tools/tool-loop-guard.js';
import type { AgentLoopHardCaps, AgentLoopParams } from './agent-loop-types.js';
import { createInitialLoopState, resetIterationState } from './agent-loop-state.js';
import type { SteeringContext } from './steering.js';
import {
  prepareTurnContext,
  shouldIncludeThinkingInBudget,
} from './agent-loop-context-prep.js';
import {
  executeLlmTurn,
} from './agent-loop-llm-call.js';
import {
  processLlmResponse,
} from './agent-loop-response.js';
export type {
  AgentLoopDeps,
  AgentLoopExtensions,
  AgentLoopHardCaps,
  AgentLoopIdentity,
  AgentLoopParams,
  AgentLoopPlatformConfig,
  AgentLoopPolicy,
  AgentLoopPromptInput,
  AgentLoopProviderInput,
  AgentLoopToolInput,
} from './agent-loop-types.js';

// ============== Platform configuration ==============

// C4: Reduced from 30 min to 5 min to prevent resource zombization on hung tools.
const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TOOL_HEARTBEAT_INTERVAL_MS = 30_000;

/** Hard cap on message count to prevent unbounded growth when context window is large. */
const HARD_CAP_MESSAGE_COUNT = 200;

/**
 * H1: Hard cap on estimated prompt tokens — force compaction when exceeded regardless of window economics.
 * 125K tokens ≈ 500K chars at 4:1 ratio. Once compaction succeeds the cap backs off.
 */
const HARD_CAP_TOTAL_TOKENS = 125_000;

/**
 * C3: Consecutive per-turn error budget — after this many consecutive turn errors,
 * propagate instead of looping. Prevents zombie loops on fatal provider errors.
 */
const MAX_CONSECUTIVE_TURN_ERRORS = 2;

const MAX_OUTPUT_CONTINUATIONS = 3;

export function resolveEffectiveCaps(hardCaps?: AgentLoopHardCaps) {
  return {
    maxMessageCount: (hardCaps?.maxMessageCount && hardCaps.maxMessageCount > 0) ? hardCaps.maxMessageCount : HARD_CAP_MESSAGE_COUNT,
    maxTotalTokens: (hardCaps?.maxTotalTokens && hardCaps.maxTotalTokens > 0) ? hardCaps.maxTotalTokens : HARD_CAP_TOTAL_TOKENS,
    maxConsecutiveTurnErrors: (hardCaps?.maxConsecutiveTurnErrors && hardCaps.maxConsecutiveTurnErrors > 0) ? hardCaps.maxConsecutiveTurnErrors : MAX_CONSECUTIVE_TURN_ERRORS,
    maxOutputContinuations: (hardCaps?.maxOutputContinuations && hardCaps.maxOutputContinuations > 0) ? hardCaps.maxOutputContinuations : MAX_OUTPUT_CONTINUATIONS,
  };
}

/** Whether the context ends with a just-written tool_result user message that still needs an LLM call to read the result and respond. */
export function lastMessageNeedsToolFollowUpLlm(messages: Message[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return false;
  const c = last.content;
  if (!Array.isArray(c)) return false;
  return c.some(
    (b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result',
  );
}

/** Build a synthetic user message that corrects the model (self-healing paths). */
function buildCorrectionMessage(systemText: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text: systemText }],
    timestamp: Date.now(),
  };
}

// ============== Main loop ==============

export function runAgentLoop(
  params: AgentLoopParams,
): EventStream<MiniAgentEvent, MiniAgentResult> {
  const stream = createMiniAgentStream();

  // Process-level keepAlive connection pool idempotent install.
  // fire-and-forget: async installer does not block the first LLM turn; subsequent calls are no-op.
  void ensureKeepAliveDispatcherInstalled();

  (async () => {
    const {
      runId,
      sessionKey,
      currentMessages,
      systemPrompt,
      systemPromptParts,
      getToolsForRun,
      toolCtx,
      modelDef,
      streamFn,
      apiKey,
      temperature,
      topP,
      reasoning,
      maxTurns,
      contextTokens,
      getFollowUpMessages,
      appendMessage,
      prepareCompaction,
      abortSignal,
      maxOutputTokens: maxOutputTokensParam,
      pruningSettings,
      compactHooks,
      systemPromptMeta,
      platform,
      hardCaps,
      steeringEngine,
    } = params;

    const persistCurrentMessages = async (messages?: Message[]): Promise<void> => {
      if (params.replaceMessages) {
        await params.replaceMessages(sessionKey, messages ?? currentMessages);
      }
    };

    const runEpoch = bumpAgentLoopRunEpoch(sessionKey);
    guardMiniAgentStreamPush(stream, sessionKey, runEpoch);

    const parallelSafeTools = platform?.parallelSafeTools ?? new Set<string>();
    const toolTimeoutMs = platform?.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const toolHeartbeatIntervalMs =
      platform?.toolHeartbeatIntervalMs ?? DEFAULT_TOOL_HEARTBEAT_INTERVAL_MS;
    const skipHeartbeatToolNames = platform?.skipHeartbeatToolNames ?? new Set<string>();
    const loadToolsMetaName = platform?.loadToolsMetaName;

    const effectiveCaps = resolveEffectiveCaps(hardCaps);

    const state = createInitialLoopState();
    state.compactionSummary = params.compactionSummary;
    const toolFollowupBypassCap = resolveToolFollowupBypassCap(maxTurns);
    const prefixDebugEnabled = platform?.promptPrefixDebug ?? isPromptPrefixDebugEnabled();
    // C1 note: kept outside state — these are observability scratch variables for
    // prompt prefix cache stability checks, not loop-control state.
    let previousPrefixSnapshot: Message[] | null = null;
    let previousToolNames: string[] | null = null;

    const runStartMs = Date.now();
    const INTER_TURN_SILENCE_WINDOW = 50;
    const toolLoopGuard = createToolLoopGuardState();

    // C1: Shift-based flush helper — removes each message AFTER successful append,
    // so partial failure leaves only unflushed messages in the buffer (no duplicates).
    const flushAssistantBuffer = async (buffer: Message[]): Promise<void> => {
      while (buffer.length > 0) {
        const msg = buffer[0]!;
        await appendMessage(sessionKey, msg);
        currentMessages.push(msg);
        buffer.shift();
      }
    };
    // M7: prefer platform config; fall back to env only when not explicitly set.
    const shouldRecordLlmUsage =
      platform?.recordLlmUsage ??
      (Boolean(readEnv('DMOSS_LLM_USAGE_LOG')) || readEnvFlag('DMOSS_LLM_USAGE'));
    // M7: resolve quiet flag once — prefer platform config over env.
    const isQuiet = platform?.quiet ?? readEnvFlag('DMOSS_QUIET');

    const recordLlmUsage = async (record: {
      runId: string;
      providerId: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      durationMs: number;
      success: boolean;
      error?: string;
    }): Promise<void> => {
      if (!shouldRecordLlmUsage) return;
      try {
        await logLLMUsage(record);
      } catch (err) {
        log.warn('failed to record llm usage', {
          runId: record.runId,
          providerId: record.providerId,
          model: record.model,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const resolveToolsForRun = () => getToolsForRun ? getToolsForRun() : params.toolsForRun;

    const evaluateSteering = (): Message[] => {
      if (!steeringEngine) return [];
      const maxOut = maxOutputTokensParam ?? modelDef.maxTokens ?? 8192;
      const effCtx = getEffectiveContextWindowTokens(contextTokens, maxOut);
      const steerCtx: SteeringContext = {
        // Type bridge: Message[] and LLMMessage[] share runtime structure
        messages: currentMessages as unknown as import('../llm/llm-provider.js').LLMMessage[],
        turn: state.turns,
        consecutiveToolErrors: state.toolExecutionMetrics.consecutiveToolErrors,
        totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
        contextUsageRatio: effCtx > 0
          ? estimateMessagesChars(
              currentMessages,
              { includeThinking: shouldIncludeThinkingInBudget(currentMessages, modelDef) },
            ) / (effCtx * resolveContextCharsPerTokenUnit())
          : 0,
        sessionKey,
      };
      const result = steeringEngine.evaluate(steerCtx);
      if (!result.triggered) return [];
      return result.guidances.map((g) => ({
        role: 'user' as const,
        content: [{ type: 'text' as const, text: g }],
        timestamp: Date.now(),
      }));
    };

    try {
      for (const syn of consumePendingAbortedToolSyntheticMessages(sessionKey)) {
        await appendMessage(sessionKey, syn);
        currentMessages.push(syn);
      }

      const charsPerUnit = resolveContextCharsPerTokenUnit();
      state.pendingMessages = evaluateSteering();

      // ========== Outer loop (follow-ups) ==========
      outerLoop: while (true) {
        resetIterationState(state);

        // ========== Inner loop (tools + steering) ==========
        // C1: Buffer lives across inner-loop iterations — partial-failure leftovers
        // are preserved for the next iteration's flush attempt.
        const turnAssistantBuffer: Message[] = [];
        while (state.hasMoreToolCalls || state.pendingMessages.length > 0) {
          if (state.turns >= maxTurns) {
            const needsToolFollow = lastMessageNeedsToolFollowUpLlm(currentMessages);
            if (needsToolFollow && state.postLimitToolFollowUpsUsed < toolFollowupBypassCap) {
              state.postLimitToolFollowUpsUsed += 1;
            } else {
              stream.push({
                type: 'turn_transition',
                turn: state.turns,
                reason: needsToolFollow ? 'tool_followup_cap_reached' : 'max_turns_reached',
              });
              break outerLoop;
            }
          }
          if (abortSignal.aborted) {
            stream.push({ type: 'turn_transition', turn: state.turns, reason: 'aborted_by_user' });
            break outerLoop;
          }

          state.turns++;
          // Sample inter-turn latency (null on first turn).
          if (state.lastTurnEndMs !== null) {
            const silence = Date.now() - state.lastTurnEndMs;
            state.interTurnSilenceMs.push(silence);
            if (state.interTurnSilenceMs.length > INTER_TURN_SILENCE_WINDOW) {
              state.interTurnSilenceMs.shift(); // rolling window cap
            }
          }
          stream.push({ type: 'turn_start', turn: state.turns });

          if (state.pendingMessages.length > 0) {
            for (const msg of state.pendingMessages) {
              await appendMessage(sessionKey, msg);
              currentMessages.push(msg);
            }
            state.pendingMessages = [];
          }

          const maxOut = maxOutputTokensParam ?? modelDef.maxTokens ?? 8192;
          const effectiveContextTokens = getEffectiveContextWindowTokens(contextTokens, maxOut);

          // B3: Buffer assistant message — flush in finally to ensure persistence
          // even on exceptions. C1: declared outside the try so partial-failure
          // leftovers survive to the next iteration.
          // M2: Track current turn's tool calls for orphan detection in catch.
          let turnToolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
          try {
            // ===== Phase 1: Context preparation =====
            const ctxResult = await prepareTurnContext({
              state,
              currentMessages,
              systemPrompt,
              systemPromptParts,
              effectiveContextTokens,
              charsPerUnit,
              modelDef,
              getToolsForRun: resolveToolsForRun,
              sessionKey,
              runId,
              prepareCompaction,
              compactHooks,
              persistCurrentMessages,
              push: (e) => stream.push(e),
              abortSignal,
              pruningSettings,
              hardCapMessageCount: effectiveCaps.maxMessageCount,
              hardCapTotalTokens: effectiveCaps.maxTotalTokens,
              previousPrefixSnapshot,
              previousToolNames,
              prefixDebugEnabled,
            });

            // Update prefix debug snapshots from context prep result
            previousPrefixSnapshot = ctxResult.updatedSnapshots.previousPrefixSnapshot;
            previousToolNames = ctxResult.updatedSnapshots.previousToolNames;

            if (ctxResult.control === 'break') break;
            if (ctxResult.control === 'retry') {
              state.compactionRetries++;
              state.turns--;
              continue;
            }

            // ===== Phase 2: LLM call =====
            const llmResult = await executeLlmTurn({
              state,
              modelDef,
              piContext: ctxResult.piContext,
              streamFn,
              apiKey,
              temperature,
              reasoning,
              topP,
              abortSignal,
              messagesForModel: ctxResult.messagesForModel,
              toolsForRun: ctxResult.toolsForRun,
              sessionKey,
              runId,
              runStartMs,
              push: (e) => stream.push(e),
              currentMessages,
              prepareCompaction,
              replaceMessages: params.replaceMessages,
              compactHooks,
              recordLlmUsage,
              lastMessageNeedsToolFollowUpLlm,
            });

            if (llmResult.control === 'retry') {
              state.turns--;
              continue;
            }

            // M2: Track tool calls for orphan detection in catch block.
            turnToolCalls = llmResult.toolCalls;

            // ===== Phase 3: Response processing =====
            const responseResult = await processLlmResponse({
              state,
              assistantContent: llmResult.assistantContent,
              messageThinkingChunks: llmResult.messageThinkingChunks,
              toolCalls: llmResult.toolCalls,
              turnTextParts: llmResult.turnTextParts,
              streamStopReason: llmResult.streamStopReason,
              maxTurns,
              maxOutputContinuations: effectiveCaps.maxOutputContinuations,
              abortSignal,
              isQuiet,
              sessionKey,
              currentMessages,
              assistantBuffer: turnAssistantBuffer,
              resolveToolsForRun,
              toolCtx,
              toolHooks: params.toolHooks,
              toolTimeoutMs,
              toolHeartbeatIntervalMs,
              skipHeartbeatToolNames,
              parallelSafeTools,
              loadToolsMetaName,
              toolLoopGuard,
              checkToolApproval: params.checkToolApproval,
              toolAbortSignalFor: params.toolAbortSignalFor,
              enrichToolContext: params.enrichToolContext,
              evaluateSteering,
              appendMessage,
              push: (e) => stream.push(e),
              buildCorrectionMessage,
            });

            // C3: Successful turn — reset consecutive error budget.
            state.consecutiveTurnErrors = 0;

            // C1: Flush any remaining buffered assistant messages (for non-tool paths;
            // tool_execute path already flushed inline before tool execution).
            await flushAssistantBuffer(turnAssistantBuffer);

            if (responseResult.control === 'continue') {
              continue;
            }
            if (responseResult.control === 'break') break;
          } catch (turnErr) {
            // C3: Never swallow user cancellation.
            if (abortSignal.aborted) {
              stream.push({ type: 'turn_transition', turn: state.turns, reason: 'aborted_by_user' });
              throw turnErr;
            }

            // C3: Classify the error — propagate fatal/non-retryable errors immediately.
            const classification = classifyLlmError(turnErr);
            state.consecutiveTurnErrors++;
            if (classification.retryable === false || state.consecutiveTurnErrors > effectiveCaps.maxConsecutiveTurnErrors) {
              log.warn('fatal or exhausted per-turn error, propagating', {
                error: describeError(turnErr),
                retryable: classification.retryable,
                category: classification.category,
                consecutiveTurnErrors: state.consecutiveTurnErrors,
                turn: state.turns,
                sessionKey,
              });
              throw turnErr;
            }

            // Recoverable: inject correction message and retry.
            log.warn('per-turn error, injecting recovery message', {
              error: describeError(turnErr),
              retryable: classification.retryable,
              category: classification.category,
              attempt: state.consecutiveTurnErrors,
              turn: state.turns,
              sessionKey,
            });
            stream.push({
              type: 'turn_end',
              turn: state.turns,
              stopReason: 'error',
              totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
            });
            state.lastTurnEndMs = Date.now();

            // M2: Detect partially-executed tool calls and inject synthetic error results
            // to prevent orphaned tool_use blocks that providers would reject with 400.
            state.hasMoreToolCalls = false;
            const resolvedToolResultIds = new Set<string>();
            for (const m of currentMessages) {
              if (m.role === 'user' && Array.isArray(m.content)) {
                for (const b of m.content) {
                  if (b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result') {
                    resolvedToolResultIds.add((b as { tool_use_id?: string }).tool_use_id ?? '');
                  }
                }
              }
            }
            const pendingToolUses = turnToolCalls.filter(
              (tc) => !resolvedToolResultIds.has(tc.id),
            );
            const correctionMessages: Message[] = [];
            if (pendingToolUses.length > 0) {
              correctionMessages.push({
                role: 'user',
                content: pendingToolUses.map((tc) => ({
                  type: 'tool_result',
                  tool_use_id: tc.id,
                  is_error: true,
                  content: `Tool execution interrupted: ${describeError(turnErr)}`,
                })),
                timestamp: Date.now(),
              });
            }
            correctionMessages.push(buildCorrectionMessage(
              '[System] An internal error occurred processing the last response. Please re-state your last action concisely.',
            ));
            state.pendingMessages = correctionMessages;
            continue;
          } finally {
            // C1 + H3: Shift-based flush — removes each message AFTER successful append
            // so partial failure leaves only unflushed messages (no duplicates on retry).
            // Wrapped in try/catch to avoid masking the primary in-flight exception.
            try {
              await flushAssistantBuffer(turnAssistantBuffer);
            } catch (flushErr) {
              log.error('flush_failed_in_finally', {
                error: describeError(flushErr),
                remainingBuffer: turnAssistantBuffer.length,
                sessionKey,
              });
              // Swallow in finally to avoid masking the primary turnErr that's propagating.
              // The buffer survives for the next iteration's retry attempt.
            }
          }
        }
        // ========== End inner loop ==========

        if (getFollowUpMessages) {
          const followUp = await getFollowUpMessages();
          if (followUp.length > 0) {
            state.pendingMessages = followUp;
            continue;
          }
        }
        break;
      }
      // ========== End outer loop ==========

      const maxOutMetrics = maxOutputTokensParam ?? modelDef.maxTokens ?? 8192;
      const effMetrics = getEffectiveContextWindowTokens(contextTokens, maxOutMetrics);
      stream.push({
        type: 'run_metrics',
        metrics: {
          runId,
          sessionKey,
          totalTurns: state.turns,
          totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
          toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
          toolErrors: state.toolExecutionMetrics.toolErrors,
          microcompactSavedChars: state.overflowState.microcompactTotalSavedChars,
          overflowRecoveries: state.overflowState.overflowRecoveries,
          totalDurationMs: Date.now() - runStartMs,
          firstTokenMs: state.firstTokenMs,
          contextCompactions: state.overflowState.contextCompactions,
          systemPromptChars: systemPrompt.length,
          systemPromptHashShort: systemPromptMeta?.hashShort ?? '',
          effectiveContextTokens: effMetrics,
          llmCompactionFailureStreak: state.overflowState.llmCompactionFailureStreak,
          systemPromptLayerCount: systemPromptMeta?.layerCount ?? 0,
          // Observability for inter-turn latency.
          interTurnSilenceMs: state.interTurnSilenceMs,
          llmConnectionReused: wasConnectionReused(),
          prepNextTurnParallelMs: state.toolExecutionMetrics.prepNextTurnParallelMs,
        },
      });

      stream.push({ type: 'agent_end', runId, messages: currentMessages });
      stream.end({ finalText: state.finalText, turns: state.turns, totalToolCalls: state.toolExecutionMetrics.totalToolCalls, messages: currentMessages });
    } catch (err) {
      stream.push({ type: 'agent_error', runId, error: describeError(err) });
      stream.end({ finalText: state.finalText, turns: state.turns, totalToolCalls: state.toolExecutionMetrics.totalToolCalls, messages: currentMessages });
    }
  })().catch((err) => {
    // C1: safety net — prevents unhandled promise rejection from crashing Node ≥15.
    // Inner try/catch should have already ended the stream; this handles escapes
    // before the inner try (e.g. destructuring errors).
    try {
      process.stderr.write(
        `[agent-loop] fatal unhandled error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } catch { /* noop */ }
    try {
      stream.push({
        type: 'agent_error',
        runId: params.runId ?? 'unknown',
        error: err instanceof Error ? err.message : String(err),
      });
      stream.end({ finalText: '', turns: 0, totalToolCalls: 0, messages: [] });
    } catch { /* stream may already be closed */ }
  });

  return stream;
}
