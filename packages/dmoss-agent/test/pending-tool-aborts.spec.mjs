#!/usr/bin/env node
/**
 * pending-tool-aborts session isolation tests.
 *
 * The module keeps a deliberate process-wide map keyed by sessionKey (see the
 * DESIGN INTENT comment in the source). These tests pin the isolation
 * contract: entries noted for one session must never surface in another, and
 * consuming is exactly-once.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/pending-tool-aborts.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  notePendingAbortedToolCalls,
  consumePendingAbortedToolSyntheticMessages,
} from '../dist/core/loop/pending-tool-aborts.js';

// ─── two sessions never cross-contaminate ───

{
  notePendingAbortedToolCalls('session-A', [
    { id: 'tu-1', name: 'device_exec' },
    { id: 'tu-2', name: 'read' },
  ]);
  notePendingAbortedToolCalls('session-B', [{ id: 'tu-9', name: 'bash' }]);

  const fromB = consumePendingAbortedToolSyntheticMessages('session-B');
  assert.equal(fromB.length, 1, 'session-B yields exactly one synthetic message');
  const idsB = fromB[0].content.map((c) => c.tool_use_id);
  assert.deepEqual(idsB, ['tu-9'], 'session-B must only see its own tool_use ids');

  const fromA = consumePendingAbortedToolSyntheticMessages('session-A');
  const idsA = fromA[0].content.map((c) => c.tool_use_id).sort();
  assert.deepEqual(idsA, ['tu-1', 'tu-2'], 'session-A must only see its own tool_use ids');
  console.log('  [PASS] sessions are isolated by key');
}

// ─── consume is exactly-once and shape is a valid tool_result round-trip ───

{
  notePendingAbortedToolCalls('session-C', [{ id: 'tu-5', name: 'write' }]);
  const first = consumePendingAbortedToolSyntheticMessages('session-C');
  assert.equal(first.length, 1);
  assert.equal(first[0].role, 'user');
  const block = first[0].content[0];
  assert.equal(block.type, 'tool_result');
  assert.equal(block.is_error, true);
  const payload = JSON.parse(block.content);
  assert.equal(payload.output, 'aborted');
  assert.equal(payload.metadata.reason, 'user_cancelled');

  const second = consumePendingAbortedToolSyntheticMessages('session-C');
  assert.deepEqual(second, [], 'second consume must be empty (exactly-once)');
  console.log('  [PASS] consume is exactly-once with valid tool_result shape');
}

// ─── empty note is a no-op; unknown session consumes empty ───

{
  notePendingAbortedToolCalls('session-D', []);
  assert.deepEqual(consumePendingAbortedToolSyntheticMessages('session-D'), []);
  assert.deepEqual(consumePendingAbortedToolSyntheticMessages('never-noted'), []);
  console.log('  [PASS] empty/unknown sessions are no-ops');
}

console.log('pending-tool-aborts: all tests passed');
