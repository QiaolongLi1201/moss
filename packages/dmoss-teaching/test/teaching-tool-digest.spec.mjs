#!/usr/bin/env node
/**
 * Self-test for digestStudioToolCall.
 *
 * Run:
 *   npm run build -w @rdk-moss/teaching
 *   node packages/dmoss-teaching/test/teaching-tool-digest.spec.mjs
 */

import assert from 'node:assert/strict';
import { digestStudioToolCall } from '../dist/index.js';

// ── Deterministic output ──

{
  // Same inputs always produce the same digest
  const a = digestStudioToolCall('shell_exec', { cmd: 'ls -la' });
  const b = digestStudioToolCall('shell_exec', { cmd: 'ls -la' });
  assert.equal(a, b, 'identical inputs must produce identical digest');
}

{
  // Different tool names produce different digests
  const a = digestStudioToolCall('shell_exec', { cmd: 'ls' });
  const b = digestStudioToolCall('write_file', { cmd: 'ls' });
  assert.notEqual(a, b, 'different tool names must produce different digests');
}

{
  // Different input values produce different digests
  const a = digestStudioToolCall('shell_exec', { cmd: 'ls -la' });
  const b = digestStudioToolCall('shell_exec', { cmd: 'pwd' });
  assert.notEqual(a, b, 'different input values must produce different digests');
}

// ── Key ordering stability ──

{
  // Same key-value pairs in different insertion order produce the same digest
  const a = digestStudioToolCall('tool', { zebra: 1, alpha: 2, mango: 3 });
  const b = digestStudioToolCall('tool', { mango: 3, zebra: 1, alpha: 2 });
  assert.equal(a, b, 'key insertion order must not affect digest');
}

// ── Nested objects ──

{
  // Nested objects are also sorted by key
  const a = digestStudioToolCall('tool', { outer: { z: 1, a: 2 } });
  const b = digestStudioToolCall('tool', { outer: { a: 2, z: 1 } });
  assert.equal(a, b, 'nested key order must not affect digest');
}

{
  // Different nested values produce different digests
  const a = digestStudioToolCall('tool', { config: { mode: 'fast' } });
  const b = digestStudioToolCall('tool', { config: { mode: 'slow' } });
  assert.notEqual(a, b, 'different nested values must produce different digests');
}

// ── Arrays ──

{
  // Arrays are preserved (not sorted) — same order = same digest
  const a = digestStudioToolCall('tool', { items: [1, 2, 3] });
  const b = digestStudioToolCall('tool', { items: [1, 2, 3] });
  assert.equal(a, b, 'identical arrays must produce identical digest');
}

{
  // Different array order produces different digest
  const a = digestStudioToolCall('tool', { items: [1, 2, 3] });
  const b = digestStudioToolCall('tool', { items: [3, 2, 1] });
  assert.notEqual(a, b, 'different array order must produce different digest');
}

// ── Edge cases ──

{
  // Empty input object produces a valid digest
  const a = digestStudioToolCall('tool', {});
  assert.ok(typeof a === 'string' && a.length > 0, 'empty input must produce non-empty digest');
}

{
  // null-ish input (passed as empty) produces valid digest
  const a = digestStudioToolCall('tool', null ?? {});
  assert.ok(typeof a === 'string' && a.length > 0, 'null input coerced to {} must work');
}

// ── Output format ──

{
  // Digest is a hex string of expected length (24 hex chars)
  const digest = digestStudioToolCall('tool', { key: 'value' });
  assert.ok(/^[0-9a-f]{24}$/.test(digest), `digest must be 24 hex chars, got: ${digest}`);
}

{
  // Digests for many different inputs are all unique (no collisions in small sample)
  const digests = new Set();
  for (let i = 0; i < 200; i++) {
    digests.add(digestStudioToolCall('tool', { iteration: i, data: `sample-${i}` }));
  }
  assert.equal(digests.size, 200, '200 unique inputs must produce 200 unique digests');
}

console.log('All teaching-tool-digest checks passed.');
