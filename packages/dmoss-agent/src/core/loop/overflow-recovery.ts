/**
 * Context-window overflow recovery — three-tier strategy invoked when the
 * provider returns a "context overflow" / "max_tokens too large" style error.
 *
 * Tiers (cheap → expensive → drastic):
 *   1. cheap mitigations: invalidateStaleReadToolResults + microcompact
 *   2. LLM-summarize: prepareCompaction(forceCompaction=true)
 *   3. emergency truncation: keep last ~6 / 3 / 1 messages
 *
 * Tier 2 is fused (skipped) once `llmCompactionFailureStreak >= 2`.
 *
 * Extracted from runAgentLoop to reduce inline branch density. Behavior is
 * unchanged; the original turns-- / continue / throw control flow is folded
 * into a `RecoveryOutcome` discriminated union.
 */

import type { Message } from '../session/session-jsonl.js';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import {
  buildCompactionCheckpointOutline,
  type CompactHookRegistry,
} from './compact-hooks.js';
import { invalidateStaleReadToolResults } from '../../context/stale-read-invalidate.js';
import { microcompact } from '../../context/microcompact.js';
import { estimateMessagesChars, estimateMessagesTokens } from '../../context/tokens.js';
import { describeError } from '../../provider/errors.js';
import { getRootLogger } from '../../logger.js';

const log = getRootLogger().child('agent:overflow');

export type RecoveryState =
  | {
      kind: 'idle';
      level: 0;
      llmCompactionFailureStreak: number;
      llmSummarize: 'available' | 'fused';
    }
  | {
      kind: 'cheap';
      level: 1;
      llmCompactionFailureStreak: number;
      llmSummarize: 'available' | 'fused';
    }
  | {
      kind: 'llm_summarize';
      level: 2;
      llmCompactionFailureStreak: number;
      llmSummarize: 'available' | 'fused';
    }
  | {
      kind: 'truncate';
      level: 3;
      llmCompactionFailureStreak: number;
      llmSummarize: 'available';
    }
  | {
      kind: 'fused';
      level: 3;
      llmCompactionFailureStreak: number;
      llmSummarize: 'fused';
    };

export interface OverflowRecoveryState {
  /** Source of truth for overflow escalation. */
  recovery: RecoveryState;
  /** Compatibility metric: 0 = idle; 1/2/3 = current recovery tier. */
  readonly level: RecoveryState['level'];
  /** Compatibility metric mirrored from `recovery`. */
  readonly llmCompactionFailureStreak: number;
  /** Compatibility metric: true once LLM summarize has fused for this run. */
  readonly skipLlmCompactionOnOverflow: boolean;
  /** Telemetry: total recoveries triggered in this run. */
  overflowRecoveries: number;
  /** Telemetry: total LLM compactions completed in this run. */
  contextCompactions: number;
  /** Telemetry: total chars freed by cheap mitigations across the run. */
  microcompactTotalSavedChars: number;
  /**
   * M5: Tracks consecutive overflow retries caused by compaction itself
   * (the summary message is too large). Capped at MAX_COMPACTION_OVERFLOW_RETRIES
   * to prevent infinite compact→overflow→compact loops.
   */
  compactionOverflowRetries: number;
}

/** M5: Max retries when compaction output itself causes overflow. */
const MAX_COMPACTION_OVERFLOW_RETRIES = 2;

export function createOverflowRecoveryState(): OverflowRecoveryState {
  return {
    recovery: createRecoveryState('idle'),
    get level() {
      return this.recovery.level;
    },
    get llmCompactionFailureStreak() {
      return this.recovery.llmCompactionFailureStreak;
    },
    get skipLlmCompactionOnOverflow() {
      return this.recovery.llmSummarize === 'fused';
    },
    overflowRecoveries: 0,
    contextCompactions: 0,
    microcompactTotalSavedChars: 0,
    compactionOverflowRetries: 0,
  };
}

function createRecoveryState(
  kind: RecoveryState['kind'],
  previous?: RecoveryState,
): RecoveryState {
  const llmCompactionFailureStreak = previous?.llmCompactionFailureStreak ?? 0;
  const llmSummarize = previous?.llmSummarize ?? 'available';

  switch (kind) {
    case 'idle':
      return {
        kind,
        level: 0,
        llmCompactionFailureStreak,
        llmSummarize,
      };
    case 'cheap':
      return {
        kind,
        level: 1,
        llmCompactionFailureStreak,
        llmSummarize,
      };
    case 'llm_summarize':
      return {
        kind,
        level: 2,
        llmCompactionFailureStreak,
        llmSummarize,
      };
    case 'truncate':
      return {
        kind,
        level: 3,
        llmCompactionFailureStreak,
        llmSummarize: 'available',
      };
    case 'fused':
      return {
        kind,
        level: 3,
        llmCompactionFailureStreak,
        llmSummarize: 'fused',
      };
  }
}

function advanceRecoveryState(recovery: RecoveryState): RecoveryState | null {
  switch (recovery.kind) {
    case 'idle':
      return createRecoveryState('cheap', recovery);
    case 'cheap':
      return createRecoveryState('llm_summarize', recovery);
    case 'llm_summarize':
      return createRecoveryState('truncate', recovery);
    case 'truncate':
    case 'fused':
      return null;
  }
}

function escalateToLlmSummarize(state: OverflowRecoveryState): void {
  state.recovery = createRecoveryState('llm_summarize', state.recovery);
}

function markLlmCompactionSucceeded(state: OverflowRecoveryState): void {
  state.recovery = {
    kind: 'idle',
    level: 0,
    llmCompactionFailureStreak: 0,
    llmSummarize: 'available',
  };
}

function markLlmCompactionFailed(state: OverflowRecoveryState): number {
  const failureStreak = state.recovery.llmCompactionFailureStreak + 1;
  state.recovery =
    failureStreak >= 2
      ? {
          kind: 'fused',
          level: 3,
          llmCompactionFailureStreak: failureStreak,
          llmSummarize: 'fused',
        }
      : {
          kind: 'truncate',
          level: 3,
          llmCompactionFailureStreak: failureStreak,
          llmSummarize: 'available',
        };
  return failureStreak;
}

function skipFusedLlmSummarize(state: OverflowRecoveryState): void {
  state.recovery = createRecoveryState('fused', state.recovery);
}

export interface OverflowRecoveryParams {
  state: OverflowRecoveryState;
  errorText: string;
  currentMessages: Message[];
  sessionKey: string;
  runId: string;
  prepareCompaction: (params: {
    messages: Message[];
    sessionKey: string;
    runId: string;
    forceCompaction?: boolean;
    abortSignal?: AbortSignal;
  }) => Promise<{
    summary?: string;
    summaryMessage?: Message;
    messages?: Message[];
    droppedMessages?: number;
    checkpointOutline?: string[];
  }>;
  replaceMessages?: (sessionKey: string, messages: Message[]) => Promise<void>;
  compactHooks?: CompactHookRegistry;
  push: (event: MiniAgentEvent) => void;
  abortSignal?: AbortSignal;
}

/**
 * Discriminated outcome consumed by the caller (runAgentLoop) to decide
 * whether to retry the same turn (`retry-same-turn`) or rethrow.
 *
 * - `retry-same-turn`: caller should `turns--; continue;`
 * - `rethrow`: caller should rethrow the original LLM error
 */
export type RecoveryOutcome =
  | {
      kind: 'retry-same-turn';
      replacedSummaryMessage?: Message;
    }
  | { kind: 'rethrow' };

/**
 * Find a safe truncation point that does not split tool_use/tool_result pairs.
 *
 * Starting from the desired cut point (messages.length - targetKeep), scans
 * forward to ensure we don't drop the tool_result that matches a tool_use in
 * the kept suffix. If the cut point falls between a tool_use (assistant) and
 * its tool_result (user), the cut is moved forward to include the tool_result.
 *
 * Returns the index to slice from (i.e., messages.slice(returnValue)).
 */
export function findSafeTruncationPoint(messages: Message[], targetKeep: number): number {
  if (messages.length === 0 || targetKeep >= messages.length) return 0;
  if (targetKeep <= 0) return messages.length;

  let cutPoint = messages.length - targetKeep;

  // Collect all tool_use IDs in the kept suffix (messages after cutPoint)
  const keptToolUseIds = new Set<string>();
  for (let i = cutPoint; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.id) {
          keptToolUseIds.add(block.id);
        }
      }
    }
  }

  // Scan the dropped prefix for matching tool_results.
  // If a tool_result in the prefix matches a tool_use in the suffix,
  // we must include it — move cutPoint backward to include that user message.
  // We iterate from the cut point backward to find the earliest tool_result
  // that needs to be preserved.
  let adjustedCut = cutPoint;
  for (let i = cutPoint - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.tool_use_id && keptToolUseIds.has(block.tool_use_id)) {
          // This tool_result must be kept — move cut point to before this message
          adjustedCut = Math.min(adjustedCut, i);
        }
      }
    }
  }

  // Reverse scan: check if any tool_result in the suffix has its
  // matching tool_use in the dropped prefix. If so, move the cut
  // backward to include that tool_use.
  const keptToolResultIds = new Set<string>();
  for (let i = adjustedCut; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          keptToolResultIds.add(block.tool_use_id);
        }
      }
    }
  }

  if (keptToolResultIds.size > 0) {
    for (let i = adjustedCut - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        let hasMatchingToolUse = false;
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.id && keptToolResultIds.has(block.id)) {
            hasMatchingToolUse = true;
            break;
          }
        }
        if (hasMatchingToolUse) {
          adjustedCut = Math.min(adjustedCut, i);
        }
      }
    }
  }

  // Also: if the adjusted cut point now has an assistant message with tool_use
  // at the boundary, check that its tool_result is also included.
  // This handles cascading: moving the cut may expose new dangling pairs.
  // One pass is sufficient for typical conversation structures.

  return adjustedCut;
}

/**
 * Apply one round of overflow recovery escalation. Mutates `state.recovery` and
 * `currentMessages` in place. Emits MiniAgentEvents via `push`.
 *
 * Caller invariant: only invoke this when the LLM error is a true context
 * overflow AND the conversation does NOT end with a tool_result message
 * (recovery would otherwise corrupt tool_use/tool_result roundtrip).
 */
export async function runOverflowRecovery(
  params: OverflowRecoveryParams,
): Promise<RecoveryOutcome> {
  const {
    state,
    errorText,
    currentMessages,
    sessionKey,
    runId,
    prepareCompaction,
    replaceMessages,
    compactHooks,
    push,
    abortSignal,
  } = params;

  const persistMessages = async (messages: Message[]): Promise<void> => {
    if (replaceMessages) {
      await replaceMessages(sessionKey, messages);
    }
  };

  const nextRecovery = advanceRecoveryState(state.recovery);
  if (!nextRecovery) {
    return { kind: 'rethrow' };
  }

  state.recovery = nextRecovery;
  state.overflowRecoveries++;
  push({
    type: 'context_overflow_compact',
    error: errorText,
    recoveryLevel: state.level,
  });

  // ── Tier 1: cheap mitigations ────────────────────────────────
  if (state.recovery.kind === 'cheap') {
    let recovered = false;
    let savedChars = 0;
    let savedTokens = 0;
    const actions: Extract<MiniAgentEvent, { type: 'context_action' }>['actions'] = [];

    const staleOv = invalidateStaleReadToolResults(currentMessages);
    if (staleOv.savedChars > 0) {
      await persistMessages(staleOv.messages);
      currentMessages.splice(0, currentMessages.length, ...staleOv.messages);
      state.microcompactTotalSavedChars += staleOv.savedChars;
      savedChars += staleOv.savedChars;
      savedTokens += staleOv.savedTokens;
      actions.push({
        kind: 'invalidate_stale_reads',
        reason: 'overflow_recovery',
        count: staleOv.invalidatedCount,
        savedChars: staleOv.savedChars,
        savedTokens: staleOv.savedTokens,
      });
      recovered = true;
    }

    const mcResult = microcompact(currentMessages, {
      keepRecentResults: 2,
      minContentLength: 50,
    });
    if (mcResult.compressedCount > 0) {
      await persistMessages(mcResult.messages);
      currentMessages.splice(0, currentMessages.length, ...mcResult.messages);
      state.microcompactTotalSavedChars += mcResult.savedChars;
      savedChars += mcResult.savedChars;
      savedTokens += mcResult.savedTokens;
      actions.push({
        kind: 'microcompact',
        reason: 'overflow_recovery',
        count: mcResult.compressedCount,
        savedChars: mcResult.savedChars,
        savedTokens: mcResult.savedTokens,
      });
      recovered = true;
    }

    if (recovered) {
      push({
        type: 'context_action',
        reason: 'overflow_recovery',
        actions,
        savedChars,
        savedTokens,
      });
      return { kind: 'retry-same-turn' };
    }
    escalateToLlmSummarize(state);
  }

  // ── Tier 2: LLM-based summarize (fusable) ───────────────────
  // M5: Skip LLM compaction if it has repeatedly caused overflow itself.
  if (state.recovery.kind === 'llm_summarize') {
    if (state.skipLlmCompactionOnOverflow || state.compactionOverflowRetries >= MAX_COMPACTION_OVERFLOW_RETRIES) {
      if (state.compactionOverflowRetries >= MAX_COMPACTION_OVERFLOW_RETRIES) {
        log.warn('skipping LLM compaction: compaction overflow retry cap reached', {
          compactionOverflowRetries: state.compactionOverflowRetries,
        });
      }
      skipFusedLlmSummarize(state);
    } else {
      state.compactionOverflowRetries++;
      try {
        await compactHooks?.runPreHooks({
          sessionKey,
          runId,
          messages: currentMessages,
          reason: 'overflow',
        });
        const overflowPrep = await prepareCompaction({
          messages: currentMessages,
          sessionKey,
          runId,
          forceCompaction: true,
          abortSignal,
        });
        const checkpointOutline =
          overflowPrep.checkpointOutline ?? buildCompactionCheckpointOutline(overflowPrep.summary);
        const droppedMessages = Math.max(0, Number(overflowPrep.droppedMessages ?? 0));
        await compactHooks?.runPostHooks({
          sessionKey,
          runId,
          summaryChars: overflowPrep.summary?.length ?? 0,
          droppedMessages,
          reason: 'overflow',
          success: Boolean(overflowPrep.summary && overflowPrep.summaryMessage),
          ...(checkpointOutline ? { checkpointOutline } : {}),
        });
        if (overflowPrep.summary && overflowPrep.summaryMessage) {
          // If aborted after prepareCompaction returned, do NOT mutate currentMessages.
          if (abortSignal?.aborted) {
            return { kind: 'rethrow' };
          }
          if (overflowPrep.messages?.length) {
            await persistMessages(overflowPrep.messages);
            currentMessages.splice(0, currentMessages.length, ...overflowPrep.messages);
          }
          state.contextCompactions++;
          markLlmCompactionSucceeded(state);
          push({
            type: 'compaction',
            summaryChars: overflowPrep.summary.length,
            droppedMessages,
            ...(checkpointOutline ? { checkpointOutline } : {}),
          });
          return overflowPrep.messages?.length
            ? { kind: 'retry-same-turn' }
            : { kind: 'retry-same-turn', replacedSummaryMessage: overflowPrep.summaryMessage };
        }
      } catch (compactErr) {
        const failureStreak = markLlmCompactionFailed(state);
        log.warn('prepareCompaction failed during overflow recovery', {
          error: describeError(compactErr),
          failureStreak,
        });
        if (state.skipLlmCompactionOnOverflow) {
          push({
            type: 'context_action',
            reason: 'overflow_recovery',
            actions: [
              {
                kind: 'compaction_fuse',
                reason: 'overflow_recovery',
                count: failureStreak,
                savedChars: 0,
                savedTokens: 0,
              },
            ],
            savedChars: 0,
            savedTokens: 0,
          });
        }
      }
    }
  }

  // ── Tier 3: emergency truncation ─────────────────────────────
  if (state.recovery.kind === 'truncate' || state.recovery.kind === 'fused') {
    let keepCount = Math.min(6, currentMessages.length);
    let dropped = currentMessages.length - keepCount;
    if (dropped === 0 && currentMessages.length > 3) {
      keepCount = Math.min(3, currentMessages.length);
      dropped = currentMessages.length - keepCount;
    }
    if (dropped === 0 && currentMessages.length > 1) {
      keepCount = 1;
      dropped = currentMessages.length - keepCount;
    }
    if (dropped > 0) {
      const safeCut = findSafeTruncationPoint(currentMessages, keepCount);
      const droppedMessages = currentMessages.slice(0, safeCut);
      const savedChars = estimateMessagesChars(droppedMessages);
      const savedTokens = estimateMessagesTokens(droppedMessages);
      const kept = currentMessages.slice(safeCut);
      dropped = safeCut;
      await persistMessages(kept);
      currentMessages.splice(0, currentMessages.length, ...kept);
      push({
        type: 'context_action',
        reason: 'overflow_recovery',
        actions: [
          {
            kind: 'emergency_truncate',
            reason: 'overflow_recovery',
            count: dropped,
            savedChars,
            savedTokens,
          },
        ],
        savedChars,
        savedTokens,
      });
      return { kind: 'retry-same-turn' };
    }
  }

  return { kind: 'rethrow' };
}
