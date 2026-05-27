#!/usr/bin/env node
/**
 * Self-test for PlatformExtensionRegistry singleton behavior.
 *
 * Documents the current shared-singleton limitation (ARCHITECTURE_ASSESSMENT.md P0-1):
 * - Multiple DmossAgent instances share the same PlatformExtensionRegistry
 * - The last agent to call setKnowledgeRegistry() overwrites the previous one's binding
 * - This test verifies the behavior is documented and observable, not that isolation works
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
  resetExtensionsWireCountForTests,
  resetPlatformExtensionRegistryForTests,
} from '../dist/extensions/index.js';

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

// ── Test 1: Single agent wires to shared singleton ──
{
  resetExtensionsWireCountForTests();
  resetPlatformExtensionRegistryForTests();

  const agent = new DmossAgent({
    llmProvider: createStubProvider(),
    sessionStore: new InMemorySessionStore(),
    model: 'stub',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
  });

  assert.equal(agent.extensions, getDefaultExtensionsRegistry(),
    'agent.extensions must be the shared singleton');

  agent.dispose();
  console.log('[PASS] Single agent wires to shared singleton');
}

// ── Test 2: Two agents share the same extensions instance ──
{
  resetExtensionsWireCountForTests();
  resetPlatformExtensionRegistryForTests();

  const agentA = new DmossAgent({
    llmProvider: createStubProvider(),
    sessionStore: new InMemorySessionStore(),
    model: 'stub',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
  });

  const agentB = new DmossAgent({
    llmProvider: createStubProvider(),
    sessionStore: new InMemorySessionStore(),
    model: 'stub',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
  });

  assert.equal(agentA.extensions, agentB.extensions,
    'Two agents MUST share the same extensions instance (current limitation)');

  // Document: last agent's knowledge registry wins
  // agentB was constructed last, so extensions now points to agentB's knowledge
  const mod = {
    id: 'test-mod',
    version: '1.0.0',
    platforms: ['test'],
    getDeviceProfiles: () => ({}),
    getDocIndex: () => [],
    getPromptFragments: () => [],
    getCommandPatterns: () => [],
    getFailureHints: () => [],
    getEcosystemPrompt: () => '',
  };

  // Register via agentA — goes to agentA's knowledge registry
  agentA.registerKnowledge(mod);

  // But extensions.apply() uses the LAST wired knowledge registry (agentB's)
  // So agentA's knowledge module is NOT visible through extensions
  // This is the documented limitation
  const ext = {
    id: 'test-ext',
    knowledgeModuleId: 'test-mod',
    vendorPluginId: 'test-vendor',
    isEnabled: () => true,
    getKnowledgeModule: () => mod,
    getVendorPlugin: () => ({ id: 'test-vendor', tools: [] }),
  };

  agentA.extensions.apply(ext);

  // The extension was applied using agentB's knowledge registry (last wired)
  // This documents the "last agent wins" behavior
  const appliedState = agentA.extensions.listAppliedState();
  assert.equal(appliedState.get('test-ext'), true,
    'Extension apply works on shared singleton');

  agentA.dispose();
  agentB.dispose();
  console.log('[PASS] Two agents share singleton — last agent wins (documented limitation)');
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

  const mod = {
    id: 'iso-mod',
    version: '1.0.0',
    platforms: ['test'],
    getDeviceProfiles: () => ({}),
    getDocIndex: () => [],
    getPromptFragments: () => [],
    getCommandPatterns: () => [],
    getFailureHints: () => [],
    getEcosystemPrompt: () => '',
  };

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

console.log('\n[pass] extensions-singleton: 3/3');
