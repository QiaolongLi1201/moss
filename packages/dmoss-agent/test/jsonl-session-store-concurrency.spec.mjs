#!/usr/bin/env node
/**
 * JsonlSessionStore durability/concurrency regressions.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/jsonl-session-store-concurrency.spec.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { JsonlSessionStore } from '../dist/core/session/jsonl-session-store.js';

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-jsonl-concurrency-'));
  return { dir, store: new JsonlSessionStore({ dir }) };
}

function sessionFile(dir, sessionKey) {
  return path.join(dir, `${encodeURIComponent(sessionKey)}.jsonl`);
}

async function captureWarnings(fn) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => {
    warnings.push(args.join(' '));
  };
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.warn = originalWarn;
  }
}

{
  const sourceUrl = new URL('../dist/core/session/jsonl-session-store.js', import.meta.url);
  const source = await fs.readFile(sourceUrl, 'utf-8');
  assert.match(source, /static\s+writeChains/, 'JsonlSessionStore must share write chains across instances');
  assert.match(source, /\.sync\(/, 'JsonlSessionStore must fsync successful writes before resolving');
  assert.match(source, /\.open\([^)]*['"]a['"]/, 'JsonlSessionStore must append through an explicit file handle');
  console.log('  [PASS] JsonlSessionStore implementation uses shared write chains and fsync');
}

{
  const { dir, store } = await makeStore();
  const sessionKey = 'same-session';
  const expected = new Set();
  await Promise.all(
    Array.from({ length: 50 }, (_, i) => {
      const content = `message-${String(i).padStart(2, '0')}-${'x'.repeat(8192)}`;
      expected.add(content);
      return store.appendMessage(sessionKey, { role: 'user', content });
    }),
  );

  const { result: loaded, warnings } = await captureWarnings(() => store.loadMessages(sessionKey));
  assert.deepEqual(warnings, [], 'concurrent same-session appends must not produce malformed JSONL lines');
  assert.equal(loaded.length, expected.size);
  assert.deepEqual(new Set(loaded.map((m) => m.content)), expected);

  const raw = await fs.readFile(sessionFile(dir, sessionKey), 'utf-8');
  for (const line of raw.split('\n').filter((l) => l.trim())) {
    assert.doesNotThrow(() => JSON.parse(line), 'every JSONL line must parse after concurrent appends');
  }
  console.log('  [PASS] concurrent same-session appends preserve all messages');
}

{
  const { dir, store } = await makeStore();
  const sessionKey = 'replace-order';
  const old = { role: 'user', content: 'old audit message stays on disk' };
  const stateA = [{ role: 'assistant', content: 'state A' }];
  const stateB = [{ role: 'assistant', content: 'state B wins' }];
  const after = { role: 'user', content: 'after state B' };

  await store.appendMessage(sessionKey, old);
  const replaceA = store.replaceMessages(sessionKey, stateA);
  const replaceB = store.replaceMessages(sessionKey, stateB);
  const appendAfter = store.appendMessage(sessionKey, after);
  await Promise.all([replaceA, replaceB, appendAfter]);

  const { result: loaded, warnings } = await captureWarnings(() => store.loadMessages(sessionKey));
  assert.deepEqual(warnings, [], 'replace/appends must not produce malformed JSONL lines');
  assert.deepEqual(loaded.map((m) => m.content), ['state B wins', 'after state B']);

  const raw = await fs.readFile(sessionFile(dir, sessionKey), 'utf-8');
  assert.match(raw, /old audit message stays on disk/, 'replaceMessages must preserve append-only audit history');
  assert.match(raw, /state A/, 'earlier state_replace entries remain on disk');
  assert.match(raw, /state B wins/, 'later state_replace entries remain on disk');
  console.log('  [PASS] replaceMessages preserves append-only history and deterministic last-writer order');
}

{
  const { store } = await makeStore();
  const aWrites = Array.from({ length: 10 }, (_, i) =>
    store.appendMessage('session-a', { role: 'user', content: `a-${i}` }),
  );
  const bWrites = Array.from({ length: 10 }, (_, i) =>
    store.appendMessage('session-b', { role: 'user', content: `b-${i}` }),
  );
  await Promise.all([...aWrites, ...bWrites]);
  assert.equal((await store.loadMessages('session-a')).length, 10);
  assert.equal((await store.loadMessages('session-b')).length, 10);
  console.log('  [PASS] concurrent writes to different sessions remain independent');
}

{
  const { dir } = await makeStore();
  const storeA = new JsonlSessionStore({ dir });
  const storeB = new JsonlSessionStore({ dir });
  const sessionKey = 'two-store-same-session';
  const expected = new Set();
  await Promise.all(
    Array.from({ length: 40 }, (_, i) => {
      const content = `store-${i % 2}-${i}-${'y'.repeat(4096)}`;
      expected.add(content);
      const store = i % 2 === 0 ? storeA : storeB;
      return store.appendMessage(sessionKey, { role: 'user', content });
    }),
  );
  const loaded = await storeA.loadMessages(sessionKey);
  assert.equal(loaded.length, expected.size);
  assert.deepEqual(new Set(loaded.map((m) => m.content)), expected);
  console.log('  [PASS] shared write chain covers multiple store instances in one process');
}

{
  const { store } = await makeStore();
  const sessionKey = 'delete-order';
  const appendBeforeDelete = store.appendMessage(sessionKey, { role: 'user', content: 'before delete' });
  const deleteSession = store.deleteSession(sessionKey);
  const appendAfterDelete = store.appendMessage(sessionKey, { role: 'user', content: 'after delete' });
  await Promise.all([appendBeforeDelete, deleteSession, appendAfterDelete]);

  const loaded = await store.loadMessages(sessionKey);
  assert.deepEqual(loaded.map((m) => m.content), ['after delete']);
  console.log('  [PASS] deleteSession participates in the per-file write chain');
}

console.log('[PASS] JsonlSessionStore concurrency/durability regressions');
