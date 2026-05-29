#!/usr/bin/env node
/**
 * Conformance tests for the Moss Host Adapter contract.
 *
 * Covers all compatibility status outcomes plus edge cases for
 * contract negotiation, semantic versioning, empty requirements,
 * extra capabilities, and multiple missing items in a single report.
 *
 * Run: `node packages/dmoss/test/host-adapter-conformance.spec.mjs`
 * Exit 0 on pass; exit 1 on any assertion failure.
 */

import assert from 'node:assert/strict';
import {
  MOSS_HOST_ADAPTER_CONTRACT_VERSION,
  evaluateMossHostCompatibility,
} from '../dist/contracts/host-adapter.js';

/* ---- Shared fixture: a fully populated MossHostRuntimeManifest ---- */

const fixtureManifest = {
  schema: 'moss_host_adapter.v1',
  contractVersion: 1,
  host: {
    id: 'test-host',
    name: 'Test Host',
    version: '2.0.0',
  },
  moss: {
    version: '0.3.1',
    packages: [
      { name: '@rdk-moss/core', version: '0.3.1', stability: 'stable' },
    ],
  },
  capabilities: [
    { kind: 'llm_provider', version: '1.0.0', stability: 'stable', summary: 'LLM provider' },
    { kind: 'tool_registry', version: '1.0.0', stability: 'stable', summary: 'Tool registry' },
    { kind: 'event_sink', version: '1.0.0', stability: 'stable', summary: 'Event sink' },
    { kind: 'memory', version: '1.0.0', stability: 'evolving', summary: 'Memory runtime' },
  ],
  providers: [
    {
      id: 'openai',
      displayName: 'OpenAI',
      families: ['openai', 'gpt'],
      configuredByHost: true,
      streaming: true,
      toolCalling: true,
    },
    {
      id: 'anthropic',
      displayName: 'Anthropic',
      families: ['anthropic', 'claude'],
      configuredByHost: true,
      streaming: true,
      toolCalling: true,
    },
  ],
  tools: [
    {
      name: 'read_file',
      boundaryId: 'fs',
      sideEffectClass: 'readonly',
      approval: 'not_required',
      source: 'host',
    },
  ],
  eventSinks: [
    {
      id: 'main-sink',
      schemas: ['agent.thought', 'agent.action', 'agent.error'],
      supportsStreaming: true,
    },
  ],
  knowledgeModules: [
    { id: 'kb-main', version: '1.0.0', stability: 'stable' },
  ],
};

let passed = 0;
let total = 0;

/* ---- Test 1: MOSS_HOST_ADAPTER_CONTRACT_VERSION equals 1 ---- */

total++;
{
  assert.equal(MOSS_HOST_ADAPTER_CONTRACT_VERSION, 1);
  console.log('  [PASS] MOSS_HOST_ADAPTER_CONTRACT_VERSION === 1');
  passed++;
}

/* ---- Test 2: contract_mismatch — manifest.contractVersion != requirement ---- */

total++;
{
  const mismatchedManifest = { ...fixtureManifest, contractVersion: 99 };
  const result = evaluateMossHostCompatibility(mismatchedManifest, { contractVersion: 1 });
  assert.equal(result.status, 'contract_mismatch');
  assert.equal(result.compatible, false);
  assert.ok(result.reasons.length > 0, 'should have at least one reason');
  assert.ok(
    result.reasons[0].includes('v99'),
    'reason should mention manifest contract version',
  );
  console.log('  [PASS] contract_mismatch when contractVersion differs');
  passed++;
}

/* ---- Test 3: host_version_incompatible — host older than minHostVersion ---- */

total++;
{
  const oldHostManifest = {
    ...fixtureManifest,
    host: { ...fixtureManifest.host, version: '1.0.0' },
  };
  const result = evaluateMossHostCompatibility(oldHostManifest, { minHostVersion: '2.0.0' });
  assert.equal(result.status, 'host_version_incompatible');
  assert.equal(result.compatible, false);
  assert.ok(result.reasons[0].includes('older than required'));
  console.log('  [PASS] host_version_incompatible when host version too old');
  passed++;
}

/* ---- Test 4: missing_capability — required capability not in manifest ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, {
    requiredCapabilities: ['device_runtime', 'channel_runtime'],
  });
  assert.equal(result.status, 'missing_capability');
  assert.equal(result.compatible, false);
  assert.deepEqual(result.missingCapabilities, ['device_runtime', 'channel_runtime']);
  console.log('  [PASS] missing_capability when required kinds absent');
  passed++;
}

/* ---- Test 5: missing_event_schema — required schema not in manifest ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, {
    requiredEventSchemas: ['robot.telemetry', 'robot.status'],
  });
  assert.equal(result.status, 'missing_event_schema');
  assert.equal(result.compatible, false);
  assert.deepEqual(result.missingEventSchemas, ['robot.telemetry', 'robot.status']);
  console.log('  [PASS] missing_event_schema when required schemas absent');
  passed++;
}

/* ---- Test 6: missing_provider_family — required family not in manifest ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, {
    requiredProviderFamilies: ['gemini', 'llama'],
  });
  assert.equal(result.status, 'missing_provider_family');
  assert.equal(result.compatible, false);
  assert.deepEqual(result.missingProviderFamilies, ['gemini', 'llama']);
  console.log('  [PASS] missing_provider_family when required families absent');
  passed++;
}

/* ---- Test 7: ok — all checks pass with fully populated fixture ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, {
    minHostVersion: '1.5.0',
    requiredCapabilities: ['llm_provider', 'tool_registry'],
    requiredEventSchemas: ['agent.thought'],
    requiredProviderFamilies: ['openai'],
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.compatible, true);
  assert.equal(result.reasons.length, 0);
  assert.equal(result.missingCapabilities.length, 0);
  assert.equal(result.missingEventSchemas.length, 0);
  assert.equal(result.missingProviderFamilies.length, 0);
  console.log('  [PASS] ok when all requirements satisfied');
  passed++;
}

/* ---- Test 8: empty requirement always passes ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, {});
  assert.equal(result.status, 'ok');
  assert.equal(result.compatible, true);
  console.log('  [PASS] empty requirement passes against any valid manifest');
  passed++;
}

/* ---- Test 9: semver — "2.0.0" >= "1.5.0" passes ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, { minHostVersion: '1.5.0' });
  assert.equal(result.status, 'ok');
  assert.equal(result.compatible, true);
  console.log('  [PASS] semver: host 2.0.0 >= required 1.5.0 → ok');
  passed++;
}

/* ---- Test 10: semver — "1.0.0" >= "2.0.0" fails ---- */

total++;
{
  const oldManifest = {
    ...fixtureManifest,
    host: { ...fixtureManifest.host, version: '1.0.0' },
  };
  const result = evaluateMossHostCompatibility(oldManifest, { minHostVersion: '2.0.0' });
  assert.equal(result.status, 'host_version_incompatible');
  assert.equal(result.compatible, false);
  console.log('  [PASS] semver: host 1.0.0 < required 2.0.0 → incompatible');
  passed++;
}

/* ---- Test 11: extra capabilities beyond requirement still pass ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, {
    requiredCapabilities: ['llm_provider'],
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.compatible, true);
  console.log('  [PASS] manifest with extra capabilities beyond requirement → ok');
  passed++;
}

/* ---- Test 12: multiple missing items reported in one result ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, {
    requiredCapabilities: ['device_runtime', 'knowledge'],
  });
  assert.equal(result.status, 'missing_capability');
  assert.equal(result.compatible, false);
  assert.equal(result.missingCapabilities.length, 2, 'both missing capabilities reported');
  assert.ok(result.missingCapabilities.includes('device_runtime'));
  assert.ok(result.missingCapabilities.includes('knowledge'));
  console.log('  [PASS] multiple missing items all reported in one result');
  passed++;
}

/* ---- Test 13: event version equal to minHostVersion passes (edge) ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, { minHostVersion: '2.0.0' });
  assert.equal(result.status, 'ok');
  assert.equal(result.compatible, true);
  console.log('  [PASS] semver: host 2.0.0 == required 2.0.0 → ok');
  passed++;
}

/* ---- Test 14: partial provider family match still reports missing ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, {
    requiredProviderFamilies: ['openai', 'gemini'],
  });
  assert.equal(result.status, 'missing_provider_family');
  assert.equal(result.missingProviderFamilies.length, 1);
  assert.ok(result.missingProviderFamilies.includes('gemini'));
  console.log('  [PASS] partial family match → only missing family reported');
  passed++;
}

/* ---- Test 15: contract_mismatch takes priority over other failures ---- */

total++;
{
  const badManifest = {
    ...fixtureManifest,
    contractVersion: 2,
    host: { ...fixtureManifest.host, version: '0.1.0' },
  };
  const result = evaluateMossHostCompatibility(badManifest, {
    contractVersion: 1,
    minHostVersion: '1.0.0',
    requiredCapabilities: ['device_runtime'],
  });
  assert.equal(result.status, 'contract_mismatch');
  assert.equal(result.compatible, false);
  assert.equal(result.missingCapabilities.length, 0, 'should not reach capability check');
  console.log('  [PASS] contract_mismatch checked before other failures');
  passed++;
}

/* ---- Test 16: default contractVersion in requirement uses current constant ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, {});
  assert.equal(result.status, 'ok');
  assert.equal(result.compatible, true);
  console.log('  [PASS] requirement with no contractVersion defaults to MOSS_HOST_ADAPTER_CONTRACT_VERSION');
  passed++;
}

/* ---- Test 17: contract version range accepts an in-range manifest ---- */

total++;
{
  const futureCompatibleManifest = { ...fixtureManifest, contractVersion: 2 };
  const result = evaluateMossHostCompatibility(futureCompatibleManifest, {
    minContractVersion: 1,
    maxContractVersion: 2,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.compatible, true);
  console.log('  [PASS] contract version range accepts in-range manifest');
  passed++;
}

/* ---- Test 18: contract version range rejects an out-of-range manifest ---- */

total++;
{
  const tooNewManifest = { ...fixtureManifest, contractVersion: 3 };
  const result = evaluateMossHostCompatibility(tooNewManifest, {
    minContractVersion: 1,
    maxContractVersion: 2,
  });
  assert.equal(result.status, 'contract_mismatch');
  assert.equal(result.compatible, false);
  assert.ok(result.reasons[0].includes('outside Moss requirement range'));
  console.log('  [PASS] contract version range rejects out-of-range manifest');
  passed++;
}

/* ---- Test 19: exact contractVersion keeps priority over range fields ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, {
    contractVersion: 2,
    minContractVersion: 1,
    maxContractVersion: 1,
  });
  assert.equal(result.status, 'contract_mismatch');
  assert.equal(result.compatible, false);
  assert.ok(result.reasons[0].includes('does not match Moss requirement v2'));
  console.log('  [PASS] exact contractVersion takes priority over range fields');
  passed++;
}

/* ---- Test 20: invalid manifest shape is reported before compatibility checks ---- */

total++;
{
  const invalidManifest = { ...fixtureManifest, capabilities: undefined };
  const result = evaluateMossHostCompatibility(invalidManifest, {
    minContractVersion: 1,
    maxContractVersion: 1,
  });
  assert.equal(result.status, 'invalid_manifest');
  assert.equal(result.compatible, false);
  assert.ok(result.reasons[0].includes('capabilities'));
  console.log('  [PASS] invalid manifest shape returns invalid_manifest');
  passed++;
}

/* ---- Test 21: invalid nested provider record is also rejected ---- */

total++;
{
  const invalidManifest = { ...fixtureManifest, providers: [{}] };
  const result = evaluateMossHostCompatibility(invalidManifest, {
    minContractVersion: 1,
    maxContractVersion: 1,
  });
  assert.equal(result.status, 'invalid_manifest');
  assert.equal(result.compatible, false);
  assert.ok(result.reasons[0].includes('providers'));
  console.log('  [PASS] invalid nested provider record returns invalid_manifest');
  passed++;
}

console.log(`\n[pass] host-adapter-conformance: ${passed}/${total}`);
