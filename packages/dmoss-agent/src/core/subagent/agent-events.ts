/**
 * Agent event types — discriminated union for all events emitted during agent execution.
 *
 * Event flow (three-layer architecture):
 *   Layer 1: agent-loop → stream.push(AgentEvent) → EventStream queue
 *   Layer 2: Agent.run() → for await (event of stream) → consume events
 *   Layer 3: Agent.emit(event) → listeners → external subscribers (CLI, UI)
 */

import { EventStream } from '../../provider/pi-ai-types.js';
import type { Message } from '../session/session-jsonl.js';
import type {
  ContextBudgetActionKind,
  ContextBudgetActionReason,
} from '../loop/context-budget-planner.js';
import type { LlmErrorCategory } from '../llm/llm-error-classifier.js';
import type { ToolContentBlock } from '../tools/tool-types.js';

export const MINI_AGENT_EVENT_VERSION = 1 as const;

/**
 * Agent event discriminated union.
 *
 * Core lifecycle: agent_end / agent_error
 * Per-turn: turn_start → turn_end
 * Streaming: message_start → message_delta* → message_end
 * Tool execution: tool_execution_start → tool_execution_end / tool_skipped
 * Observability: compaction, retry, context management events
 */
type MiniAgentEventPayload =
  | { type: 'agent_end'; runId: string; messages: Message[] }
  | { type: 'agent_error'; runId: string; error: string }

  | { type: 'turn_start'; turn: number }
  | { type: 'turn_end'; turn: number; totalToolCalls?: number }

  | { type: 'message_start'; message: Message }
  | { type: 'message_delta'; delta: string }
  | { type: 'message_end'; message: Message; text: string }

  | { type: 'thinking_delta'; delta: string }

  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: string; isError: boolean; content?: string; aborted?: { by: 'user' | 'timeout' }; structuredContent?: ToolContentBlock[] }
  | { type: 'tool_execution_progress'; toolCallId: string; toolName: string; elapsed_sec: number }
  | { type: 'tool_skipped'; toolCallId: string; toolName: string }

  | { type: 'tool_approval_request'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_approval_resolved'; toolCallId: string; toolName: string; decision: 'allow-once' | 'allow-always' | 'deny' }

  | { type: 'compaction'; summaryChars: number; droppedMessages: number; checkpointOutline?: string[] }
  | {
      type: 'working_context_checkpoint';
      status: string;
      reason: string;
      goal: string;
      nextAction: string;
    }
  | { type: 'context_overflow_compact'; error: string; recoveryLevel?: number }
  | { type: 'retry'; attempt: number; delay: number; error: string; category?: LlmErrorCategory }
  | { type: 'turn_transition'; turn: number; reason: string }

  | { type: 'output_continuation'; attempt: number; maxAttempts: number }
  | {
      type: 'context_action';
      reason: ContextBudgetActionReason;
      actions: ContextActionSummary[];
      savedChars: number;
      savedTokens: number;
    }
  | { type: 'run_metrics'; metrics: RunMetrics };

export type MiniAgentEvent = MiniAgentEventPayload & {
  /**
   * Schema version for MiniAgentEvent payloads emitted by this package. The
   * stream fills this in centrally so producers can stay focused on event data.
   */
  version?: typeof MINI_AGENT_EVENT_VERSION;
};

export interface ContextActionSummary {
  kind: ContextBudgetActionKind;
  reason: ContextBudgetActionReason;
  count: number;
  savedChars: number;
  savedTokens: number;
}

export interface RunMetrics {
  runId: string;
  sessionKey: string;
  totalTurns: number;
  totalToolCalls: number;
  toolCallsByName: Record<string, number>;
  toolErrors: number;
  microcompactSavedChars: number;
  overflowRecoveries: number;
  totalDurationMs: number;
  firstTokenMs: number | null;
  contextCompactions: number;
  systemPromptChars: number;
  systemPromptHashShort: string;
  effectiveContextTokens: number;
  llmCompactionFailureStreak: number;
  systemPromptLayerCount: number;
  /** Inter-turn silence observability (additive, optional). */
  interTurnSilenceMs?: number[];
  llmConnectionReused?: boolean;
  prepNextTurnParallelMs?: number;
}

export interface MiniAgentResult {
  finalText: string;
  turns: number;
  totalToolCalls: number;
  messages: Message[];
}

export function createMiniAgentStream(): EventStream<MiniAgentEvent, MiniAgentResult> {
  const stream = new EventStream<MiniAgentEvent, MiniAgentResult>(
    () => false,
    () => ({ finalText: '', turns: 0, totalToolCalls: 0, messages: [] }),
  );
  const push = stream.push.bind(stream) as (event: MiniAgentEvent) => void;
  (stream as unknown as { push: (event: MiniAgentEvent) => void }).push = (event) => {
    push({ ...event, version: event.version ?? MINI_AGENT_EVENT_VERSION });
  };
  return stream;
}
