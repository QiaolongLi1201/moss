export type LLMContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id?: string; content?: string; is_error?: boolean }
  | Record<string, unknown>;

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | LLMContentBlock[];
}

/**
 * Matches the synthetic user message the agent runtime injects after context
 * compaction (see COMPACTION_SUMMARY_PREFIX in @rdk-moss/agent
 * session-jsonl-types). Skill learning must not mistake it for the user's
 * actual request — doing so produced skills named
 * "the-conversation-history-before-…". Kept as a string match because this
 * package must not depend on the agent package.
 */
export function isCompactionSummaryText(text: string): boolean {
  return text.trimStart().startsWith('The conversation history before this point was compacted');
}

/**
 * True for user-role messages synthesized by the runtime rather than typed by
 * the user: compaction summaries, loop-guard steering, and system correction
 * injections. Skill learning must never treat these as the user's request —
 * they produced skills named "the-conversation-history-before-…" and
 * "[Steering] Extended tool loop detected…".
 */
export function isSyntheticUserText(text: string): boolean {
  const t = text.trimStart();
  return (
    isCompactionSummaryText(t) ||
    t.startsWith('[Steering]') ||
    t.startsWith('[System]') ||
    // Runtime-injected context blocks (working-context checkpoints, memory
    // digests, …) arrive as user-role messages wrapped in <dmoss_*> tags.
    t.startsWith('<dmoss_')
  );
}
