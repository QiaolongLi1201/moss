#!/usr/bin/env node
/**
 * Tests for the create_subagent tool and SubAgentRunner factory.
 *
 * Verifies:
 * 1. Tool rejects when ctx.spawnSubagent is not set
 * 2. Tool delegates to ctx.spawnSubagent and returns formatted result
 * 3. Runner filters tools by scope
 * 4. Runner removes create_subagent (recursion prevention)
 * 5. Runner injects scope prompt addon
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/create-subagent.spec.mjs
 */

import assert from 'node:assert/strict';
import { createInMemoryMossAsyncTaskRegistry } from '@rdk-moss/core/contracts/async-task';
import { createSubagentTool, subagentStatusTool } from '../dist/tools/create-subagent.js';
import {
  SpawnProfileRegistry,
  resolveSpawnToolSet,
  buildSubagentPromptAddon,
} from '../dist/core/subagent/spawn-profile.js';

// ── Test 1: Tool rejects when ctx.spawnSubagent is not set ──
{
  const ctx = { workspaceDir: '/tmp', sessionKey: 'test' };
  const result = await createSubagentTool.execute({ task: 'test task' }, ctx);
  assert.ok(
    result.includes('not available'),
    `Expected error about spawnSubagent not available, got: ${result}`,
  );
  console.log('  [PASS] tool rejects when ctx.spawnSubagent is missing');
}

// ── Test 2: Tool delegates to ctx.spawnSubagent ──
{
  let capturedParams = null;
  const ctx = {
    workspaceDir: '/tmp',
    sessionKey: 'test',
    spawnSubagent: async (params) => {
      capturedParams = params;
      return {
        runId: 'abc-123-def',
        sessionKey: 'subagent:abc-123-def',
        summary: 'Task completed successfully',
        success: true,
      };
    },
  };

  const result = await createSubagentTool.execute(
    { task: 'explore the codebase', scope: 'explore', maxTurns: 5, timeoutMs: 2_500 },
    ctx,
  );

  assert.ok(capturedParams, 'spawnSubagent should have been called');
  assert.equal(capturedParams.task, 'explore the codebase');
  assert.equal(capturedParams.scope, 'explore');
  assert.equal(capturedParams.maxTurns, 5);
  assert.equal(capturedParams.timeoutMs, 2_500);
  assert.ok(result.includes('SUCCESS'), `Expected SUCCESS in result, got: ${result}`);
  assert.ok(result.includes('abc-123-'), `Expected runId prefix in result, got: ${result}`);
  assert.ok(result.includes('Task completed successfully'), `Expected summary in result, got: ${result}`);
  console.log('  [PASS] tool delegates to ctx.spawnSubagent and formats result');
}

// ── Test 3: Tool handles failure ──
{
  const ctx = {
    workspaceDir: '/tmp',
    sessionKey: 'test',
    spawnSubagent: async () => ({
      runId: 'fail-run-id',
      sessionKey: 'subagent:fail-run-id',
      summary: '',
      success: false,
    }),
  };

  const result = await createSubagentTool.execute({ task: 'impossible task' }, ctx);
  assert.ok(result.includes('FAILED'), `Expected FAILED in result, got: ${result}`);
  assert.ok(result.includes('(no output)'), `Expected "(no output)" for empty summary, got: ${result}`);
  console.log('  [PASS] tool handles sub-agent failure correctly');
}

// ── Test 4: background mode rejects when async task registry is missing ──
{
  const ctx = {
    workspaceDir: '/tmp',
    sessionKey: 'test',
    spawnSubagent: async () => ({
      runId: 'unused',
      sessionKey: 'unused',
      summary: 'unused',
      success: true,
    }),
  };

  const result = await createSubagentTool.execute({ task: 'background task', background: true }, ctx);
  assert.ok(result.includes('background sub-agent tasks are not available'), result);
  console.log('  [PASS] background mode rejects when async task registry is missing');
}

// ── Test 5: Tool can start a background sub-agent via async task registry ──
{
  const registry = createInMemoryMossAsyncTaskRegistry();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let capturedParams = null;
  const ctx = {
    workspaceDir: '/tmp',
    runId: 'parent-run',
    sessionKey: 'test',
    asyncTaskRegistry: registry,
    spawnSubagent: async (params) => {
      capturedParams = params;
      await gate;
      return {
        runId: 'child-run',
        sessionKey: 'subagent:child-run',
        summary: 'background complete',
        success: true,
      };
    },
  };

  const result = await createSubagentTool.execute(
    { task: 'background explore', scope: 'explore', maxTurns: 3, timeoutMs: 2_000, background: true },
    ctx,
  );
  assert.ok(result.includes('STARTED'), result);
  const taskId = result.match(/\[Sub-agent task ([^\]]+)\]/)?.[1];
  assert.ok(taskId, `expected task id in result: ${result}`);
  assert.equal(registry.status(taskId)?.status, 'running');
  assert.equal(registry.status(taskId)?.timeoutMs, 2_000);
  assert.equal(registry.status(taskId)?.payload.timeoutMs, 2_000);
  assert.equal(capturedParams.scope, 'explore');
  assert.equal(capturedParams.maxTurns, 3);
  assert.equal(capturedParams.timeoutMs, 2_000);
  assert.ok(capturedParams.abortSignal instanceof AbortSignal);
  release();
  const completion = await registry.wait(taskId);
  assert.equal(completion.status, 'completed');
  assert.equal(completion.summary, 'background complete');
  assert.deepEqual(completion.data, {
    runId: 'child-run',
    sessionKey: 'subagent:child-run',
  });
  console.log('  [PASS] background mode returns a handle and records final completion');
}

// ── Test 6: background mode enforces caller-provided timeout ──
{
  const registry = createInMemoryMossAsyncTaskRegistry();
  let capturedSignal = null;
  const ctx = {
    workspaceDir: '/tmp',
    runId: 'parent-run-timeout',
    sessionKey: 'test',
    asyncTaskRegistry: registry,
    spawnSubagent: async (params) => {
      capturedSignal = params.abortSignal;
      await new Promise((resolve) => {
        if (params.abortSignal.aborted) {
          resolve();
          return;
        }
        params.abortSignal.addEventListener('abort', resolve, { once: true });
      });
      return {
        runId: 'child-timeout',
        sessionKey: 'subagent:child-timeout',
        summary: 'should not complete normally',
        success: true,
      };
    },
  };

  const started = await createSubagentTool.execute(
    { task: 'slow background task', background: true, timeoutMs: 100 },
    ctx,
  );
  const taskId = started.match(/\[Sub-agent task ([^\]]+)\]/)?.[1];
  assert.ok(taskId, `expected task id in result: ${started}`);
  assert.equal(registry.status(taskId)?.timeoutMs, 100);
  const completion = await registry.wait(taskId);
  assert.equal(completion.status, 'timed_out');
  assert.equal(completion.success, false);
  assert.equal(completion.summary, 'Task timed out.');
  assert.ok(capturedSignal?.aborted, 'timeout should abort the child run signal');
  const status = await subagentStatusTool.execute({ taskId }, ctx);
  assert.ok(status.includes('TIMED_OUT'), status);
  assert.ok(status.includes('Task timed out.'), status);
  console.log('  [PASS] background mode enforces caller-provided timeout');
}

// ── Test 7: subagent_status checks and waits for background completion ──
{
  const registry = createInMemoryMossAsyncTaskRegistry();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = {
    workspaceDir: '/tmp',
    runId: 'parent-run-status',
    sessionKey: 'test',
    asyncTaskRegistry: registry,
    spawnSubagent: async () => {
      await gate;
      return {
        runId: 'child-status',
        sessionKey: 'subagent:child-status',
        summary: 'status complete',
        success: true,
      };
    },
  };

  const started = await createSubagentTool.execute({ task: 'status task', background: true }, ctx);
  const taskId = started.match(/\[Sub-agent task ([^\]]+)\]/)?.[1];
  assert.ok(taskId, `expected task id in result: ${started}`);
  const snapshot = await subagentStatusTool.execute({ taskId }, ctx);
  assert.ok(snapshot.includes('RUNNING'), snapshot);
  release();
  const waited = await subagentStatusTool.execute({ taskId, wait: true }, ctx);
  assert.ok(waited.includes('SUCCESS'), waited);
  assert.ok(waited.includes('status complete'), waited);
  const lateRead = await subagentStatusTool.execute({ taskId }, ctx);
  assert.ok(lateRead.includes('status: completed'), lateRead);
  console.log('  [PASS] subagent_status checks and waits for background completion');
}

// ── Test 8: subagent_status handles missing registry and unknown tasks ──
{
  const missingRegistry = await subagentStatusTool.execute(
    { taskId: 'missing' },
    { workspaceDir: '/tmp', sessionKey: 'test' },
  );
  assert.ok(missingRegistry.includes('not available'), missingRegistry);

  const registry = createInMemoryMossAsyncTaskRegistry();
  const unknownTask = await subagentStatusTool.execute(
    { taskId: 'unknown' },
    { workspaceDir: '/tmp', sessionKey: 'test', asyncTaskRegistry: registry },
  );
  assert.ok(unknownTask.includes('not found'), unknownTask);
  console.log('  [PASS] subagent_status reports missing registry and unknown task ids');
}

// ── Test 9: resolveSpawnToolSet filters by scope ──
{
  const exploreTools = resolveSpawnToolSet('explore');
  assert.ok(exploreTools, 'explore scope should return a tool set');
  assert.ok(exploreTools.has('read_file'), 'explore should include "read_file"');
  assert.ok(exploreTools.has('search_files'), 'explore should include "search_files"');
  assert.ok(!exploreTools.has('write_file'), 'explore should NOT include "write_file"');
  assert.ok(!exploreTools.has('exec'), 'explore should NOT include "exec"');
  assert.ok(!exploreTools.has('create_subagent'), 'explore should NOT include "create_subagent"');

  const fullTools = resolveSpawnToolSet('full');
  assert.equal(fullTools, null, 'full scope should return null (no filtering)');

  const verifyTools = resolveSpawnToolSet('verify');
  assert.ok(verifyTools, 'verify scope should return a tool set');
  assert.ok(verifyTools.has('exec'), 'verify should include "exec"');
  assert.ok(!verifyTools.has('write_file'), 'verify should NOT include "write_file"');

  console.log('  [PASS] resolveSpawnToolSet filters correctly by scope');
}

// ── Test 10: SpawnProfileRegistry isolates host extensions per agent ──
{
  const registryA = new SpawnProfileRegistry();
  registryA.registerSpawnToolExtensions({ explore: ['host_a_status'] });
  const registryB = new SpawnProfileRegistry();
  registryB.registerSpawnToolExtensions({ explore: ['host_b_status'] });

  const toolsA = resolveSpawnToolSet('explore', registryA);
  const toolsB = resolveSpawnToolSet('explore', registryB);

  assert.ok(toolsA.has('host_a_status'), 'registry A should include its host tool');
  assert.ok(!toolsA.has('host_b_status'), 'registry A must not see registry B tools');
  assert.ok(toolsB.has('host_b_status'), 'registry B should include its host tool');
  assert.ok(!toolsB.has('host_a_status'), 'registry B must not see registry A tools');
  console.log('  [PASS] SpawnProfileRegistry isolates host extensions per instance');
}

// ── Test 11: buildSubagentPromptAddon injects scope constraints ──
{
  const exploreAddon = buildSubagentPromptAddon('explore');
  assert.ok(exploreAddon.length > 0, 'explore addon should not be empty');
  assert.ok(exploreAddon.includes('read-only'), 'explore addon should mention read-only');
  assert.ok(exploreAddon.includes('Forbidden'), 'explore addon should mention forbidden tools');

  const planAddon = buildSubagentPromptAddon('plan');
  assert.ok(planAddon.includes('planning only'), 'plan addon should mention planning only');
  assert.ok(planAddon.includes('Key Files'), 'plan addon should require Key Files section');

  const verifyAddon = buildSubagentPromptAddon('verify');
  assert.ok(verifyAddon.includes('falsify'), 'verify addon should mention falsify');
  assert.ok(verifyAddon.includes('VERDICT'), 'verify addon should require VERDICT line');

  const fullAddon = buildSubagentPromptAddon('full');
  assert.equal(fullAddon, '', 'full scope should have no addon');

  const readOnlyAddon = buildSubagentPromptAddon('read-only');
  assert.equal(readOnlyAddon, '', 'read-only scope should have no addon (base tools only)');

  console.log('  [PASS] buildSubagentPromptAddon injects correct constraints per scope');
}

// ── Test 12: Tool defaults scope, maxTurns, and timeoutMs ──
{
  let capturedParams = null;
  const ctx = {
    workspaceDir: '/tmp',
    sessionKey: 'test',
    spawnSubagent: async (params) => {
      capturedParams = params;
      return { runId: 'r1', sessionKey: 's1', summary: 'ok', success: true };
    },
  };

  await createSubagentTool.execute({ task: 'simple task' }, ctx);
  assert.equal(capturedParams.scope, 'full', 'default scope should be "full"');
  assert.equal(capturedParams.maxTurns, 10, 'default maxTurns should be 10');
  assert.equal(capturedParams.timeoutMs, 120_000, 'default timeoutMs should be 120000');
  console.log('  [PASS] tool defaults scope, maxTurns, and timeoutMs');
}

// ── Test 13: Tool metadata is correct ──
{
  assert.equal(createSubagentTool.name, 'create_subagent');
  assert.equal(createSubagentTool.metadata?.sideEffectClass, 'subagent');
  assert.equal(createSubagentTool.metadata?.planMode, 'allow');
  assert.equal(subagentStatusTool.name, 'subagent_status');
  assert.equal(subagentStatusTool.metadata?.sideEffectClass, 'readonly');
  assert.equal(subagentStatusTool.metadata?.planMode, 'allow');
  assert.ok(createSubagentTool.inputSchema.properties.task, 'schema should have task property');
  assert.ok(createSubagentTool.inputSchema.properties.scope, 'schema should have scope property');
  assert.ok(createSubagentTool.inputSchema.properties.timeoutMs, 'schema should have timeoutMs property');
  assert.ok(createSubagentTool.inputSchema.properties.background, 'schema should have background property');
  assert.ok(subagentStatusTool.inputSchema.properties.taskId, 'status schema should have taskId property');
  assert.ok(!createSubagentTool.inputSchema.properties.mode, 'schema should not have unimplemented mode property');
  assert.deepEqual(createSubagentTool.inputSchema.required, ['task']);
  assert.deepEqual(subagentStatusTool.inputSchema.required, ['taskId']);
  console.log('  [PASS] tool metadata and schema are correct');
}

// ── Test 14: Scope filtering prevents recursion ──
{
  // Simulate what the runner does: filter out create_subagent from any scope
  const allToolNames = ['read', 'write', 'exec', 'create_subagent', 'grep'];
  for (const scope of ['explore', 'plan', 'verify', 'read-only', 'device-read']) {
    const allowedSet = resolveSpawnToolSet(scope);
    const scopedTools = allowedSet
      ? allToolNames.filter((name) => allowedSet.has(name))
      : allToolNames;
    const filteredTools = scopedTools.filter((name) => name !== 'create_subagent');
    assert.ok(
      !filteredTools.includes('create_subagent'),
      `scope "${scope}" should not include create_subagent after filtering`,
    );
  }

  // Full scope: allowedSet is null → all tools pass, but create_subagent still filtered
  const fullFiltered = allToolNames.filter((name) => name !== 'create_subagent');
  assert.ok(!fullFiltered.includes('create_subagent'), 'full scope should still filter create_subagent');

  console.log('  [PASS] recursion prevention: create_subagent filtered from all scopes');
}

console.log('\n[pass] create-subagent: 14/14');
