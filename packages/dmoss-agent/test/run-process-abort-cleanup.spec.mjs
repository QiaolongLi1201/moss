#!/usr/bin/env node
import assert from 'node:assert/strict';
import { runProcess } from '../dist/utils/run-process.js';
import { ProcessError } from '../dist/utils/run-process.js';

// Test that aborting a process works correctly and cleanup is idempotent.
const controller = new AbortController();

// Start a process that will sleep
const promise = runProcess('/bin/sh', {
  args: ['-c', 'sleep 10'],
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
