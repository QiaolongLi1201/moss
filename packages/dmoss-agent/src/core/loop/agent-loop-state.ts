import type { Message } from '../session/session-jsonl.js';
import type { OverflowRecoveryState } from './overflow-recovery.js';
import { createOverflowRecoveryState } from './overflow-recovery.js';
import type { AgentLoopToolExecutionMetrics } from './agent-loop-tool-execution.js';

/**
 * All mutable state threaded through the agent loop.
 *
 * Extracted from `runAgentLoop` so that helpers can accept a single
 * typed object instead of a long parameter list of `let` bindings.
 */
export interface AgentLoopMutableState {
  turns: number;
  compactionRetries: number;
  outputContinuationCount: number;
  planToolNudgeAttempts: number;
  postToolThinkingOnlyRetryAttempts: number;
  postLimitToolFollowUpsUsed: number;
  proactiveCompactionAttempted: boolean;
  promptPruneCompactionAttempted: boolean;
  promptPruneCompactionSucceeded: boolean;
  hasMoreToolCalls: boolean;
  compactionSummary: Message | undefined;
  pendingMessages: Message[];
  finalText: string;
  firstTokenMs: number | null;
  lastTurnEndMs: number | null;
  overflowState: OverflowRecoveryState;
  toolExecutionMetrics: AgentLoopToolExecutionMetrics;
  interTurnSilenceMs: number[];
  consecutiveTurnErrors: number;
}

export function createInitialLoopState(): AgentLoopMutableState {
  return {
    turns: 0,
    compactionRetries: 0,
    outputContinuationCount: 0,
    planToolNudgeAttempts: 0,
    postToolThinkingOnlyRetryAttempts: 0,
    postLimitToolFollowUpsUsed: 0,
    proactiveCompactionAttempted: false,
    promptPruneCompactionAttempted: false,
    promptPruneCompactionSucceeded: false,
    hasMoreToolCalls: true,
    compactionSummary: undefined,
    pendingMessages: [],
    finalText: '',
    firstTokenMs: null,
    lastTurnEndMs: null,
    overflowState: createOverflowRecoveryState(),
    toolExecutionMetrics: { totalToolCalls: 0, toolErrors: 0, consecutiveToolErrors: 0, toolCallsByName: {}, prepNextTurnParallelMs: 0 },
    interTurnSilenceMs: [],
    consecutiveTurnErrors: 0,
  };
}

/** Reset per-outer-loop-iteration fields. */
export function resetIterationState(state: AgentLoopMutableState): void {
  state.proactiveCompactionAttempted = false;
  state.promptPruneCompactionAttempted = false;
  state.promptPruneCompactionSucceeded = false;
  state.compactionRetries = 0;
  state.hasMoreToolCalls = true;
}
