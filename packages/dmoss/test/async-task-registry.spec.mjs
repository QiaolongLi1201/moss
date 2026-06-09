#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  InMemoryMossAsyncTaskRegistry,
  createInMemoryMossAsyncTaskRegistry,
} from '../dist/contracts/async-task.js';
import * as coreRoot from '../dist/index.js';

let total = 0;
let passed = 0;

function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startRequest(taskId, extras = {}) {
  return {
    taskId,
    kind: 'subagent',
    payload: { task: taskId },
    ...extras,
  };
}

// Test 1: start returns immediately with a stable handle while work runs.
total++;
{
  assert.equal(typeof coreRoot.InMemoryMossAsyncTaskRegistry, 'function');
  assert.equal(typeof coreRoot.createInMemoryMossAsyncTaskRegistry, 'function');
  console.log('  [PASS] async task registry is discoverable from the main barrel');
  passed++;
}

// Test 2: start returns immediately with a stable handle while work runs.
total++;
{
  const registry = createInMemoryMossAsyncTaskRegistry();
  let release;
  const runnerGate = new Promise((resolve) => { release = resolve; });
  const handle = registry.start(startRequest('task-1'), async () => {
    await runnerGate;
    return { success: true, summary: 'done' };
  });
  assert.deepEqual(handle, { taskId: 'task-1', status: 'running' });
  assert.equal(registry.status('task-1')?.status, 'running');
  release();
  const completion = await registry.wait('task-1');
  assert.equal(completion.status, 'completed');
  assert.equal(completion.summary, 'done');
  console.log('  [PASS] start returns an immediate running handle');
  passed++;
}

// Test 3: completion records are idempotent and reused by wait/readCompletion.
total++;
{
  const registry = createInMemoryMossAsyncTaskRegistry();
  registry.start(startRequest('task-2'), async () => ({
    success: true,
    summary: 'stable completion',
    data: { n: 1 },
  }));
  const first = await registry.wait('task-2');
  const second = await registry.wait('task-2');
  const read = registry.readCompletion('task-2');
  assert.equal(first, second);
  assert.equal(read, first);
  assert.equal(registry.stop('task-2'), true);
  assert.equal(registry.readCompletion('task-2'), first);
  assert.equal(registry.status('task-2')?.status, 'completed');
  console.log('  [PASS] completion is idempotent after reads and late cancellation');
  passed++;
}

// Test 4: timeout transitions a running task to timed_out and aborts the runner.
total++;
{
  const registry = new InMemoryMossAsyncTaskRegistry();
  let sawAbort = false;
  registry.start(startRequest('task-3', { timeoutMs: 10 }), async (_request, signal) => {
    signal.addEventListener('abort', () => { sawAbort = true; }, { once: true });
    await tick(50);
    return { success: true, summary: 'too late' };
  });
  const completion = await registry.wait('task-3');
  assert.equal(completion.status, 'timed_out');
  assert.equal(completion.success, false);
  assert.equal(sawAbort, true);
  assert.equal(registry.status('task-3')?.status, 'timed_out');
  console.log('  [PASS] timeout produces a timed_out completion and abort signal');
  passed++;
}

// Test 5: cancelling a parent cascades to queued and running descendants.
total++;
{
  const registry = new InMemoryMossAsyncTaskRegistry({ maxConcurrent: 2 });
  registry.start(startRequest('parent'), async (_request, signal) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return { success: false, summary: 'parent aborted' };
  });
  registry.start(startRequest('child-running', { parentTaskId: 'parent' }), async (_request, signal) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return { success: false, summary: 'child aborted' };
  });
  let childQueuedRan = false;
  registry.start(startRequest('child-queued', { parentTaskId: 'parent' }), async () => {
    childQueuedRan = true;
    return { success: true, summary: 'should not run' };
  });
  registry.start(startRequest('grandchild-queued', { parentTaskId: 'child-running' }), async (_request, signal) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return { success: false, summary: 'grandchild aborted' };
  });
  assert.equal(registry.status('child-running')?.status, 'running');
  assert.equal(registry.status('child-queued')?.status, 'queued');
  assert.equal(registry.status('grandchild-queued')?.status, 'queued');
  assert.equal(registry.stop('parent'), true);
  const parent = await registry.wait('parent');
  const childRunning = await registry.wait('child-running');
  const childQueued = await registry.wait('child-queued');
  const grandchildQueued = await registry.wait('grandchild-queued');
  assert.equal(parent.status, 'cancelled');
  assert.equal(childRunning.status, 'cancelled');
  assert.equal(childQueued.status, 'cancelled');
  assert.equal(grandchildQueued.status, 'cancelled');
  assert.equal(childRunning.error, 'Task cancelled because its parent was aborted.');
  assert.equal(grandchildQueued.error, 'Task cancelled because its parent was aborted.');
  // Regression: a queued child must be cancelled WHILE queued, never entered into
  // its runner first (stopTree cancels descendants before the parent's pump()).
  assert.equal(childQueuedRan, false, 'a queued child must not run when its parent is cancelled');
  console.log('  [PASS] parent cancellation cascades to queued and running descendants');
  passed++;
}

// Test 6: pre-aborted parent signal never starts the runner.
total++;
{
  const registry = createInMemoryMossAsyncTaskRegistry();
  const controller = new AbortController();
  controller.abort();
  let ran = false;
  registry.start(
    startRequest('task-5'),
    async () => {
      ran = true;
      return { success: true, summary: 'unexpected' };
    },
    { parentSignal: controller.signal },
  );
  const completion = await registry.wait('task-5');
  assert.equal(completion.status, 'cancelled');
  assert.equal(ran, false);
  console.log('  [PASS] pre-aborted parent signal cancels before execution');
  passed++;
}

// Test 7: parent abort signal cascades to running descendants.
total++;
{
  const registry = new InMemoryMossAsyncTaskRegistry({ maxConcurrent: 3 });
  const controller = new AbortController();
  registry.start(
    startRequest('signal-parent'),
    async (_request, signal) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return { success: false, summary: 'parent aborted' };
    },
    { parentSignal: controller.signal },
  );
  registry.start(startRequest('signal-child', { parentTaskId: 'signal-parent' }), async (_request, signal) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return { success: false, summary: 'child aborted' };
  });
  registry.start(startRequest('signal-grandchild', { parentTaskId: 'signal-child' }), async (_request, signal) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return { success: false, summary: 'grandchild aborted' };
  });
  controller.abort();
  assert.equal((await registry.wait('signal-parent')).status, 'cancelled');
  assert.equal((await registry.wait('signal-child')).status, 'cancelled');
  assert.equal((await registry.wait('signal-grandchild')).status, 'cancelled');
  console.log('  [PASS] parent abort signal cascades to running descendants');
  passed++;
}

// Test 8: synchronous runner failures complete the task and resolve waiters.
total++;
{
  const registry = createInMemoryMossAsyncTaskRegistry();
  registry.start(startRequest('sync-throw'), () => {
    throw new Error('sync boom');
  });
  const completion = await registry.wait('sync-throw');
  assert.equal(completion.status, 'failed');
  assert.equal(completion.success, false);
  assert.equal(completion.error, 'sync boom');
  assert.equal(registry.status('sync-throw')?.status, 'failed');
  console.log('  [PASS] synchronous runner throw records a failed completion');
  passed++;
}

// Test 9: cancelling one task does not affect unrelated tasks.
total++;
{
  const registry = createInMemoryMossAsyncTaskRegistry();
  registry.start(startRequest('task-6a'), async (_request, signal) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return { success: false, summary: 'cancelled' };
  });
  registry.start(startRequest('task-6b'), async () => ({ success: true, summary: 'survived' }));
  registry.stop('task-6a');
  const cancelled = await registry.wait('task-6a');
  const survived = await registry.wait('task-6b');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(survived.status, 'completed');
  assert.equal(survived.summary, 'survived');
  console.log('  [PASS] cancellation is isolated to the target task tree');
  passed++;
}

// Test 10: duplicate task ids are rejected.
total++;
{
  const registry = createInMemoryMossAsyncTaskRegistry();
  registry.start(startRequest('task-7'), async () => ({ success: true, summary: 'ok' }));
  assert.throws(
    () => registry.start(startRequest('task-7'), async () => ({ success: true, summary: 'duplicate' })),
    /already exists/,
  );
  await registry.wait('task-7');
  console.log('  [PASS] duplicate task ids are rejected');
  passed++;
}

// Test 11: list supports status and parent filters.
total++;
{
  const registry = new InMemoryMossAsyncTaskRegistry({ maxConcurrent: 1 });
  registry.start(startRequest('task-8a', { parentTaskId: 'parent-8' }), async (_request, signal) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return { success: false, summary: 'cancelled' };
  });
  registry.start(startRequest('task-8b', { parentTaskId: 'parent-8' }), async () => ({
    success: true,
    summary: 'queued',
  }));
  assert.equal(registry.list({ parentTaskId: 'parent-8' }).length, 2);
  assert.equal(registry.list({ status: 'queued' }).length, 1);
  registry.stop('task-8a');
  await registry.wait('task-8a');
  await registry.wait('task-8b');
  assert.equal(registry.list({ status: 'completed' }).length, 1);
  console.log('  [PASS] list filters by parent and status');
  passed++;
}

// Test 12: progress updates are observable through status/list snapshots.
total++;
{
  const registry = createInMemoryMossAsyncTaskRegistry();
  registry.start(startRequest('task-progress'), async (_request, signal) => {
    registry.update('task-progress', {
      progress: {
        phase: 'tool',
        message: 'reading docs',
        currentTurn: 2,
        maxTurns: 5,
        toolCalls: 3,
        lastTool: 'web_fetch',
      },
    });
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return { success: false, summary: 'cancelled' };
  });
  await tick();
  const snapshot = registry.status('task-progress');
  assert.equal(snapshot?.progress?.phase, 'tool');
  assert.equal(snapshot?.progress?.message, 'reading docs');
  assert.equal(snapshot?.progress?.currentTurn, 2);
  assert.equal(snapshot?.progress?.toolCalls, 3);
  assert.equal(snapshot?.progress?.lastTool, 'web_fetch');
  assert.equal(registry.list()[0]?.progress?.phase, 'tool');
  registry.stop('task-progress');
  await registry.wait('task-progress');
  console.log('  [PASS] progress updates are observable in snapshots');
  passed++;
}

console.log(`\n[pass] async-task-registry: ${passed}/${total}`);
