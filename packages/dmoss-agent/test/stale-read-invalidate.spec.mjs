#!/usr/bin/env node
/**
 * Self-test for invalidateStaleReadToolResults — the STALE-READ half of
 * read-result micro-compaction: replace an earlier read whose path was later
 * written/edited (so the cached content is no longer trustworthy) with a short
 * placeholder to reclaim tokens.
 *
 * Regression focus: the recognized tool-name set must cover BOTH runtimes —
 * the moss-CLI builtins (read_file / write_file / edit_file, input `path`) and
 * host tools (read / write / edit, input `file_path`) — normalized to the same
 * ws: key. Until this was fixed the pure moss-CLI builtins were never collected,
 * so the stale pass silently never fired in a builtin-only runtime.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/stale-read-invalidate.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  invalidateStaleReadToolResults,
  STALE_READ_PLACEHOLDER,
} from '../dist/context/stale-read-invalidate.js';

/** Big enough that replacing with the placeholder actually saves chars. */
const BIG = 'export const x = 1;\n'.repeat(20); // ~380 chars

/** One tool call = an assistant tool_use + the matching user tool_result. */
function toolTurn(id, name, input, content) {
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

// 1. moss-CLI builtins: read_file then write_file (same path) → earlier read stale.
//    Core regression — builtins must be collected exactly like host tools.
{
  const messages = [
    ...toolTurn('t1', 'read_file', { path: 'a.ts' }, BIG),
    ...toolTurn('w1', 'write_file', { path: 'a.ts', content: 'x' }, 'Successfully wrote'),
  ];
  const r = invalidateStaleReadToolResults(messages);
  assert.equal(r.invalidatedCount, 1, 'read_file superseded by write_file is invalidated');
  assert.ok(r.savedChars > 0 && r.savedTokens > 0, 'positive savings reported');
  assert.equal(resultContents(r.messages)[0], STALE_READ_PLACEHOLDER, 'stale read replaced by placeholder');
}

// 2. moss-CLI builtins: read_file then edit_file (same path) → read stale.
{
  const messages = [
    ...toolTurn('t1', 'read_file', { path: 'a.ts' }, BIG),
    ...toolTurn('e1', 'edit_file', { path: 'a.ts', old_string: 'a', new_string: 'b' }, 'Edited a.ts'),
  ];
  const r = invalidateStaleReadToolResults(messages);
  assert.equal(r.invalidatedCount, 1, 'read_file superseded by edit_file is invalidated');
}

// 3. Host tools still work: read then write (file_path) → read stale (regression guard).
{
  const messages = [
    ...toolTurn('t1', 'read', { file_path: 'a.ts' }, BIG),
    ...toolTurn('w1', 'write', { file_path: 'a.ts', content: 'x' }, 'ok'),
  ];
  const r = invalidateStaleReadToolResults(messages);
  assert.equal(r.invalidatedCount, 1, 'host read superseded by host write is invalidated');
}

// 4. Host tools: read then edit → read stale (regression guard for the edit name).
{
  const messages = [
    ...toolTurn('t1', 'read', { file_path: 'a.ts' }, BIG),
    ...toolTurn('e1', 'edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, 'ok'),
  ];
  const r = invalidateStaleReadToolResults(messages);
  assert.equal(r.invalidatedCount, 1, 'host read superseded by host edit is invalidated');
}

// 5. Cross-naming key unification: read_file (input `path`) and host write (input
//    `file_path`) on the same file resolve to the SAME ws: key, so the read is
//    still invalidated. This is what makes one pass correct across both runtimes.
{
  const messages = [
    ...toolTurn('t1', 'read_file', { path: 'a.ts' }, BIG),
    ...toolTurn('w1', 'write', { file_path: 'a.ts', content: 'x' }, 'ok'),
  ];
  const r = invalidateStaleReadToolResults(messages);
  assert.equal(r.invalidatedCount, 1, 'read_file and host write normalize to one ws: key');
}

// 6. Order matters: a write BEFORE the read does not make the read stale.
{
  const messages = [
    ...toolTurn('w1', 'write_file', { path: 'a.ts', content: 'x' }, 'ok'),
    ...toolTurn('t1', 'read_file', { path: 'a.ts' }, BIG),
  ];
  const r = invalidateStaleReadToolResults(messages);
  assert.equal(r.invalidatedCount, 0, 'a read after the latest write is current, not stale');
  assert.equal(resultContents(r.messages)[1], BIG, 'current read kept verbatim');
}

// 7. Different paths → no invalidation.
{
  const messages = [
    ...toolTurn('t1', 'read_file', { path: 'a.ts' }, BIG),
    ...toolTurn('w1', 'write_file', { path: 'b.ts', content: 'x' }, 'ok'),
  ];
  const r = invalidateStaleReadToolResults(messages);
  assert.equal(r.invalidatedCount, 0, 'a write to a different path leaves the read intact');
}

// 8. Device namespace: device_file_read superseded by device_file_write → stale.
{
  const messages = [
    ...toolTurn('d1', 'device_file_read', { path: '/etc/hosts' }, BIG),
    ...toolTurn('d2', 'device_file_write', { path: '/etc/hosts', content: 'x' }, 'ok'),
  ];
  const r = invalidateStaleReadToolResults(messages);
  assert.equal(r.invalidatedCount, 1, 'device read superseded by device write is invalidated');
}

// 9. ws: and dev: namespaces never collide for the same raw path string.
{
  const messages = [
    ...toolTurn('t1', 'read_file', { path: 'shared' }, BIG),
    ...toolTurn('d1', 'device_file_write', { path: 'shared', content: 'x' }, 'ok'),
  ];
  const r = invalidateStaleReadToolResults(messages);
  assert.equal(r.invalidatedCount, 0, 'local read and device write are distinct keys');
}

// 10. Idempotent: first pass invalidates the stale read, a second pass invalidates
//     nothing more (a pre-existing placeholder is never re-counted).
{
  const messages = [
    ...toolTurn('t1', 'read_file', { path: 'a.ts' }, BIG),
    ...toolTurn('w1', 'write_file', { path: 'a.ts', content: 'x' }, 'ok'),
  ];
  const once = invalidateStaleReadToolResults(messages);
  assert.equal(once.invalidatedCount, 1, 'first pass invalidates the stale read');
  const twice = invalidateStaleReadToolResults(once.messages);
  assert.equal(twice.invalidatedCount, 0, 'running again invalidates nothing');
}

// 11. Immutability — the input array and its blocks are never mutated.
{
  const messages = [
    ...toolTurn('t1', 'read_file', { path: 'a.ts' }, BIG),
    ...toolTurn('w1', 'write_file', { path: 'a.ts', content: 'x' }, 'ok'),
  ];
  const snapshot = JSON.parse(JSON.stringify(messages));
  const r = invalidateStaleReadToolResults(messages);
  assert.deepEqual(messages, snapshot, 'original messages untouched');
  assert.notEqual(r.messages, messages, 'returns a fresh array');
}

console.log('stale-read-invalidate.spec.mjs: all assertions passed ✓');
