#!/usr/bin/env node
/**
 * Opt-in session-count retention for JsonlSessionStore.
 *
 * Before: only a per-file 50MB cap existed; session files accumulated unbounded
 * in `.moss/sessions`. JsonlSessionStore now accepts `maxSessions` — a positive
 * cap prunes the oldest sessions (by updatedAt) when a NEW session is created,
 * never touching the session just written. The default (omitted / <= 0) keeps
 * the historical unbounded behavior, because retention is a host policy and
 * moss must not delete user history unless the host opts in.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/jsonl-session-store-max-sessions.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { JsonlSessionStore } from '../dist/core/session/jsonl-session-store.js';

const countJsonl = async (dir) =>
  (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')).length;

// 1) Default (no maxSessions): unbounded — every session is kept.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-maxsess-default-'));
  const store = new JsonlSessionStore({ dir });
  for (let i = 0; i < 5; i++) {
    await store.appendMessage(`session-${i}`, { role: 'user', content: `m${i}` });
  }
  assert.equal(await countJsonl(dir), 5, 'default store must keep all sessions (unbounded)');
  console.log('  [PASS] default JsonlSessionStore keeps sessions unbounded');
}

// 2) maxSessions cap: creating new sessions prunes the oldest down to the cap.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-maxsess-cap-'));
  const store = new JsonlSessionStore({ dir, maxSessions: 3 });

  // Create 5 sessions with strictly increasing mtimes so "oldest" is unambiguous.
  for (let i = 0; i < 5; i++) {
    await store.appendMessage(`session-${i}`, { role: 'user', content: `m${i}` });
    const fp = path.join(dir, `session-${i}.jsonl`);
    const t = new Date(Date.now() + i * 1000);
    await fs.utimes(fp, t, t);
  }
  // The cap is enforced lazily on the NEXT new-session create, so add one more
  // after the mtimes are deterministic, then assert the cap holds.
  await store.appendMessage('session-5', { role: 'user', content: 'm5' });
  const fp5 = path.join(dir, 'session-5.jsonl');
  const t5 = new Date(Date.now() + 10_000);
  await fs.utimes(fp5, t5, t5);
  await store.appendMessage('session-6', { role: 'user', content: 'm6' });

  const remaining = new Set((await store.listSessions()).map((s) => s.sessionKey));
  assert.equal(remaining.size, 3, `cap must hold at 3, got ${remaining.size}: ${[...remaining]}`);
  assert.ok(remaining.has('session-6'), 'the just-written session must never be pruned');
  assert.ok(!remaining.has('session-0'), 'the oldest session must be pruned first');
  assert.ok(!remaining.has('session-1'), 'the next-oldest session must be pruned');
  console.log('  [PASS] maxSessions prunes oldest sessions and never the active one');
}

// 3) Appending to an EXISTING session never prunes (count does not grow).
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-maxsess-reuse-'));
  const store = new JsonlSessionStore({ dir, maxSessions: 2 });
  await store.appendMessage('a', { role: 'user', content: '1' });
  await store.appendMessage('b', { role: 'user', content: '1' });
  // Re-append to existing sessions many times: must not delete the other one.
  for (let i = 0; i < 5; i++) {
    await store.appendMessage('a', { role: 'user', content: `more-${i}` });
    await store.appendMessage('b', { role: 'user', content: `more-${i}` });
  }
  const keys = new Set((await store.listSessions()).map((s) => s.sessionKey));
  assert.deepEqual(keys, new Set(['a', 'b']), 'appending to existing sessions must not prune');
  console.log('  [PASS] appending to existing sessions does not trigger pruning');
}

console.log('jsonl-session-store-max-sessions: all checks passed');
