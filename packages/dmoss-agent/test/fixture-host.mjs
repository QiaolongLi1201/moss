#!/usr/bin/env node
/**
 * Minimal CLI fixture host for the Moss Host Adapter contract.
 *
 * Proves the Host Adapter v1 contract works end-to-end by running a single
 * mock agent conversation — mock LLM, mock session store, manifest validation.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/fixture-host.mjs
 */

import assert from 'node:assert/strict';

import { DmossAgent } from '../dist/core/dmoss-agent.js';
import { InMemorySessionStore } from '../dist/core/session.js';
import {
  MOSS_HOST_ADAPTER_CONTRACT_VERSION,
  evaluateMossHostCompatibility,
} from '../../dmoss/dist/contracts/host-adapter.js';

// ─── Helpers ────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

/** @param {string} label */
function pass(label) {
  passCount++;
  console.log(`  [PASS] ${label}`);
}

/** @param {string} label  @param {string} [detail] */
function fail(label, detail) {
  failCount++;
  console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
}

function check(label, fn) {
  try {
    fn();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

// ─── 1. Mock LLM Provider ──────────────────────────────────

const MOCK_TEXT = 'Hello from mock LLM';

const mockProvider = {
  id: 'mock',
  displayName: 'Mock LLM',

  async complete(_options) {
    await new Promise((r) => setTimeout(r, 10));
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: MOCK_TEXT }],
    };
  },

  async stream(_options, onEvent) {
    await new Promise((r) => setTimeout(r, 10));

    onEvent({ type: 'message_start' });
    onEvent({ type: 'content_block_start' });
    onEvent({ type: 'content_block_delta', text: MOCK_TEXT });
    onEvent({ type: 'content_block_stop' });
    onEvent({ type: 'message_delta', stopReason: 'end_turn' });
    onEvent({ type: 'message_stop' });

    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: MOCK_TEXT }],
    };
  },
};

check('mock provider has complete() and stream()', () => {
  assert.equal(typeof mockProvider.complete, 'function');
  assert.equal(typeof mockProvider.stream, 'function');
  assert.equal(mockProvider.id, 'mock');
});

// ─── 2. Mock Session Store ─────────────────────────────────

const mockStore = new InMemorySessionStore();

check('mock store implements SessionStore interface', () => {
  assert.equal(typeof mockStore.loadMessages, 'function');
  assert.equal(typeof mockStore.appendMessage, 'function');
  assert.equal(typeof mockStore.replaceMessages, 'function');
  assert.equal(typeof mockStore.listSessions, 'function');
  assert.equal(typeof mockStore.deleteSession, 'function');
  assert.equal(typeof mockStore.exists, 'function');
});

// ─── 3. Minimal DmossAgent ─────────────────────────────────

const agent = new DmossAgent({
  llmProvider: mockProvider,
  sessionStore: mockStore,
  baseSystemPrompt: 'You are a test agent.',
  domainPrompt: false,
  maxAgentTurns: 1,
  enableSteering: false,
  enableFollowUpGuard: false,
});

check('DmossAgent created with mock provider + store', () => {
  assert.ok(agent);
  assert.equal(agent.config.llmProvider, mockProvider);
  assert.equal(agent.config.sessionStore, mockStore);
  assert.equal(agent.config.baseSystemPrompt, 'You are a test agent.');
});

// ─── 4. Run one conversation ───────────────────────────────

const sessionKey = 'fixture:test-session';
let chatResult;

try {
  chatResult = await agent.chat(sessionKey, 'Hello');
  check('agent.chat() returns a non-empty response', () => {
    assert.ok(chatResult, 'result should not be undefined');
    assert.ok(
      typeof chatResult.response === 'string' && chatResult.response.length > 0,
      `response should be non-empty, got: ${JSON.stringify(chatResult.response)}`,
    );
  });

  check('response contains mock LLM text', () => {
    assert.ok(
      chatResult.response.includes(MOCK_TEXT),
      `expected "${MOCK_TEXT}" in response, got: ${chatResult.response}`,
    );
  });

  check('stopReason is present', () => {
    assert.ok(chatResult.stopReason, 'stopReason should be set');
  });

  check('session store persisted messages', async () => {
    const stored = await mockStore.loadMessages(sessionKey);
    assert.ok(stored.length >= 2, `expected >=2 messages, got ${stored.length}`);
  });
} catch (err) {
  fail('agent.chat() threw', err.message);
  // Stub out remaining checks so counts stay consistent
  fail('response contains mock LLM text', 'skipped — chat failed');
  fail('stopReason is present', 'skipped — chat failed');
  fail('session store persisted messages', 'skipped — chat failed');
}

// ─── 5. Build MossHostRuntimeManifest ───────────────────────

const manifest = {
  schema: 'moss_host_adapter.v1',
  contractVersion: MOSS_HOST_ADAPTER_CONTRACT_VERSION,
  host: {
    id: 'fixture-host',
    name: 'Fixture Host',
    version: '0.1.0',
  },
  moss: {
    version: '0.3.1',
    packages: [
      { name: '@dmoss/core', version: '0.3.1', stability: 'stable' },
      { name: '@dmoss/agent', version: '0.3.1', stability: 'stable' },
    ],
  },
  capabilities: [
    { kind: 'llm_provider', version: '1.0.0', stability: 'stable', summary: 'LLM provider for model inference' },
    { kind: 'tool_registry', version: '1.0.0', stability: 'stable', summary: 'Tool registration and discovery' },
    { kind: 'approval_gate', version: '1.0.0', stability: 'stable', summary: 'Host-gated tool execution approval' },
    { kind: 'workspace', version: '1.0.0', stability: 'stable', summary: 'File system workspace management' },
    { kind: 'event_sink', version: '1.0.0', stability: 'stable', summary: 'Agent event logging sink' },
  ],
  providers: [
    {
      id: 'mock',
      displayName: 'Mock LLM',
      families: ['claude'],
      configuredByHost: true,
      streaming: true,
      toolCalling: true,
    },
  ],
  tools: [
    {
      name: 'read_file',
      boundaryId: 'workspace',
      sideEffectClass: 'readonly',
      approval: 'not_required',
      source: 'moss',
    },
    {
      name: 'write_file',
      boundaryId: 'workspace',
      sideEffectClass: 'local_write',
      approval: 'execute_audit',
      source: 'moss',
    },
    {
      name: 'bash',
      boundaryId: 'workspace',
      sideEffectClass: 'local_write',
      approval: 'plan_audit',
      source: 'moss',
    },
    {
      name: 'web_fetch',
      boundaryId: 'network',
      sideEffectClass: 'readonly',
      approval: 'not_required',
      source: 'moss',
    },
    {
      name: 'device_exec',
      boundaryId: 'device',
      sideEffectClass: 'device_mutation',
      approval: 'execute_audit',
      source: 'host',
    },
    {
      name: 'create_subagent',
      boundaryId: 'agent',
      sideEffectClass: 'subagent',
      approval: 'plan_audit',
      source: 'moss',
    },
  ],
  eventSinks: [
    {
      id: 'console',
      schemas: ['agent_turn', 'tool_call', 'compaction'],
      supportsStreaming: true,
    },
  ],
  knowledgeModules: [],
};

check('manifest schema is moss_host_adapter.v1', () => {
  assert.equal(manifest.schema, 'moss_host_adapter.v1');
});

check('manifest contractVersion matches contract', () => {
  assert.equal(manifest.contractVersion, MOSS_HOST_ADAPTER_CONTRACT_VERSION);
  assert.equal(manifest.contractVersion, 1);
});

check('manifest declares all required capabilities', () => {
  const kinds = manifest.capabilities.map((c) => c.kind);
  assert.ok(kinds.includes('llm_provider'), 'missing llm_provider');
  assert.ok(kinds.includes('tool_registry'), 'missing tool_registry');
  assert.ok(kinds.includes('approval_gate'), 'missing approval_gate');
  assert.ok(kinds.includes('workspace'), 'missing workspace');
  assert.ok(kinds.includes('event_sink'), 'missing event_sink');
});

check('manifest lists mock provider with families', () => {
  assert.equal(manifest.providers.length, 1);
  assert.equal(manifest.providers[0].id, 'mock');
  assert.ok(manifest.providers[0].families.includes('claude'));
  assert.equal(manifest.providers[0].streaming, true);
  assert.equal(manifest.providers[0].toolCalling, true);
});

check('manifest tools have correct sideEffectClass and approval', () => {
  const byName = Object.fromEntries(manifest.tools.map((t) => [t.name, t]));
  assert.equal(byName.read_file.sideEffectClass, 'readonly');
  assert.equal(byName.read_file.approval, 'not_required');
  assert.equal(byName.write_file.sideEffectClass, 'local_write');
  assert.equal(byName.write_file.approval, 'execute_audit');
  assert.equal(byName.device_exec.sideEffectClass, 'device_mutation');
  assert.equal(byName.device_exec.approval, 'execute_audit');
  assert.equal(byName.create_subagent.sideEffectClass, 'subagent');
});

// ─── 6. Validate manifest ──────────────────────────────────

const report = evaluateMossHostCompatibility(manifest, {});

check('evaluateMossHostCompatibility returns compatible=true', () => {
  assert.equal(report.compatible, true, `reasons: ${report.reasons.join(', ')}`);
});

check('compatibility status is ok', () => {
  assert.equal(report.status, 'ok');
});

check('no missing capabilities', () => {
  assert.deepEqual(report.missingCapabilities, []);
});

check('no missing event schemas', () => {
  assert.deepEqual(report.missingEventSchemas, []);
});

check('no missing provider families', () => {
  assert.deepEqual(report.missingProviderFamilies, []);
});

// ─── Validate with requirements ────────────────────────────

const strictReport = evaluateMossHostCompatibility(manifest, {
  contractVersion: 1,
  requiredCapabilities: ['llm_provider', 'tool_registry', 'event_sink'],
  requiredEventSchemas: ['agent_turn'],
  requiredProviderFamilies: ['claude'],
});

check('manifest passes strict compatibility check', () => {
  assert.equal(strictReport.compatible, true, `reasons: ${strictReport.reasons.join(', ')}`);
  assert.equal(strictReport.status, 'ok');
});

const negotiatedReport = evaluateMossHostCompatibility(manifest, {
  minContractVersion: 1,
  maxContractVersion: MOSS_HOST_ADAPTER_CONTRACT_VERSION,
  requiredCapabilities: ['llm_provider', 'tool_registry', 'event_sink'],
});

check('manifest passes contract version range negotiation', () => {
  assert.equal(negotiatedReport.compatible, true, `reasons: ${negotiatedReport.reasons.join(', ')}`);
  assert.equal(negotiatedReport.status, 'ok');
});

// ─── Summary ───────────────────────────────────────────────

const total = passCount + failCount;
console.log(`\n  [${failCount === 0 ? 'pass' : 'FAIL'}] fixture-host: ${passCount}/${total}`);

if (failCount > 0) process.exit(1);
