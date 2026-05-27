#!/usr/bin/env node
/**
 * Regression coverage for deprecated global knowledge bridge semantics.
 *
 * Global registrations are copied into each new DmossAgent for backward
 * compatibility, but unregistering a global module must also stop future
 * agents from receiving that module.
 */

import assert from 'node:assert/strict';
import { DmossAgent, InMemorySessionStore } from '../dist/core/index.js';
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
    async stream() {
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
    getPromptFragments: () => [
      {
        id: `${id}-fragment`,
        section: 'ecosystem',
        tier: 'all',
        mode: 'all',
        content: promptText,
        priority: 0,
      },
    ],
    getCommandPatterns: () => [],
    getFailureHints: () => [],
    getEcosystemPrompt: () => '',
  };
}

console.log('[TEST] unregisterKnowledgeModule removes global bridge state for future agents');
{
  const id = `global-bridge-unregister-${Date.now()}`;
  const promptText = `GLOBAL_BRIDGE_PROMPT_${Date.now()}`;
  const mod = createKnowledgeModule(id, promptText);

  try {
    registerKnowledgeModule(mod);
    assert.equal(getKnowledgeModule(id)?.id, id, 'registered module should be visible in global registry');

    const before = createAgent();
    assert.ok(
      before.buildSystemPrompt().includes(promptText),
      'new agent should receive currently registered global module',
    );
    before.dispose();

    assert.equal(unregisterKnowledgeModule(id), true, 'unregister should remove module from global registry');
    assert.equal(getKnowledgeModule(id), undefined, 'module should no longer be visible in global registry');

    const after = createAgent();
    assert.equal(
      after.buildSystemPrompt().includes(promptText),
      false,
      'new agent should not receive a globally unregistered module from bridge state',
    );
    after.dispose();
  } finally {
    unregisterKnowledgeModule(id);
  }
}

console.log('[PASS] global knowledge bridge unregister regression');
