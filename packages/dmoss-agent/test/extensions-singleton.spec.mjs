#!/usr/bin/env node
/**
 * Self-test for PlatformExtensionRegistry isolation behavior.
 *
 * - Each DmossAgent owns an isolated PlatformExtensionRegistry.
 * - Deprecated free-function wrappers still target a process-scoped singleton.
 * - Legacy wrapper knowledge is bridged into future DmossAgent instances.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/extensions-singleton.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  DmossAgent,
  InMemorySessionStore,
} from '../dist/core/index.js';
import {
  getDefaultExtensionsRegistry,
  applyPlatformExtension,
  resetExtensionsWireCountForTests,
  resetPlatformExtensionRegistryForTests,
} from '../dist/extensions/index.js';
import {
  getKnowledgeModule,
  registerKnowledgeModule,
  unregisterKnowledgeModule,
} from '../dist/knowledge/index.js';

function createStubProvider() {
  return {
    id: 'stub',
    displayName: 'Stub',
    async complete() {
      return { stopReason: 'end_turn', content: [], usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async stream(_opts, _onEvent) {
      return { stopReason: 'end_turn', content: [], usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

function createAgent() {
  return new DmossAgent({
    llmProvider: createStubProvider(),
    sessionStore: new InMemorySessionStore(),
    model: 'stub',
    domainPrompt: false,
  });
}

function createKnowledgeModule(id, promptText) {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: 'test knowledge module',
    platforms: [`${id}-platform`],
    getDeviceProfiles: () => ({}),
    getDocIndex: () => [],
    getPromptFragments: () => promptText
      ? [{
          id: `${id}-fragment`,
          section: 'ecosystem',
          tier: 'all',
          mode: 'all',
          content: promptText,
          priority: 0,
        }]
      : [],
    getCommandPatterns: () => [],
    getFailureHints: () => [],
    getEcosystemPrompt: () => '',
  };
}

function createExtension(id, mod, enabled = true) {
  return {
    id,
    knowledgeModuleId: mod.id,
    vendorPluginId: `${id}-vendor`,
    isEnabled: () => enabled,
    getKnowledgeModule: () => mod,
    getVendorPlugin: () => ({ id: `${id}-vendor`, tools: [] }),
  };
}

// ── Test 1: Agent registry is not the deprecated singleton ──
{
  resetExtensionsWireCountForTests();
  resetPlatformExtensionRegistryForTests();

  const agent = createAgent();

  assert.notEqual(
    agent.extensions,
    getDefaultExtensionsRegistry(),
    'agent.extensions must be per-instance, not the deprecated singleton',
  );

  agent.dispose();
  console.log('[PASS] Single agent owns a private extension registry');
}

// ── Test 2: Two agents isolate extension knowledge bindings ──
{
  resetExtensionsWireCountForTests();
  resetPlatformExtensionRegistryForTests();

  const agentA = createAgent();
  const agentB = createAgent();

  assert.notEqual(agentA.extensions, agentB.extensions,
    'Two agents must own distinct extension registries');

  const markerA = `AGENT_A_EXTENSION_MARKER_${Date.now()}`;
  const markerB = `AGENT_B_EXTENSION_MARKER_${Date.now()}`;
  const modA = createKnowledgeModule('agent-a-ext-mod', markerA);
  const modB = createKnowledgeModule('agent-b-ext-mod', markerB);

  agentA.extensions.apply(createExtension('agent-a-ext', modA));
  agentB.extensions.apply(createExtension('agent-b-ext', modB));

  const promptA = agentA.buildSystemPrompt();
  const promptB = agentB.buildSystemPrompt();

  assert.ok(promptA.includes(markerA), 'agentA should receive its own extension knowledge');
  assert.equal(promptA.includes(markerB), false, 'agentA should not receive agentB extension knowledge');
  assert.ok(promptB.includes(markerB), 'agentB should receive its own extension knowledge');
  assert.equal(promptB.includes(markerA), false, 'agentB should not receive agentA extension knowledge');

  agentA.dispose();
  agentB.dispose();
  console.log('[PASS] Two agents keep extension knowledge isolated');
}

// ── Test 3: PlatformExtensionRegistry class API works independently ──
{
  const { PlatformExtensionRegistry } = await import('../dist/extensions/index.js');

  const regA = new PlatformExtensionRegistry();
  const regB = new PlatformExtensionRegistry();

  let aRegistered = false;
  let bRegistered = false;

  regA.setVendorPluginCallbacks({
    register: () => { aRegistered = true; },
    unregister: () => {},
  });
  regB.setVendorPluginCallbacks({
    register: () => { bRegistered = true; },
    unregister: () => {},
  });

  const { KnowledgeRegistry } = await import('../dist/knowledge/index.js');
  const krA = new KnowledgeRegistry();
  const krB = new KnowledgeRegistry();
  regA.setKnowledgeRegistry(krA);
  regB.setKnowledgeRegistry(krB);

  const mod = createKnowledgeModule('iso-mod', '');

  const ext = {
    id: 'iso-ext',
    knowledgeModuleId: 'iso-mod',
    vendorPluginId: 'iso-vendor',
    isEnabled: () => true,
    getKnowledgeModule: () => mod,
    getVendorPlugin: () => ({ id: 'iso-vendor', tools: [] }),
  };

  regA.apply(ext);

  assert.equal(aRegistered, true, 'regA vendor callback fired');
  assert.equal(bRegistered, false, 'regB vendor callback NOT fired');
  assert.ok(krA.get('iso-mod'), 'mod registered in krA');
  assert.equal(krB.get('iso-mod'), undefined, 'mod NOT registered in krB');

  console.log('[PASS] Independent PlatformExtensionRegistry instances are fully isolated');
}

// ── Test 4: Deprecated wrapper singleton remains backward compatible ──
{
  resetExtensionsWireCountForTests();
  resetPlatformExtensionRegistryForTests();

  const id = `legacy-ext-mod-${Date.now()}`;
  const marker = `LEGACY_EXTENSION_MARKER_${Date.now()}`;
  const mod = createKnowledgeModule(id, marker);
  const ext = createExtension(`legacy-ext-${Date.now()}`, mod);

  try {
    applyPlatformExtension(ext);
    assert.equal(getKnowledgeModule(id)?.id, id,
      'legacy applyPlatformExtension should bridge extension knowledge into global registry');

    const agent = createAgent();
    assert.ok(
      agent.buildSystemPrompt().includes(marker),
      'future agent should receive legacy wrapper extension knowledge via global bridge',
    );
    agent.dispose();
  } finally {
    unregisterKnowledgeModule(id);
  }

  console.log('[PASS] Deprecated extension singleton still bridges knowledge to future agents');
}

// ── Test 5: Disabled legacy extension does not delete unrelated global knowledge ──
{
  resetExtensionsWireCountForTests();
  resetPlatformExtensionRegistryForTests();

  const id = `legacy-shared-mod-${Date.now()}`;
  const marker = `LEGACY_GLOBAL_MARKER_${Date.now()}`;
  const globalMod = createKnowledgeModule(id, marker);
  const disabledExtMod = createKnowledgeModule(id, '');
  const disabledExt = createExtension(`legacy-disabled-ext-${Date.now()}`, disabledExtMod, false);

  try {
    registerKnowledgeModule(globalMod);
    applyPlatformExtension(disabledExt);

    assert.equal(getKnowledgeModule(id)?.id, id,
      'disabled extension should not remove same-id global knowledge it did not bridge');

    const agent = createAgent();
    assert.ok(
      agent.buildSystemPrompt().includes(marker),
      'future agent should still receive same-id global knowledge after disabled extension apply',
    );
    agent.dispose();
  } finally {
    unregisterKnowledgeModule(id);
  }

  console.log('[PASS] Disabled legacy extension does not delete unrelated global knowledge');
}

console.log('\n[pass] extensions isolation: 5/5');
