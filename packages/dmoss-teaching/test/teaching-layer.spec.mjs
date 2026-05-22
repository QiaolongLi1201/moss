#!/usr/bin/env node
/**
 * Self-test for normalizeTeachingDepth and createStudioTeachingHooks.
 *
 * Run:
 *   npm run build -w @dmoss/teaching
 *   node packages/dmoss-teaching/test/teaching-layer.spec.mjs
 */

import assert from 'node:assert/strict';
import { normalizeTeachingDepth, createStudioTeachingHooks } from '../dist/index.js';

// ── normalizeTeachingDepth ──

{
  // Valid values pass through
  assert.equal(normalizeTeachingDepth('off'), 'off');
  assert.equal(normalizeTeachingDepth('concise'), 'concise');
  assert.equal(normalizeTeachingDepth('detailed'), 'detailed');
}

{
  // Invalid values default to 'off'
  assert.equal(normalizeTeachingDepth(undefined), 'off');
  assert.equal(normalizeTeachingDepth(null), 'off');
  assert.equal(normalizeTeachingDepth(''), 'off');
  assert.equal(normalizeTeachingDepth('verbose'), 'off');
  assert.equal(normalizeTeachingDepth(0), 'off');
  assert.equal(normalizeTeachingDepth(true), 'off');
  assert.equal(normalizeTeachingDepth({}), 'off');
}

// ── createStudioTeachingHooks: return shape ──

{
  // Always returns an object with onBeforeToolExec and onToolResult
  const hooks = createStudioTeachingHooks({
    depth: 'off',
    teachingConfirmRequested: false,
    teachingConfirmInteractive: false,
    llmProvider: createMockLlmProvider(),
    modelId: 'test-model',
    emitTeachingMeta: () => {},
    runId: 'run-1',
    sessionKey: 'session-1',
    deviceLabel: 'test-board',
    familyIsRdk: true,
    waitTeachingConfirm: async () => false,
    classifyPlanMutation: () => false,
  });
  assert.equal(typeof hooks.onBeforeToolExec, 'function');
  assert.equal(typeof hooks.onToolResult, 'function');
}

// ── createStudioTeachingHooks: depth=off, no confirm ──

{
  // When depth is off and teachingConfirmRequested is false, hooks are pass-through
  let metaCalled = false;
  const hooks = createStudioTeachingHooks({
    depth: 'off',
    teachingConfirmRequested: false,
    teachingConfirmInteractive: false,
    llmProvider: createMockLlmProvider(),
    modelId: 'test-model',
    emitTeachingMeta: () => { metaCalled = true; },
    runId: 'run-2',
    sessionKey: 'session-2',
    deviceLabel: 'board',
    familyIsRdk: false,
    waitTeachingConfirm: async () => false,
    classifyPlanMutation: () => true,
  });

  const mockTool = makeMockTool('shell_exec', 'readonly');
  const decision = await hooks.onBeforeToolExec({
    tool: mockTool,
    input: { cmd: 'ls' },
    sessionKey: 'session-2',
  });
  assert.deepEqual(decision, { approved: true });
  // onToolResult should be a no-op (doesn't throw)
  hooks.onToolResult(
    { id: 'call-1', name: 'shell_exec', input: { cmd: 'ls' } },
    { toolUseId: 'call-1', content: 'file1 file2' },
  );
  // With depth=off and no confirm, no meta should be emitted
  assert.equal(metaCalled, false, 'emitTeachingMeta should not be called when depth=off');
}

// ── createStudioTeachingHooks: depth=concise with read-only tool ──

{
  // With concise depth, non-mutation tools should not trigger annotation
  let metaCalls = [];
  const hooks = createStudioTeachingHooks({
    depth: 'concise',
    teachingConfirmRequested: false,
    teachingConfirmInteractive: false,
    llmProvider: createMockLlmProvider(),
    modelId: 'test-model',
    emitTeachingMeta: (meta) => { metaCalls.push(meta); },
    runId: 'run-3',
    sessionKey: 'session-3',
    deviceLabel: 'board',
    familyIsRdk: false,
    waitTeachingConfirm: async () => false,
    classifyPlanMutation: (name) => name === 'write_file',
  });

  const mockTool = makeMockTool('read_file', 'readonly');
  const decision = await hooks.onBeforeToolExec({
    tool: mockTool,
    input: { path: '/some/file' },
    sessionKey: 'session-3',
  });
  assert.deepEqual(decision, { approved: true });

  // Give async annotation time to fire (it shouldn't for read-only in concise mode)
  await new Promise(r => setTimeout(r, 50));
  // No pre-annotation should be emitted for read-only tools in concise mode
  const preAnnotations = metaCalls.filter(m => m.phase === 'pre');
  assert.equal(preAnnotations.length, 0, 'concise depth should not annotate read-only tools');
}

// ── createStudioTeachingHooks: abortSignal ──

{
  // When abortSignal is already aborted, onBeforeToolExec returns approved immediately
  const abortController = new AbortController();
  abortController.abort();

  const hooks = createStudioTeachingHooks({
    depth: 'detailed',
    teachingConfirmRequested: false,
    teachingConfirmInteractive: false,
    llmProvider: createMockLlmProvider(),
    modelId: 'test-model',
    emitTeachingMeta: () => { assert.fail('should not emit meta when aborted'); },
    runId: 'run-4',
    sessionKey: 'session-4',
    deviceLabel: 'board',
    familyIsRdk: true,
    waitTeachingConfirm: async () => false,
    classifyPlanMutation: () => true,
    abortSignal: abortController.signal,
  });

  const mockTool = makeMockTool('shell_exec', 'mutation');
  const decision = await hooks.onBeforeToolExec({
    tool: mockTool,
    input: { cmd: 'rm -rf /' },
    sessionKey: 'session-4',
  });
  assert.deepEqual(decision, { approved: true });
}

{
  // When abortSignal is aborted, onToolResult is a no-op
  const abortController = new AbortController();
  abortController.abort();

  let metaCalled = false;
  const hooks = createStudioTeachingHooks({
    depth: 'detailed',
    teachingConfirmRequested: false,
    teachingConfirmInteractive: false,
    llmProvider: createMockLlmProvider(),
    modelId: 'test-model',
    emitTeachingMeta: () => { metaCalled = true; },
    runId: 'run-5',
    sessionKey: 'session-5',
    deviceLabel: 'board',
    familyIsRdk: false,
    waitTeachingConfirm: async () => false,
    classifyPlanMutation: () => true,
    abortSignal: abortController.signal,
  });

  hooks.onToolResult(
    { id: 'call-5', name: 'shell_exec', input: {} },
    { toolUseId: 'call-5', content: 'output' },
  );
  // onToolResult should be a no-op when aborted
  assert.equal(metaCalled, false, 'onToolResult should not emit meta when aborted');
}

// ── createStudioTeachingHooks: onBeforeToolExec always approves ──

{
  // Even for mutation tools, the hook approves by default (no teachingConfirmRequested)
  const hooks = createStudioTeachingHooks({
    depth: 'concise',
    teachingConfirmRequested: false,
    teachingConfirmInteractive: false,
    llmProvider: createMockLlmProvider(),
    modelId: 'test-model',
    emitTeachingMeta: () => {},
    runId: 'run-6',
    sessionKey: 'session-6',
    deviceLabel: 'rdk-board',
    familyIsRdk: true,
    waitTeachingConfirm: async () => false,
    classifyPlanMutation: () => true,
  });

  const mockTool = makeMockTool('deploy', 'mutation');
  const decision = await hooks.onBeforeToolExec({
    tool: mockTool,
    input: { target: 'production' },
    sessionKey: 'session-6',
  });
  assert.deepEqual(decision, { approved: true });
}

// ── createStudioTeachingHooks: teachingConfirmRequested with non-interactive ──

{
  // When teachingConfirmRequested=true but teachingConfirmInteractive=false,
  // dry_run is emitted but does NOT block (auto-approved)
  const metaCalls = [];
  const hooks = createStudioTeachingHooks({
    depth: 'off',
    teachingConfirmRequested: true,
    teachingConfirmInteractive: false,
    llmProvider: createMockLlmProvider(),
    modelId: 'test-model',
    emitTeachingMeta: (meta) => { metaCalls.push(meta); },
    runId: 'run-7',
    sessionKey: 'session-7',
    deviceLabel: 'board',
    familyIsRdk: false,
    waitTeachingConfirm: async () => false,
    classifyPlanMutation: () => true,
  });

  const mockTool = makeMockTool('shell_exec', 'mutation');
  const decision = await hooks.onBeforeToolExec({
    tool: mockTool,
    input: { cmd: 'reboot' },
    sessionKey: 'session-7',
  });
  assert.deepEqual(decision, { approved: true }, 'non-interactive confirm should auto-approve');

  // The dry_run_summary meta should have been emitted
  const dryRunMetas = metaCalls.filter(m => m.phase === 'dry_run_summary');
  assert.equal(dryRunMetas.length, 1, 'dry_run_summary should be emitted');
  assert.equal(dryRunMetas[0].awaitingConfirm, false, 'should not be awaiting confirm when non-interactive');
  assert.equal(dryRunMetas[0].confirmToken, undefined, 'confirmToken should be undefined when non-interactive');
}

// ── createStudioTeachingHooks: dry_run emitted only on first mutation ──

{
  // dry_run_summary is only emitted once for the first mutation tool
  const metaCalls = [];
  const hooks = createStudioTeachingHooks({
    depth: 'off',
    teachingConfirmRequested: true,
    teachingConfirmInteractive: false,
    llmProvider: createMockLlmProvider(),
    modelId: 'test-model',
    emitTeachingMeta: (meta) => { metaCalls.push(meta); },
    runId: 'run-8',
    sessionKey: 'session-8',
    deviceLabel: 'board',
    familyIsRdk: false,
    waitTeachingConfirm: async () => false,
    classifyPlanMutation: () => true,
  });

  const mockTool1 = makeMockTool('shell_exec', 'mutation');
  const mockTool2 = makeMockTool('write_file', 'mutation');

  await hooks.onBeforeToolExec({ tool: mockTool1, input: { cmd: 'ls' }, sessionKey: 'session-8' });
  await hooks.onBeforeToolExec({ tool: mockTool2, input: { path: '/tmp/f' }, sessionKey: 'session-8' });

  const dryRunMetas = metaCalls.filter(m => m.phase === 'dry_run_summary');
  assert.equal(dryRunMetas.length, 1, 'dry_run_summary should be emitted only once');
}

// ── createStudioTeachingHooks: dry_run not emitted for read-only tools ──

{
  // dry_run_summary is NOT emitted when the first tool is read-only
  const metaCalls = [];
  const hooks = createStudioTeachingHooks({
    depth: 'off',
    teachingConfirmRequested: true,
    teachingConfirmInteractive: false,
    llmProvider: createMockLlmProvider(),
    modelId: 'test-model',
    emitTeachingMeta: (meta) => { metaCalls.push(meta); },
    runId: 'run-9',
    sessionKey: 'session-9',
    deviceLabel: 'board',
    familyIsRdk: false,
    waitTeachingConfirm: async () => false,
    classifyPlanMutation: () => false, // all read-only
  });

  const mockTool = makeMockTool('read_file', 'readonly');
  await hooks.onBeforeToolExec({ tool: mockTool, input: { path: '/tmp/x' }, sessionKey: 'session-9' });

  const dryRunMetas = metaCalls.filter(m => m.phase === 'dry_run_summary');
  assert.equal(dryRunMetas.length, 0, 'dry_run_summary should NOT be emitted for read-only tools');
}

// ── createStudioTeachingHooks: emitTeachingMeta receives correct shape ──

{
  // dry_run_summary patch contains expected keys
  const metaCalls = [];
  const hooks = createStudioTeachingHooks({
    depth: 'off',
    teachingConfirmRequested: true,
    teachingConfirmInteractive: false,
    llmProvider: createMockLlmProvider(),
    modelId: 'test-model',
    emitTeachingMeta: (meta) => { metaCalls.push(meta); },
    runId: 'run-10',
    sessionKey: 'session-10',
    deviceLabel: 'my-rdk-board',
    familyIsRdk: true,
    waitTeachingConfirm: async () => false,
    classifyPlanMutation: () => true,
  });

  const mockTool = makeMockTool('shell_exec', 'mutation');
  await hooks.onBeforeToolExec({ tool: mockTool, input: { cmd: 'echo hi' }, sessionKey: 'session-10' });

  const dryRun = metaCalls.find(m => m.phase === 'dry_run_summary');
  assert.ok(dryRun, 'dry_run_summary should exist');
  assert.ok(dryRun.patch, 'dry_run_summary should have patch');
  assert.equal(typeof dryRun.patch.device, 'string');
  assert.equal(typeof dryRun.patch.scope, 'string');
  assert.equal(typeof dryRun.patch.rollback, 'string');
  assert.equal(typeof dryRun.patch.duration, 'string');
  assert.equal(typeof dryRun.patch.risk, 'string');
  assert.equal(dryRun.v, 1);
  assert.equal(dryRun.streamDone, true);
}

// ── createStudioTeachingHooks: classifyPlanMutation used for rollback hint ──

{
  // When classifyPlanMutation returns false, dry_run rollback says "N/A (read-only)"
  const metaCalls = [];
  const hooks = createStudioTeachingHooks({
    depth: 'off',
    teachingConfirmRequested: true,
    teachingConfirmInteractive: false,
    llmProvider: createMockLlmProvider(),
    modelId: 'test-model',
    emitTeachingMeta: (meta) => { metaCalls.push(meta); },
    runId: 'run-11',
    sessionKey: 'session-11',
    deviceLabel: 'board',
    familyIsRdk: false,
    waitTeachingConfirm: async () => false,
    classifyPlanMutation: (name) => name === 'deploy',
  });

  // read_file is NOT a mutation per classifyPlanMutation
  const mockTool = makeMockTool('read_file', 'readonly');
  await hooks.onBeforeToolExec({ tool: mockTool, input: { path: '/x' }, sessionKey: 'session-11' });

  // No dry_run because read_file is not a mutation and classifyPlanMutation returns false
  const dryRuns = metaCalls.filter(m => m.phase === 'dry_run_summary');
  assert.equal(dryRuns.length, 0, 'read-only should not trigger dry_run');

  // Now call deploy which IS a mutation
  const deployTool = makeMockTool('deploy', 'mutation');
  await hooks.onBeforeToolExec({ tool: deployTool, input: { env: 'prod' }, sessionKey: 'session-11' });

  const dryRun = metaCalls.find(m => m.phase === 'dry_run_summary');
  assert.ok(dryRun, 'mutation tool should trigger dry_run');
  // The heuristic rollback for mutation should mention review
  assert.ok(dryRun.patch.rollback.includes('review') || dryRun.patch.rollback.includes('Depends'),
    `mutation rollback should mention review/depends, got: ${dryRun.patch.rollback}`);
}

// ── createStudioTeachingHooks: teachingConfirmRequested+interactive blocks ──

{
  // When teachingConfirmRequested and teachingConfirmInteractive are both true,
  // onBeforeToolExec awaits waitTeachingConfirm
  let confirmWasCalled = false;
  let confirmTokenReceived = null;
  const metaCalls = [];

  const hooks = createStudioTeachingHooks({
    depth: 'off',
    teachingConfirmRequested: true,
    teachingConfirmInteractive: true,
    llmProvider: createMockLlmProvider(),
    modelId: 'test-model',
    emitTeachingMeta: (meta) => { metaCalls.push(meta); },
    runId: 'run-12',
    sessionKey: 'session-12',
    deviceLabel: 'board',
    familyIsRdk: false,
    waitTeachingConfirm: async (token) => {
      confirmWasCalled = true;
      confirmTokenReceived = token;
      return true; // user approves
    },
    classifyPlanMutation: () => true,
  });

  const mockTool = makeMockTool('shell_exec', 'mutation');
  const decision = await hooks.onBeforeToolExec({
    tool: mockTool,
    input: { cmd: 'ls' },
    sessionKey: 'session-12',
  });

  assert.deepEqual(decision, { approved: true });
  assert.equal(confirmWasCalled, true, 'waitTeachingConfirm should be called in interactive mode');
  assert.ok(typeof confirmTokenReceived === 'string' && confirmTokenReceived.length > 0,
    'confirm token should be a non-empty string');

  const dryRun = metaCalls.find(m => m.phase === 'dry_run_summary');
  assert.equal(dryRun?.awaitingConfirm, true, 'should be awaiting confirm in interactive mode');
  assert.ok(typeof dryRun?.confirmToken === 'string', 'confirmToken should be a string in interactive mode');
}

{
  // When user rejects in interactive confirm, returns { approved: false }
  const hooks = createStudioTeachingHooks({
    depth: 'off',
    teachingConfirmRequested: true,
    teachingConfirmInteractive: true,
    llmProvider: createMockLlmProvider(),
    modelId: 'test-model',
    emitTeachingMeta: () => {},
    runId: 'run-13',
    sessionKey: 'session-13',
    deviceLabel: 'board',
    familyIsRdk: false,
    waitTeachingConfirm: async () => false, // user rejects
    classifyPlanMutation: () => true,
  });

  const mockTool = makeMockTool('shell_exec', 'mutation');
  const decision = await hooks.onBeforeToolExec({
    tool: mockTool,
    input: { cmd: 'rm -rf /' },
    sessionKey: 'session-13',
  });

  assert.equal(decision.approved, false);
  assert.ok(decision.reason?.includes('User stopped') || decision.reason?.includes('teaching confirm'),
    `rejection reason should mention user stop, got: ${decision.reason}`);
}

// ── createStudioTeachingHooks: onToolResult with error ──

{
  // onToolResult should handle error results without throwing
  const hooks = createStudioTeachingHooks({
    depth: 'concise',
    teachingConfirmRequested: false,
    teachingConfirmInteractive: false,
    llmProvider: createMockLlmProvider(),
    modelId: 'test-model',
    emitTeachingMeta: () => {},
    runId: 'run-14',
    sessionKey: 'session-14',
    deviceLabel: 'board',
    familyIsRdk: false,
    waitTeachingConfirm: async () => false,
    classifyPlanMutation: () => true,
  });

  // Should not throw even with error result
  hooks.onToolResult(
    { id: 'call-14', name: 'shell_exec', input: { cmd: 'bad-cmd' } },
    { toolUseId: 'call-14', content: 'command not found', isError: true },
  );
  // No assertion — just verifying it doesn't throw
}

// ── Helper functions ──

function createMockLlmProvider() {
  return {
    id: 'mock-provider',
    displayName: 'Mock Provider',
    complete: async () => ({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: '{}' }],
    }),
    stream: async () => ({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: '{}' }],
    }),
  };
}

function makeMockTool(name, sideEffectClass) {
  return {
    name,
    description: `Mock ${name} tool`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
    metadata: {
      sideEffectClass,
    },
    execute: async () => 'mock result',
  };
}

console.log('All teaching-layer checks passed.');
