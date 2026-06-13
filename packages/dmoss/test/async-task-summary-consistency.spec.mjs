#!/usr/bin/env node
/**
 * Test for async task summary consistency bug fix
 */

import assert from 'node:assert/strict';
import { createInMemoryMossAsyncTaskRegistry } from '../dist/contracts/async-task.js';

let passed = 0;
let total = 0;

/* ---- Test: Empty summary fallback ---- */

total++;
{
  const registry = createInMemoryMossAsyncTaskRegistry();
  const runner = async () => ({
    success: false,
    summary: '',
    data: null,
  });
  
  registry.start({
    taskId: 'empty-summary-test',
    kind: 'host_task',
    payload: {},
  }, runner);
  
  const completion = await registry.wait('empty-summary-test');
  
  assert.equal(completion.status, 'failed');
  assert.equal(completion.success, false);
  // Both summary and error should have the fallback value
  assert.equal(completion.summary, 'task failed');
  assert.equal(completion.error, 'task failed');
  console.log('  [PASS] empty summary gets fallback value');
  passed++;
}

/* ---- Test: Non-empty summary preserved ---- */

total++;
{
  const registry = createInMemoryMossAsyncTaskRegistry();
  const runner = async () => ({
    success: false,
    summary: 'Custom failure message',
    data: null,
  });
  
  registry.start({
    taskId: 'custom-summary-test',
    kind: 'host_task',
    payload: {},
  }, runner);
  
  const completion = await registry.wait('custom-summary-test');
  
  assert.equal(completion.status, 'failed');
  assert.equal(completion.summary, 'Custom failure message');
  assert.equal(completion.error, 'Custom failure message');
  console.log('  [PASS] custom summary preserved');
  passed++;
}

/* ---- Test: Success path consistency ---- */

total++;
{
  const registry = createInMemoryMossAsyncTaskRegistry();
  const runner = async () => ({
    success: true,
    summary: 'Task completed',
    data: { result: 'data' },
  });
  
  registry.start({
    taskId: 'success-test',
    kind: 'host_task',
    payload: {},
  }, runner);
  
  const completion = await registry.wait('success-test');
  
  assert.equal(completion.status, 'completed');
  assert.equal(completion.success, true);
  assert.equal(completion.summary, 'Task completed');
  assert.deepEqual(completion.data, { result: 'data' });
  console.log('  [PASS] success path summary handling');
  passed++;
}

console.log(`\n${passed}/${total} async task summary tests passed`);
process.exit(passed === total ? 0 : 1);
