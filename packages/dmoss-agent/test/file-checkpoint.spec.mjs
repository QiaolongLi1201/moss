#!/usr/bin/env node
/**
 * Tests for FileCheckpointStore — the /rewind file-undo safety net.
 *
 * Focus: /rewind must NOT silently overwrite files the user edited outside the
 * session. The store records an "after-write" fingerprint per file; rewind only
 * restores a file that still matches what the agent left, otherwise it skips and
 * reports the file so the user's manual edits survive.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/file-checkpoint.spec.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileCheckpointStore } from '../dist/cli/file-checkpoint.js';

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'file-checkpoint-test-'));
  try {
    await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function newStore(dir) {
  return new FileCheckpointStore({ runtimeDir: path.join(dir, '.runtime'), sessionKey: 'test-session' });
}

/** Simulate one agent write under the checkpoint: pre-hook backup, write, post-hook fingerprint. */
function agentWrite(store, absPath, content) {
  store.trackBeforeWrite(absPath); // pre-tool hook (before write)
  fs.writeFileSync(absPath, content); // the agent's actual write
  store.noteAfterWrite(absPath); // post-tool hook (after write)
}

// ── Test 1: normal create → write → rewind restores the original content ──
await withTempDir(async (dir) => {
  const target = path.join(dir, 'note.txt');
  fs.writeFileSync(target, 'ORIGINAL');

  const store = newStore(dir);
  store.open('edit note');
  agentWrite(store, target, 'AGENT-WROTE-THIS');
  assert.equal(fs.readFileSync(target, 'utf8'), 'AGENT-WROTE-THIS');

  const result = store.rewindTo(1);
  assert.equal(result.found, true);
  assert.deepEqual(result.restored, [target], 'unmodified agent write should be restored');
  assert.deepEqual(result.skipped, []);
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL', 'file content must roll back to original');
  console.log('[PASS] normal create→write→rewind restores original');
});

// ── Test 2 (CORE): a file the user edited externally is NOT silently overwritten ──
await withTempDir(async (dir) => {
  const target = path.join(dir, 'note.txt');
  fs.writeFileSync(target, 'ORIGINAL');

  const store = newStore(dir);
  store.open('edit note');
  agentWrite(store, target, 'AGENT-WROTE-THIS');

  // User opens the file in an external editor and saves their own change.
  // This write happens after the agent's write and is never tracked.
  const userContent = 'USER-HAND-EDIT-DO-NOT-LOSE';
  fs.writeFileSync(target, userContent);

  const result = store.rewindTo(1);
  assert.equal(result.found, true);
  assert.deepEqual(result.restored, [], 'must not restore over a user edit');
  assert.deepEqual(result.skipped, [target], 'externally modified file must be reported as skipped');
  assert.equal(
    fs.readFileSync(target, 'utf8'),
    userContent,
    'the user manual edit must survive /rewind (no silent data loss)',
  );
  console.log('[PASS] externally-modified file is not silently overwritten by /rewind');
});

// ── Test 3: agent-created file → normal rewind removes it (restore-to-absent) ──
await withTempDir(async (dir) => {
  const target = path.join(dir, 'fresh.txt');
  assert.equal(fs.existsSync(target), false);

  const store = newStore(dir);
  store.open('create file');
  agentWrite(store, target, 'NEW-FILE-BODY');
  assert.equal(fs.existsSync(target), true);

  const result = store.rewindTo(1);
  assert.equal(result.found, true);
  assert.deepEqual(result.restored, [target]);
  assert.deepEqual(result.skipped, []);
  assert.equal(fs.existsSync(target), false, 'a file the agent created should be removed on rewind');
  console.log('[PASS] agent-created file is removed on normal rewind');
});

// ── Test 4: agent-created file then user-edited → rewind must NOT delete it ──
await withTempDir(async (dir) => {
  const target = path.join(dir, 'fresh.txt');

  const store = newStore(dir);
  store.open('create file');
  agentWrite(store, target, 'NEW-FILE-BODY');

  // User edits the freshly created file before rewinding.
  const userContent = 'USER-MADE-THIS-THEIR-OWN';
  fs.writeFileSync(target, userContent);

  const result = store.rewindTo(1);
  assert.equal(result.found, true);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.skipped, [target]);
  assert.equal(fs.existsSync(target), true, 'must not delete a file the user has since edited');
  assert.equal(fs.readFileSync(target, 'utf8'), userContent, 'user content must be preserved');
  console.log('[PASS] user-edited new file is not deleted on rewind');
});

// ── Test 5: missing seq is reported, nothing touched ──
await withTempDir(async (dir) => {
  const target = path.join(dir, 'note.txt');
  fs.writeFileSync(target, 'ORIGINAL');

  const store = newStore(dir);
  store.open('edit note');
  agentWrite(store, target, 'AGENT');

  const result = store.rewindTo(999);
  assert.equal(result.found, false);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(fs.readFileSync(target, 'utf8'), 'AGENT', 'an unknown checkpoint must not change anything');
  console.log('[PASS] unknown checkpoint seq is a no-op');
});

// ── Test 6: conservative skip when no after-write fingerprint was captured ──
// If post-hook never ran (e.g. process died mid-turn) and the file diverged from
// the pre-write original, rewind must still refuse to clobber it.
await withTempDir(async (dir) => {
  const target = path.join(dir, 'note.txt');
  fs.writeFileSync(target, 'ORIGINAL');

  const store = newStore(dir);
  store.open('edit note');
  store.trackBeforeWrite(target); // backup taken, but noteAfterWrite intentionally NOT called
  fs.writeFileSync(target, 'DIVERGED-CONTENT');

  const result = store.rewindTo(1);
  assert.equal(result.found, true);
  assert.deepEqual(result.restored, [], 'no fingerprint + diverged content → must skip');
  assert.deepEqual(result.skipped, [target]);
  assert.equal(fs.readFileSync(target, 'utf8'), 'DIVERGED-CONTENT', 'content must be left untouched');
  console.log('[PASS] missing after-write fingerprint falls back to a conservative skip');
});

// ── Test 7: untouched original (agent write reverted to original) still restores safely ──
await withTempDir(async (dir) => {
  const target = path.join(dir, 'note.txt');
  fs.writeFileSync(target, 'ORIGINAL');

  const store = newStore(dir);
  store.open('edit note');
  store.trackBeforeWrite(target);
  // Agent writes the SAME bytes back (a no-op edit); no post fingerprint captured.
  fs.writeFileSync(target, 'ORIGINAL');

  const result = store.rewindTo(1);
  assert.equal(result.found, true);
  assert.deepEqual(result.restored, [target], 'content equal to the original is safe to restore');
  assert.deepEqual(result.skipped, []);
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
  console.log('[PASS] file still equal to the original restores safely without a fingerprint');
});

console.log('\nAll file-checkpoint tests passed ✓');
