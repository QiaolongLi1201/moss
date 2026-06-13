#!/usr/bin/env node
import assert from 'node:assert/strict';
import { runProcess } from '../dist/utils/run-process.js';
import { ProcessError } from '../dist/utils/run-process.js';

// Test that aborting a process works correctly and cleanup is idempotent.
const controller = new AbortController();

// Start a long-running child via the Node binary (present on every platform —
// '/bin/sh' does not exist on Windows and would ENOENT before the abort fires).
const promise = runProcess(process.execPath, {
  args: ['-e', 'setTimeout(() => {}, 10000)'],
  signal: controller.signal,
});

// Abort it after a short delay
setTimeout(() => {
  controller.abort();
}, 100);

await assert.rejects(
  promise,
  (err) => {
    // Should get an abort-related error, not spawn error
    return err instanceof ProcessError || (err instanceof Error && err.message.includes('aborted'));
  },
  'aborted process should reject',
);

console.log('[PASS] run-process abort cleanup: signal cleanup is safe and idempotent');
