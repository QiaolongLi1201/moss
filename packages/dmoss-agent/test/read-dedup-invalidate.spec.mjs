#!/usr/bin/env node
/**
 * Self-test for dedupeUnchangedReadToolResults — the FILE_UNCHANGED half of
 * read-result micro-compaction: collapse an earlier read whose content is
 * byte-identical to a later read of the same path, always keeping the latest
 * full copy (compaction-safe, no dangling stub).
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/read-dedup-invalidate.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  dedupeUnchangedReadToolResults,
  FILE_UNCHANGED_PLACEHOLDER,
  STALE_READ_PLACEHOLDER,
} from '../dist/context/stale-read-invalidate.js';

/** Big enough that stubbing actually saves chars (content > placeholder length). */
const BIG = 'export const x = 1;\n'.repeat(20); // ~380 chars
const BIG2 = 'export const y = 2;\n'.repeat(20);

/** One read = an assistant tool_use + the matching user tool_result. */
function readTurn(id, name, input, content) {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  ];
}

function resultContents(messages) {
  const out = [];
  for (const msg of messages) {
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    for (const b of msg.content) if (b.type === 'tool_result') out.push(b.content);
  }
  return out;
}

// 1. Identical repeated read → earlier stubbed, latest kept verbatim.
{
  const messages = [
    ...readTurn('t1', 'read_file', { path: 'a.ts' }, BIG),
    ...readTurn('t2', 'read_file', { path: 'a.ts' }, BIG),
  ];
  const r = dedupeUnchangedReadToolResults(messages);
  assert.equal(r.invalidatedCount, 1, 'one earlier duplicate collapsed');
  assert.ok(r.savedChars > 0 && r.savedTokens > 0, 'positive savings reported');
  const contents = resultContents(r.messages);
  assert.equal(contents[0], FILE_UNCHANGED_PLACEHOLDER, 'earlier read replaced with stub');
  assert.equal(contents[1], BIG, 'latest read kept full');
}

// 2. Different content same path → no dedup (the later read is not identical).
{
  const messages = [
    ...readTurn('t1', 'read_file', { path: 'a.ts' }, BIG),
    ...readTurn('t2', 'read_file', { path: 'a.ts' }, BIG2),
  ];
  const r = dedupeUnchangedReadToolResults(messages);
  assert.equal(r.invalidatedCount, 0, 'differing reads are not deduped');
  assert.deepEqual(resultContents(r.messages), [BIG, BIG2]);
}

// 3. Single read → nothing to dedup.
{
  const messages = readTurn('t1', 'read_file', { path: 'a.ts' }, BIG);
  const r = dedupeUnchangedReadToolResults(messages);
  assert.equal(r.invalidatedCount, 0);
  assert.equal(r.savedChars, 0);
}

// 4. Three identical reads → two earlier stubbed, last kept.
{
  const messages = [
    ...readTurn('t1', 'read_file', { path: 'a.ts' }, BIG),
    ...readTurn('t2', 'read_file', { path: 'a.ts' }, BIG),
    ...readTurn('t3', 'read_file', { path: 'a.ts' }, BIG),
  ];
  const r = dedupeUnchangedReadToolResults(messages);
  assert.equal(r.invalidatedCount, 2, 'all but the latest collapsed');
  const contents = resultContents(r.messages);
  assert.deepEqual(contents, [FILE_UNCHANGED_PLACEHOLDER, FILE_UNCHANGED_PLACEHOLDER, BIG]);
}

// 5. Both naming conventions: host `read` (file_path) and device `device_file_read` (path).
{
  const messages = [
    ...readTurn('t1', 'read', { file_path: 'a.ts' }, BIG),
    ...readTurn('t2', 'read', { file_path: 'a.ts' }, BIG),
    ...readTurn('d1', 'device_file_read', { path: '/etc/hosts' }, BIG2),
    ...readTurn('d2', 'device_file_read', { path: '/etc/hosts' }, BIG2),
  ];
  const r = dedupeUnchangedReadToolResults(messages);
  assert.equal(r.invalidatedCount, 2, 'host read and device read each deduped once');
  const contents = resultContents(r.messages);
  assert.deepEqual(contents, [FILE_UNCHANGED_PLACEHOLDER, BIG, FILE_UNCHANGED_PLACEHOLDER, BIG2]);
}

// 6. Same content, different paths → keys differ → no cross-file dedup.
{
  const messages = [
    ...readTurn('t1', 'read_file', { path: 'a.ts' }, BIG),
    ...readTurn('t2', 'read_file', { path: 'b.ts' }, BIG),
  ];
  const r = dedupeUnchangedReadToolResults(messages);
  assert.equal(r.invalidatedCount, 0, 'identical content in different files is not deduped');
}

// 7. ws: and dev: namespaces don't collide even for the same raw path string.
{
  const messages = [
    ...readTurn('t1', 'read_file', { path: 'shared' }, BIG),
    ...readTurn('d1', 'device_file_read', { path: 'shared' }, BIG),
  ];
  const r = dedupeUnchangedReadToolResults(messages);
  assert.equal(r.invalidatedCount, 0, 'local vs device path are distinct keys');
}

// 8. Already-placeholder results are skipped (idempotent — second run is a no-op).
{
  const messages = [
    ...readTurn('t1', 'read_file', { path: 'a.ts' }, BIG),
    ...readTurn('t2', 'read_file', { path: 'a.ts' }, BIG),
  ];
  const once = dedupeUnchangedReadToolResults(messages);
  const twice = dedupeUnchangedReadToolResults(once.messages);
  assert.equal(twice.invalidatedCount, 0, 'running again collapses nothing');
  // A pre-existing stale placeholder must not be treated as a dedupable read.
  const withStale = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'read_file', input: { path: 'a.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: STALE_READ_PLACEHOLDER }] },
    ...readTurn('s2', 'read_file', { path: 'a.ts' }, STALE_READ_PLACEHOLDER),
  ];
  const r = dedupeUnchangedReadToolResults(withStale);
  assert.equal(r.invalidatedCount, 0, 'stale placeholders are not deduped against each other');
}

// 9. Short content (≤ placeholder length) is not worth stubbing.
{
  const messages = [
    ...readTurn('t1', 'read_file', { path: 'a.ts' }, 'hi'),
    ...readTurn('t2', 'read_file', { path: 'a.ts' }, 'hi'),
  ];
  const r = dedupeUnchangedReadToolResults(messages);
  assert.equal(r.invalidatedCount, 0, 'tiny reads are left alone (no real savings)');
}

// 10. Immutability — the input array and its blocks are never mutated.
{
  const messages = [
    ...readTurn('t1', 'read_file', { path: 'a.ts' }, BIG),
    ...readTurn('t2', 'read_file', { path: 'a.ts' }, BIG),
  ];
  const snapshot = JSON.parse(JSON.stringify(messages));
  const r = dedupeUnchangedReadToolResults(messages);
  assert.deepEqual(messages, snapshot, 'original messages untouched');
  assert.notEqual(r.messages, messages, 'returns a fresh array');
}

// 11. Non-read tools (write/edit/bash) are ignored even with identical content.
{
  const messages = [
    ...readTurn('w1', 'write_file', { path: 'a.ts' }, BIG),
    ...readTurn('w2', 'write_file', { path: 'a.ts' }, BIG),
  ];
  const r = dedupeUnchangedReadToolResults(messages);
  assert.equal(r.invalidatedCount, 0, 'write results are not read-deduped');
}

console.log('read-dedup-invalidate.spec.mjs: all assertions passed ✓');
