#!/usr/bin/env node
/**
 * JsonlSessionStore append-only regression.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/jsonl-session-store.spec.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { JsonlSessionStore } from '../dist/core/session/jsonl-session-store.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-jsonl-session-'));
const store = new JsonlSessionStore({ dir });
const sessionKey = 'local:studio:test-session';

const oldUser = { role: 'user', content: 'old user detail must stay on disk' };
const oldAssistant = { role: 'assistant', content: 'old assistant detail must stay on disk' };
const summary = {
  role: 'user',
  content: 'The conversation history before this point was compacted into a summary.',
};
const tail = { role: 'assistant', content: 'recent tail kept for active context' };
const after = { role: 'user', content: 'new message after compaction' };

await store.appendMessage(sessionKey, oldUser);
await store.appendMessage(sessionKey, oldAssistant);
await store.replaceMessages(sessionKey, [summary, tail]);
await store.appendMessage(sessionKey, after);

const active = await store.loadMessages(sessionKey);
assert.deepEqual(
  active.map((m) => m.content),
  [summary.content, tail.content, after.content],
  'loadMessages should replay latest active state plus later appended messages',
);

const files = await fs.readdir(dir);
assert.equal(files.filter((file) => file.endsWith('.jsonl')).length, 1);
const raw = await fs.readFile(path.join(dir, files.find((file) => file.endsWith('.jsonl'))), 'utf-8');
assert.match(raw, /"type":"message"/, 'original message entries must remain append-only');
assert.match(raw, /"type":"state_replace"/, 'replaceMessages should append state_replace');
assert.match(raw, /old user detail must stay on disk/, 'old user message must not be overwritten');
assert.match(raw, /old assistant detail must stay on disk/, 'old assistant message must not be overwritten');

const [meta] = await store.listSessions();
assert.equal(
  meta.messageCount,
  active.length,
  'listSessions messageCount should reflect active replayed messages, not physical audit rows',
);

console.log('  [PASS] JsonlSessionStore replaceMessages is append-only and replay-safe');

{
  const collisionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-jsonl-session-collision-'));
  const collisionStore = new JsonlSessionStore({ dir: collisionDir });
  const colonKey = 'local:studio:test-session';
  const underscoreKey = 'local_studio_test-session';

  await collisionStore.appendMessage(colonKey, { role: 'user', content: 'colon session only' });
  await collisionStore.appendMessage(underscoreKey, { role: 'user', content: 'underscore session only' });

  assert.deepEqual(
    (await collisionStore.loadMessages(colonKey)).map((m) => m.content),
    ['colon session only'],
    'session keys that differ only by legacy-safe chars must not share one JSONL file',
  );
  assert.deepEqual(
    (await collisionStore.loadMessages(underscoreKey)).map((m) => m.content),
    ['underscore session only'],
    'underscore session must remain isolated from colon session',
  );
  assert.deepEqual(
    new Set((await collisionStore.listSessions()).map((s) => s.sessionKey)),
    new Set([colonKey, underscoreKey]),
    'listSessions must preserve original session keys for new encoded files',
  );

  console.log('  [PASS] JsonlSessionStore stores colliding legacy-safe keys independently');
}

{
  const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-jsonl-session-legacy-'));
  const legacyStore = new JsonlSessionStore({ dir: legacyDir });
  const legacyKey = 'local_studio_legacy-session';
  const legacyFile = path.join(legacyDir, `${legacyKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
  await fs.writeFile(
    legacyFile,
    `${JSON.stringify({ type: 'message', message: { role: 'user', content: 'legacy message' } })}\n`,
    'utf-8',
  );

  assert.deepEqual(
    (await legacyStore.loadMessages(legacyKey)).map((m) => m.content),
    ['legacy message'],
    'legacy lossy filenames remain readable by their exact listed key',
  );

  const ambiguousKey = 'local:studio:legacy-session';
  assert.deepEqual(
    await legacyStore.loadMessages(ambiguousKey),
    [],
    'ambiguous legacy filenames must not be silently attributed to a different original key',
  );

  console.log('  [PASS] JsonlSessionStore reads exact legacy filenames without ambiguous attribution');
}

{
  const malformedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-jsonl-session-malformed-'));
  const malformedStore = new JsonlSessionStore({ dir: malformedDir });
  await fs.writeFile(
    path.join(malformedDir, 'bad%ZZ.jsonl'),
    `${JSON.stringify({ type: 'message', message: { role: 'user', content: 'malformed filename' } })}\n`,
    'utf-8',
  );

  assert.ok(
    (await malformedStore.listSessions()).some((session) => session.sessionKey === 'bad%ZZ'),
    'malformed percent-encoded filenames should not break session listing',
  );

  console.log('  [PASS] JsonlSessionStore tolerates malformed percent-encoded filenames');
}

{
  const traversalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-jsonl-session-traversal-'));
  const traversalStore = new JsonlSessionStore({ dir: traversalDir });
  const traversalKey = '../../../etc/passwd';

  await traversalStore.appendMessage(traversalKey, {
    role: 'user',
    content: 'must stay inside the configured session directory',
  });

  assert.deepEqual(
    (await traversalStore.loadMessages(traversalKey)).map((m) => m.content),
    ['must stay inside the configured session directory'],
  );
  assert.ok(
    (await traversalStore.listSessions()).some((session) => session.sessionKey === traversalKey),
    'listSessions should round-trip path-like keys without fabricating a filesystem path',
  );

  const root = await fs.realpath(traversalDir);
  const files = await fs.readdir(traversalDir);
  assert.equal(files.length, 1);
  for (const file of files) {
    const resolved = await fs.realpath(path.join(traversalDir, file));
    assert.equal(
      resolved.startsWith(root + path.sep),
      true,
      `session file escaped session directory: ${resolved}`,
    );
  }

  console.log('  [PASS] JsonlSessionStore path-like session keys stay inside the session directory');
}
