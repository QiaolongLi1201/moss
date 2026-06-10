/**
 * Tracks tool_use IDs whose execution was aborted before a tool_result could be
 * written, so the next LLM call can satisfy provider tool round-trip contracts.
 *
 * Aborted tool outputs include structured metadata
 * (exit_code, duration_seconds) so the model can reason about what happened
 * rather than just seeing a bare "aborted" string.
 */

import type { Message } from '../session/session-jsonl.js';

interface PendingAbortEntry {
  name: string;
  startedAt: number;
}

const PENDING_ABORT_TTL_MS = 5 * 60 * 1000;
const GC_INTERVAL_MS = 60 * 1000;

/**
 * sessionKey -> toolUseId -> entry
 *
 * DESIGN INTENT — deliberate process-wide singleton (cf. keep-alive-dispatcher):
 * entries are keyed by sessionKey, and two DmossAgent instances sharing a
 * sessionKey would already be sharing the same session store — so per-session
 * keying IS the isolation boundary. Entries are TTL-bounded (5 min) and the GC
 * timer is unref'd, so the map cannot grow unbounded or hold the process open.
 * Revisit (move onto the agent instance) only if the host-adapter multi-tenant
 * RFC introduces same-key sessions in one process.
 * Isolation guarded by test/pending-tool-aborts.spec.mjs.
 */
const pendingAbortBySession = new Map<string, Map<string, PendingAbortEntry>>();

let gcTimer: ReturnType<typeof setInterval> | undefined;

function scheduleGc(): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [sessionKey, m] of pendingAbortBySession) {
      for (const [id, entry] of m) {
        if (now - entry.startedAt > PENDING_ABORT_TTL_MS) m.delete(id);
      }
      if (m.size === 0) pendingAbortBySession.delete(sessionKey);
    }
    if (pendingAbortBySession.size === 0 && gcTimer) {
      clearInterval(gcTimer);
      gcTimer = undefined;
    }
  }, GC_INTERVAL_MS);
  if (gcTimer && typeof gcTimer === 'object' && 'unref' in gcTimer) gcTimer.unref();
}

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
  scheduleGc();
}

/**
 * Build synthetic user messages (one combined message with all tool_result blocks)
 * and clear pending state for the session.
 *
 * Output format includes structured metadata so the model can understand the
 * abort context.
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
