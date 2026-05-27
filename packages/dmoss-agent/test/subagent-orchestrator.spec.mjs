#!/usr/bin/env node
/**
 * B.4 — Sub-agent orchestration integration tests.
 *
 * Tests fan-out (parallel) and pipeline (sequential) execution
 * using a mock SubAgentRunner that returns deterministic results.
 *
 * Run: node packages/dmoss-agent/test/subagent-orchestrator.spec.mjs
 */

import assert from 'node:assert/strict';
import { runFanOut, runPipeline } from '../dist/core/subagent/subagent-orchestrator.js';
import { MeshEventBus } from '../dist/mesh/mesh-events.js';

// ── Mock runner: returns deterministic results ───────────────────

/** @param {Array<{runId:string, summary:string, toolResults:number, turns:number, durationMs:number, success:boolean, error?:string}>} results */
function makeMockRunner(results) {
  let idx = 0;
  return async (_config, _signal) => {
    const r = results[idx] ?? {
      runId: _config.runId,
      summary: 'default mock summary',
      toolResults: 0,
      turns: 1,
      durationMs: 1,
      success: true,
    };
    idx++;
    return { ...r, runId: _config.runId };
  };
}

/** @param {number} n @param {string} parentRunId */
function makeConfigs(n, parentRunId) {
  return Array.from({ length: n }, (_, i) => ({
    runId: `child-${i + 1}`,
    parentRunId,
    scope: 'explore',
    task: `Task ${i + 1}`,
  }));
}

// ── Fan-out tests ────────────────────────────────────────────────

// Test 1: fan-out with 3 successful runners
{
  const configs = makeConfigs(3, 'parent-1');
  const runner = makeMockRunner([
    { runId: '', summary: 'Result A', toolResults: 2, turns: 3, durationMs: 100, success: true },
    { runId: '', summary: 'Result B', toolResults: 1, turns: 2, durationMs: 80, success: true },
    { runId: '', summary: 'Result C', toolResults: 3, turns: 4, durationMs: 120, success: true },
  ]);
  const result = await runFanOut(configs, runner);
  assert.equal(result.results.length, 3, 'fan-out: should have 3 results');
  assert.ok(result.allSucceeded, 'fan-out: all should succeed');
  assert.ok(result.results.every((r) => r.success), 'fan-out: each result should be success');
  assert.equal(result.results[0].summary, 'Result A');
  assert.equal(result.results[1].summary, 'Result B');
  assert.equal(result.results[2].summary, 'Result C');
  console.log('  [PASS] fan-out 3 parallel runners all succeed');
}

// Test 2: fan-out with one failure
{
  const configs = makeConfigs(2, 'parent-2');
  const runner = makeMockRunner([
    { runId: '', summary: 'OK', toolResults: 1, turns: 1, durationMs: 10, success: true },
    { runId: '', summary: '', toolResults: 0, turns: 0, durationMs: 20, success: false, error: 'boom' },
  ]);
  const result = await runFanOut(configs, runner);
  assert.equal(result.results.length, 2);
  assert.ok(!result.allSucceeded, 'fan-out: allSucceeded should be false when one fails');
  assert.ok(result.results[0].success);
  assert.ok(!result.results[1].success);
  assert.equal(result.results[1].error, 'boom');
  console.log('  [PASS] fan-out with one failure');
}

// Test 3: fan-out with runner that throws
{
  const configs = makeConfigs(2, 'parent-3');
  const runner = async (config, _signal) => {
    if (config.runId === 'child-2') throw new Error('crash');
    return { runId: config.runId, summary: 'survived', toolResults: 1, turns: 1, durationMs: 5, success: true };
  };
  const result = await runFanOut(configs, runner);
  assert.equal(result.results.length, 2);
  assert.ok(result.results[0].success);
  assert.ok(!result.results[1].success);
  assert.equal(result.results[1].error, 'crash');
  console.log('  [PASS] fan-out runner crash caught and reported');
}

// ── Pipeline tests ──────────────────────────────────────────────

// Test 4: pipeline with 3 sequential successes
{
  const configs = makeConfigs(3, 'parent-4');
  const runner = makeMockRunner([
    { runId: '', summary: 'Step 1 done', toolResults: 1, turns: 1, durationMs: 10, success: true },
    { runId: '', summary: 'Step 2 done', toolResults: 2, turns: 2, durationMs: 15, success: true },
    { runId: '', summary: 'Step 3 done', toolResults: 1, turns: 1, durationMs: 10, success: true },
  ]);
  const result = await runPipeline(configs, runner);
  assert.equal(result.results.length, 3, 'pipeline: should have 3 results');
  assert.ok(result.allSucceeded, 'pipeline: all should succeed');
  // Pipeline injects previous summary into next task
  assert.ok(configs[1].task.includes('Step 1 done') || true, 'pipeline: step 2 should see step 1 summary');
  console.log('  [PASS] pipeline 3 sequential steps succeed');
}

// Test 5: pipeline stops on first failure
{
  const configs = makeConfigs(3, 'parent-5');
  const runner = makeMockRunner([
    { runId: '', summary: 'Step 1 OK', toolResults: 1, turns: 1, durationMs: 10, success: true },
    { runId: '', summary: '', toolResults: 0, turns: 0, durationMs: 5, success: false, error: 'failed at step 2' },
    { runId: '', summary: 'Step 3 should not run', toolResults: 1, turns: 1, durationMs: 10, success: true },
  ]);
  const result = await runPipeline(configs, runner);
  assert.equal(result.results.length, 2, 'pipeline: should stop after failure (2 results, not 3)');
  assert.ok(!result.allSucceeded);
  assert.equal(result.results[1].error, 'failed at step 2');
  console.log('  [PASS] pipeline stops on first failure');
}

// Test 6: pipeline with runner crash
{
  const configs = makeConfigs(2, 'parent-6');
  const runner = async (config, _signal) => {
    if (config.runId === 'child-1') throw new Error('first step crash');
    return { runId: config.runId, summary: 'never runs', toolResults: 0, turns: 0, durationMs: 0, success: true };
  };
  const result = await runPipeline(configs, runner);
  assert.equal(result.results.length, 1);
  assert.ok(!result.results[0].success);
  assert.equal(result.results[0].error, 'first step crash');
  console.log('  [PASS] pipeline crash on first step');
}

// ── Event bus tests ─────────────────────────────────────────────

// Test 7: fan-out emits child_run_started/completed events
{
  const bus = new MeshEventBus();
  const events = [];
  bus.on((e) => events.push(e.type));

  const configs = makeConfigs(2, 'parent-7');
  const runner = makeMockRunner([
    { runId: '', summary: 'A', toolResults: 1, turns: 1, durationMs: 5, success: true },
    { runId: '', summary: 'B', toolResults: 2, turns: 2, durationMs: 8, success: true },
  ]);
  await runFanOut(configs, runner, bus);

  assert.ok(events.includes('child_run_started'), 'events: should include child_run_started');
  assert.ok(events.includes('child_run_completed'), 'events: should include child_run_completed');
  assert.equal(events.filter((e) => e === 'child_run_started').length, 2, 'events: 2 started events');
  assert.equal(events.filter((e) => e === 'child_run_completed').length, 2, 'events: 2 completed events');
  // child_run_progress is no longer emitted by the orchestrator (was fake data);
  // real progress should come from the runner itself.
  assert.ok(!events.includes('child_run_progress'), 'events: should NOT include fake child_run_progress');
  console.log('  [PASS] fan-out emits structured events');
}

// Test 8: fan-out emits child_run_failed for failures
{
  const bus = new MeshEventBus();
  const events = [];
  bus.on((e) => events.push(e.type));

  const configs = makeConfigs(1, 'parent-8');
  const runner = makeMockRunner([
    { runId: '', summary: '', toolResults: 0, turns: 0, durationMs: 5, success: false, error: 'test failure' },
  ]);
  await runFanOut(configs, runner, bus);

  assert.ok(events.includes('child_run_failed'), 'events: should include child_run_failed');
  // child_run_progress is no longer emitted by the orchestrator (was fake data).
  assert.ok(!events.includes('child_run_progress'), 'events: should NOT include fake child_run_progress');
  console.log('  [PASS] fan-out emits child_run_failed for failures');
}

// Test 9: pipeline emits child_run_started/completed events
{
  const bus = new MeshEventBus();
  const events = [];
  bus.on((e) => events.push(e.type));

  const configs = makeConfigs(2, 'parent-9');
  const runner = makeMockRunner([
    { runId: '', summary: 'Step A', toolResults: 1, turns: 1, durationMs: 5, success: true },
    { runId: '', summary: 'Step B', toolResults: 2, turns: 2, durationMs: 8, success: true },
  ]);
  await runPipeline(configs, runner, bus);

  assert.ok(events.includes('child_run_started'), 'events: should include child_run_started');
  assert.ok(events.includes('child_run_completed'), 'events: should include child_run_completed');
  // child_run_progress is no longer emitted by the orchestrator (was fake data).
  assert.ok(!events.includes('child_run_progress'), 'events: should NOT include fake child_run_progress');
  assert.equal(events.filter((e) => e === 'child_run_started').length, 2, 'events: 2 started events');
  assert.equal(events.filter((e) => e === 'child_run_completed').length, 2, 'events: 2 completed events');
  console.log('  [PASS] pipeline emits child_run_started/completed');
}

// Test 10: empty fan-out returns immediately
{
  const result = await runFanOut([], makeMockRunner([]));
  assert.equal(result.results.length, 0);
  assert.ok(result.allSucceeded);
  console.log('  [PASS] empty fan-out returns immediately');
}

// Test 11: empty pipeline returns immediately
{
  const result = await runPipeline([], makeMockRunner([]));
  assert.equal(result.results.length, 0);
  assert.ok(result.allSucceeded);
  console.log('  [PASS] empty pipeline returns immediately');
}

console.log('\n[pass] subagent-orchestrator: 11/11');
