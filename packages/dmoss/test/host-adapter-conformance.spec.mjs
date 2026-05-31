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
  MOSS_HOST_TOOL_RESULT_SURFACES,
  MOSS_HOST_TOOL_SURFACE_KINDS,
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
    version: '0.3.2',
    packages: [
      { name: '@rdk-moss/core', version: '0.3.2', stability: 'stable' },
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
      surface: 'computer_workspace',
      resultSurface: 'assistant_text',
    },
    {
      name: 'shell_exec',
      boundaryId: 'shell',
      sideEffectClass: 'local_write',
      approval: 'execute_audit',
      source: 'host',
      surface: 'computer_shell',
      resultSurface: 'terminal_output',
    },
    {
      name: 'web_fetch',
      boundaryId: 'web',
      sideEffectClass: 'readonly',
      approval: 'not_required',
      source: 'host',
      surface: 'browser_web',
      resultSurface: 'assistant_text',
    },
    {
      name: 'device_exec',
      boundaryId: 'device',
      sideEffectClass: 'device_mutation',
      approval: 'execute_audit',
      source: 'host',
      surface: 'board_device',
      resultSurface: 'terminal_output',
    },
    {
      name: 'ros_topics',
      boundaryId: 'ros',
      sideEffectClass: 'readonly',
      approval: 'not_required',
      source: 'host',
      surface: 'robotics_runtime',
      resultSurface: 'timeline_summary',
    },
    {
      name: 'read_attachment',
      boundaryId: 'attachment',
      sideEffectClass: 'readonly',
      approval: 'not_required',
      source: 'host',
      surface: 'attachment_media',
      resultSurface: 'media_or_file',
    },
    {
      name: 'send_channel_message',
      boundaryId: 'channel',
      sideEffectClass: 'external_message',
      approval: 'execute_audit',
      source: 'host',
      surface: 'channel_messaging',
      resultSurface: 'channel_delivery',
    },
    {
      name: 'sessions_spawn',
      boundaryId: 'subagent',
      sideEffectClass: 'subagent',
      approval: 'plan_audit',
      source: 'moss',
      surface: 'task_subagent',
      resultSurface: 'background_task',
    },
    {
      name: 'memory_search',
      boundaryId: 'memory',
      sideEffectClass: 'readonly',
      approval: 'not_required',
      source: 'moss',
      surface: 'memory_skill',
      resultSurface: 'assistant_text',
    },
    {
      name: 'board_openclaw_status',
      boundaryId: 'openclaw',
      sideEffectClass: 'readonly',
      approval: 'not_required',
      source: 'host',
      surface: 'openclaw_channel',
      resultSurface: 'timeline_summary',
    },
  ],
  toolSurfaces: [
    {
      kind: 'board_device',
      summary: 'Board shell, file, camera, and deployment operations for a selected device.',
      readiness: ['device_selected', 'device_reachable', 'approval_required'],
      progressMode: 'event_sink',
      primaryTools: ['device_exec', 'device_file_read'],
      healthTools: ['device_list_all'],
      fallbackSurfaces: ['openclaw_channel'],
      resultSurfaces: ['terminal_output', 'timeline_summary'],
    },
    {
      kind: 'openclaw_channel',
      summary: 'Board-side OpenClaw gateway used as a reusable execution backplane.',
      readiness: ['device_selected', 'device_reachable', 'openclaw_gateway_ready'],
      progressMode: 'streaming',
      primaryTools: ['board_openclaw_status'],
      healthTools: ['board_openclaw_status'],
      fallbackSurfaces: ['board_device'],
      resultSurfaces: ['timeline_summary'],
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

/* ---- Test 2: host tool surface constants expose the OpenClaw coverage taxonomy ---- */

total++;
{
  assert.deepEqual([...MOSS_HOST_TOOL_SURFACE_KINDS], [
    'computer_workspace',
    'computer_shell',
    'browser_web',
    'attachment_media',
    'board_device',
    'robotics_runtime',
    'channel_messaging',
    'task_subagent',
    'memory_skill',
    'openclaw_channel',
  ]);
  assert.deepEqual([...MOSS_HOST_TOOL_RESULT_SURFACES], [
    'assistant_text',
    'timeline_summary',
    'terminal_output',
    'artifact',
    'media_or_file',
    'channel_delivery',
    'background_task',
  ]);
  console.log('  [PASS] host tool surface constants expose the OpenClaw coverage taxonomy');
  passed++;
}

/* ---- Test 3: contract_mismatch — manifest.contractVersion != requirement ---- */

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

/* ---- Test 4: host_version_incompatible — host older than minHostVersion ---- */

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

/* ---- Test 5: missing_capability — required capability not in manifest ---- */

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

/* ---- Test 6: missing_event_schema — required schema not in manifest ---- */

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

/* ---- Test 7: missing_provider_family — required family not in manifest ---- */

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

/* ---- Test 8: ok — all checks pass with fully populated fixture ---- */

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
  assert.equal(result.missingToolSurfaces.length, 0);
  assert.equal(result.missingToolSurfaceDetails.length, 0);
  assert.equal(result.missingEventSchemas.length, 0);
  assert.equal(result.missingProviderFamilies.length, 0);
  console.log('  [PASS] ok when all requirements satisfied');
  passed++;
}

/* ---- Test 9: empty requirement always passes ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, {});
  assert.equal(result.status, 'ok');
  assert.equal(result.compatible, true);
  console.log('  [PASS] empty requirement passes against any valid manifest');
  passed++;
}

/* ---- Test 10: semver — "2.0.0" >= "1.5.0" passes ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, { minHostVersion: '1.5.0' });
  assert.equal(result.status, 'ok');
  assert.equal(result.compatible, true);
  console.log('  [PASS] semver: host 2.0.0 >= required 1.5.0 → ok');
  passed++;
}

/* ---- Test 11: semver — "1.0.0" >= "2.0.0" fails ---- */

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

/* ---- Test 12: extra capabilities beyond requirement still pass ---- */

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

/* ---- Test 13: multiple missing items reported in one result ---- */

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

/* ---- Test 14: event version equal to minHostVersion passes (edge) ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, { minHostVersion: '2.0.0' });
  assert.equal(result.status, 'ok');
  assert.equal(result.compatible, true);
  console.log('  [PASS] semver: host 2.0.0 == required 2.0.0 → ok');
  passed++;
}

/* ---- Test 15: partial provider family match still reports missing ---- */

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

/* ---- Test 16: contract_mismatch takes priority over other failures ---- */

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

/* ---- Test 17: default contractVersion in requirement uses current constant ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, {});
  assert.equal(result.status, 'ok');
  assert.equal(result.compatible, true);
  console.log('  [PASS] requirement with no contractVersion defaults to MOSS_HOST_ADAPTER_CONTRACT_VERSION');
  passed++;
}

/* ---- Test 18: contract version range accepts an in-range manifest ---- */

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

/* ---- Test 19: contract version range rejects an out-of-range manifest ---- */

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

/* ---- Test 20: exact contractVersion keeps priority over range fields ---- */

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

/* ---- Test 21: invalid manifest shape is reported before compatibility checks ---- */

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

/* ---- Test 22: invalid nested provider record is also rejected ---- */

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

/* ---- Test 23: legacy tools without optional surfaces remain compatible ---- */

total++;
{
  const legacyManifest = {
    ...fixtureManifest,
    tools: fixtureManifest.tools.map(({ surface, resultSurface, ...tool }) => tool),
  };
  const result = evaluateMossHostCompatibility(legacyManifest);
  assert.equal(result.status, 'ok');
  assert.equal(result.compatible, true);
  console.log('  [PASS] legacy tools without optional surfaces remain compatible');
  passed++;
}

/* ---- Test 24: invalid tool surface is rejected as invalid manifest ---- */

total++;
{
  const invalidManifest = {
    ...fixtureManifest,
    tools: [{ ...fixtureManifest.tools[0], surface: 'desktop_magic' }],
  };
  const result = evaluateMossHostCompatibility(invalidManifest);
  assert.equal(result.status, 'invalid_manifest');
  assert.equal(result.compatible, false);
  assert.ok(result.reasons[0].includes('surface'));
  console.log('  [PASS] invalid tool surface is rejected as invalid manifest');
  passed++;
}

/* ---- Test 25: invalid result surface is rejected as invalid manifest ---- */

total++;
{
  const invalidManifest = {
    ...fixtureManifest,
    tools: [{ ...fixtureManifest.tools[0], resultSurface: 'floating_panel' }],
  };
  const result = evaluateMossHostCompatibility(invalidManifest);
  assert.equal(result.status, 'invalid_manifest');
  assert.equal(result.compatible, false);
  assert.ok(result.reasons[0].includes('resultSurface'));
  console.log('  [PASS] invalid result surface is rejected as invalid manifest');
  passed++;
}

/* ---- Test 26: missing_capability — required tool surface absent ---- */

total++;
{
  const manifestWithoutAttachmentSurface = {
    ...fixtureManifest,
    tools: fixtureManifest.tools.filter((tool) => tool.surface !== 'attachment_media'),
  };
  const result = evaluateMossHostCompatibility(manifestWithoutAttachmentSurface, {
    requiredToolSurfaces: ['attachment_media'],
  });
  assert.equal(result.status, 'missing_capability');
  assert.equal(result.compatible, false);
  assert.deepEqual(result.missingCapabilities, []);
  assert.deepEqual(result.missingToolSurfaces, ['attachment_media']);
  assert.ok(result.reasons[0].includes('missing host tool surfaces'));
  console.log('  [PASS] missing_capability when required tool surfaces absent');
  passed++;
}

/* ---- Test 27: required tool surfaces pass when manifest tools declare them ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, {
    requiredToolSurfaces: [...MOSS_HOST_TOOL_SURFACE_KINDS],
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.compatible, true);
  assert.deepEqual(result.missingToolSurfaces, []);
  assert.deepEqual(result.missingToolSurfaceDetails, []);
  console.log('  [PASS] required tool surfaces pass when declared by tools');
  passed++;
}

/* ---- Test 28: invalid surface detail readiness is rejected ---- */

total++;
{
  const invalidManifest = {
    ...fixtureManifest,
    toolSurfaces: [
      {
        ...fixtureManifest.toolSurfaces[0],
        readiness: ['magic_ready'],
      },
    ],
  };
  const result = evaluateMossHostCompatibility(invalidManifest);
  assert.equal(result.status, 'invalid_manifest');
  assert.equal(result.compatible, false);
  assert.ok(result.reasons[0].includes('readiness'));
  console.log('  [PASS] invalid tool surface readiness is rejected');
  passed++;
}

/* ---- Test 29: missing_capability — required surface details absent ---- */

total++;
{
  const manifestWithoutBoardSurfaceDetails = {
    ...fixtureManifest,
    toolSurfaces: fixtureManifest.toolSurfaces.filter((surface) => surface.kind !== 'board_device'),
  };
  const result = evaluateMossHostCompatibility(manifestWithoutBoardSurfaceDetails, {
    requiredToolSurfaceDetails: ['board_device'],
  });
  assert.equal(result.status, 'missing_capability');
  assert.equal(result.compatible, false);
  assert.deepEqual(result.missingToolSurfaceDetails, ['board_device']);
  assert.ok(result.reasons[0].includes('missing host tool surface details'));
  console.log('  [PASS] missing_capability when required surface details absent');
  passed++;
}

/* ---- Test 30: required surface details pass when manifest declares them ---- */

total++;
{
  const result = evaluateMossHostCompatibility(fixtureManifest, {
    requiredToolSurfaceDetails: ['board_device', 'openclaw_channel'],
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.compatible, true);
  assert.deepEqual(result.missingToolSurfaceDetails, []);
  console.log('  [PASS] required surface details pass when declared');
  passed++;
}

console.log(`\n[pass] host-adapter-conformance: ${passed}/${total}`);
