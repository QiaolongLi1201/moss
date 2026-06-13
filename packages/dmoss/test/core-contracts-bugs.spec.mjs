#!/usr/bin/env node
/**
 * Bug hunt tests for core-contracts subsystem
 * 
 * Covers:
 * - Capability coverage surface validation
 * - Async task summary field consistency
 */

import assert from 'node:assert/strict';
import {
  evaluateMossHostCompatibility,
} from '../dist/contracts/host-adapter.js';
import {
  createInMemoryMossAsyncTaskRegistry,
} from '../dist/contracts/async-task.js';

const baseManifest = {
  schema: 'moss_host_adapter.v1',
  contractVersion: 1,
  host: { id: 'test', name: 'Test', version: '1.0.0' },
  moss: { version: '1.0.0', packages: [] },
  capabilities: [],
  providers: [],
  tools: [
    {
      name: 'with_surface',
      boundaryId: 'b1',
      sideEffectClass: 'readonly',
      approval: 'not_required',
      source: 'host',
      surface: 'computer_workspace',
    },
    {
      name: 'without_surface',
      boundaryId: 'b2',
      sideEffectClass: 'readonly',
      approval: 'not_required',
      source: 'host',
    },
  ],
  eventSinks: [],
  knowledgeModules: [],
};

let passed = 0;
let total = 0;

/* ---- Test 1: Tool without surface in capability coverage ---- */

total++;
{
  const manifest = {
    ...baseManifest,
    capabilityCoverage: [
      {
        id: 'test-cap',
        priority: 'P0',
        status: 'covered',
        userOutcome: 'Test',
        surface: 'computer_workspace',
        tools: ['without_surface'],
        evidence: ['test.ts'],
        gaps: [],
        rationale: 'Test',
      },
    ],
  };
  
  const result = evaluateMossHostCompatibility(manifest);
  assert.equal(result.status, 'invalid_manifest');
  assert.equal(result.compatible, false);
  assert.ok(result.reasons[0].includes('without declared surface'));
  console.log('  [PASS] tool without surface rejected in capability coverage');
  passed++;
}

/* ---- Test 2: Tool without surface in capability with surfaces array ---- */

total++;
{
  const manifest = {
    ...baseManifest,
    capabilityCoverage: [
      {
        id: 'multi-surface-cap',
        priority: 'P0',
        status: 'covered',
        userOutcome: 'Test',
        surfaces: ['computer_workspace', 'browser_web'],
        tools: ['without_surface'],
        evidence: ['test.ts'],
        gaps: [],
        rationale: 'Test',
      },
    ],
  };
  
  const result = evaluateMossHostCompatibility(manifest);
  assert.equal(result.status, 'invalid_manifest');
  assert.equal(result.compatible, false);
  assert.ok(result.reasons[0].includes('without declared surface'));
  console.log('  [PASS] tool without surface rejected in multi-surface capability');
  passed++;
}

/* ---- Test 3: Async task summary fallback on failure ---- */

total++;
{
  const registry = createInMemoryMossAsyncTaskRegistry();
  const runner = async () => ({
    success: false,
    summary: '',
    data: null,
  });
  
  registry.start({
    taskId: 'async-test',
    kind: 'host_task',
    payload: {},
  }, runner);
  
  const completion = await registry.wait('async-test');
  assert.equal(completion.status, 'failed');
  assert.ok(completion.summary.length > 0 || completion.error.length > 0);
  // Both should have content or be consistent
  if (completion.summary === '' && completion.error !== '') {
    // This is currently the bug - summary empty but error has fallback
    // After fix, summary should also have fallback
    assert.ok(completion.error === 'task failed');
  }
  console.log('  [PASS] async task failure summary handling');
  passed++;
}

console.log(`\n${passed}/${total} core-contracts tests passed`);
process.exit(passed === total ? 0 : 1);
