#!/usr/bin/env node
/**
 * Capability pack primitive tests.
 *
 * Covers the pure collector (`collectCapabilityPacks`) and the runtime reader
 * in DmossAgent: a mounted pack must (1) register its tools, (2) inject its
 * prompt layers into buildSystemPrompt, and (3) surface its host requirements.
 * Without a pack, none of these change — the zero-impact baseline.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/capability-pack.spec.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DmossAgent,
  InMemorySessionStore,
  collectCapabilityPacks,
} from '../dist/core/index.js';
import { PiAiLLMProvider } from '../dist/provider/index.js';

function fakeTool(name) {
  return {
    name,
    description: `fake ${name}`,
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return 'ok';
    },
  };
}

// The provider is never invoked here — we only construct the agent and inspect
// tools/prompt/requirements — but DmossAgent requires a valid LLMProvider.
function newAgent(extra = {}) {
  const provider = new PiAiLLMProvider({
    apiKey: 'test-key',
    model: { api: 'openai-chat', provider: 'pack-test', id: 'pack-test-model' },
    streamFn: async function* () {
      throw new Error('provider should not be called in this test');
    },
  });
  return new DmossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    model: 'pack-test-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    baseSystemPrompt: 'base',
    enableCompaction: false,
    enableContextPruning: false,
    ...extra,
  });
}

const PACK_LAYER = 'CAPABILITY_PACK_PROMPT_LAYER_MARKER';

test('collectCapabilityPacks flattens tools, prompt layers, and requirements', () => {
  const out = collectCapabilityPacks([
    {
      id: 'alpha',
      displayName: 'Alpha',
      buildTools: () => [fakeTool('a_read'), fakeTool('a_exec')],
      promptLayers: [PACK_LAYER, '   ', ''],
      requiredHostCapabilities: ['workspace', 'approval_gate'],
    },
    {
      id: 'beta',
      promptLayers: ['beta-layer'],
      // dedup: 'workspace' repeats, 'tool_registry' is new
      requiredHostCapabilities: ['workspace', 'tool_registry'],
    },
  ]);

  assert.equal(out.toolGroups.length, 1, 'beta has no tools, so only one group');
  assert.equal(out.toolGroups[0].id, 'alpha');
  assert.equal(out.toolGroups[0].displayName, 'Alpha');
  assert.deepEqual(out.toolGroups[0].tools.map((t) => t.name), ['a_read', 'a_exec']);

  // whitespace/empty layers dropped; order preserved
  assert.deepEqual(out.promptLayers, [PACK_LAYER, 'beta-layer']);

  // deduped, order-preserving union
  assert.deepEqual(out.requiredHostCapabilities, ['workspace', 'approval_gate', 'tool_registry']);
});

test('collectCapabilityPacks defaults displayName to id', () => {
  const out = collectCapabilityPacks([{ id: 'solo', buildTools: () => [fakeTool('s1')] }]);
  assert.equal(out.toolGroups[0].displayName, 'solo');
});

test('collectCapabilityPacks rejects empty and duplicate ids', () => {
  assert.throws(() => collectCapabilityPacks([{ id: '' }]), /non-empty string id/);
  assert.throws(() => collectCapabilityPacks([{}]), /non-empty string id/);
  assert.throws(
    () => collectCapabilityPacks([{ id: 'dup' }, { id: 'dup' }]),
    /Duplicate CapabilityPack id: dup/,
  );
});

test('mounted pack registers tools, injects prompt layers, exposes requirements', () => {
  const agent = newAgent({
    capabilityPacks: [
      {
        id: 'computer',
        buildTools: () => [fakeTool('read_file'), fakeTool('exec')],
        promptLayers: [PACK_LAYER],
        requiredHostCapabilities: ['workspace'],
      },
    ],
  });

  // (1) tools registered and grouped
  assert.ok(agent.tools.has('read_file'));
  assert.ok(agent.tools.has('exec'));
  assert.equal(agent.tools.getGroupForTool('read_file'), 'computer');

  // (2) prompt layer present in the assembled system prompt
  assert.ok(agent.buildSystemPrompt().includes(PACK_LAYER));

  // (3) host requirements surfaced
  assert.deepEqual(agent.getCapabilityPackRequirements(), ['workspace']);
});

test('no pack = zero impact baseline', () => {
  const agent = newAgent();
  assert.deepEqual(agent.getCapabilityPackRequirements(), []);
  assert.ok(!agent.buildSystemPrompt().includes(PACK_LAYER));
  assert.ok(!agent.tools.has('read_file'));
});

test('duplicate pack id throws at agent construction', () => {
  assert.throws(
    () => newAgent({ capabilityPacks: [{ id: 'x' }, { id: 'x' }] }),
    /Duplicate CapabilityPack id: x/,
  );
});
