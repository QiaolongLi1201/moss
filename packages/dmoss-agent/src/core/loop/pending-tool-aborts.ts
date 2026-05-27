/**
 * Tracks tool_use IDs whose execution was aborted before a tool_result could be
 * written, so the next LLM call can satisfy provider tool round-trip contracts.
 *
 * Aligned with Codex: aborted tool outputs include structured metadata
 * (exit_code, duration_seconds) so the model can reason about what happened
 * rather than just seeing a bare "aborted" string.
 */

import type { Message } from '../session/session-jsonl.js';

interface PendingAbortEntry {
  name: string;
  startedAt: number;
}

/** sessionKey -> toolUseId -> entry */
const pendingAbortBySession = new Map<string, Map<string, PendingAbortEntry>>();

export function notePendingAbortedToolCalls(
  sessionKey: string,
  calls: readonly { id: string; name: string }[],
): void {
  if (calls.length === 0) return;
  let m = pendingAbortBySession.get(sessionKey);
  if (!m) {
    m = new Map();
    pendingAbortBySession.set(sessionKey, m);
  }
  const now = Date.now();
  for (const c of calls) {
    if (c.id) m.set(c.id, { name: c.name, startedAt: now });
  }
}

/**
 * Build synthetic user messages (one combined message with all tool_result blocks)
 * and clear pending state for the session.
 *
 * Output format includes structured metadata (aligned with Codex's pattern)
 * so the model can understand the abort context.
 */
export function consumePendingAbortedToolSyntheticMessages(
  sessionKey: string,
): Message[] {
  const m = pendingAbortBySession.get(sessionKey);
  if (!m || m.size === 0) return [];
  const entries = [...m.entries()];
  pendingAbortBySession.delete(sessionKey);

  const now = Date.now();
  const content = entries.map(([tool_use_id, entry]) => ({
    type: 'tool_result' as const,
    tool_use_id,
    name: entry.name,
    content: JSON.stringify({
      output: 'aborted',
      metadata: {
        exit_code: 1,
        duration_seconds: Math.round((now - entry.startedAt) / 1000),
        reason: 'user_cancelled',
      },
    }),
    is_error: true,
  }));

  return [
    {
      role: 'user',
      content,
      timestamp: now,
    },
  ];
}
