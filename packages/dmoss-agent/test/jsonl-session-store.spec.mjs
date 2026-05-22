#!/usr/bin/env node
/**
 * JsonlSessionStore append-only regression.
 *
 * Run:
 *   npx tsx packages/dmoss-agent/test/jsonl-session-store.spec.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { JsonlSessionStore } from '../src/core/jsonl-session-store.ts';

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

const diskName = `${sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`;
const raw = await fs.readFile(path.join(dir, diskName), 'utf-8');
assert.match(raw, /"type":"message"/, 'original message entries must remain append-only');
assert.match(raw, /"type":"state_replace"/, 'replaceMessages should append state_replace');
assert.match(raw, /old user detail must stay on disk/, 'old user message must not be overwritten');
assert.match(raw, /old assistant detail must stay on disk/, 'old assistant message must not be overwritten');

console.log('  [PASS] JsonlSessionStore replaceMessages is append-only and replay-safe');
