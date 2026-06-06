#!/usr/bin/env node
/**
 * DmossAgent memoryContextProvider injection.
 *
 * Verifies the long-term-memory digest returned by `config.memoryContextProvider`
 * reaches the model's system prompt on every turn, lands in the DYNAMIC (non-cached)
 * layer rather than polluting the cached stable prefix, and that an empty / absent /
 * throwing provider injects nothing without breaking the run.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/memory-context-injection.spec.mjs
 */
import assert from 'node:assert/strict';
import { DmossAgent, InMemorySessionStore } from '../dist/core/index.js';

function captureProvider() {
  const streamRequests = [];
  return {
    streamRequests,
    provider: {
      id: 'fake-provider',
      displayName: 'Fake Provider',
      async complete() {
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { inputTokens: 1, outputTokens: 1 } };
      },
      async stream(options, onEvent) {
        streamRequests.push(options);
        onEvent({ type: 'content_block_delta', text: 'ok', deltaRole: 'visible' });
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  };
}

async function drain(iterable) {
  for await (const _event of iterable) {
    /* consume the stream to completion */
  }
}

function makeAgent(config) {
  return new DmossAgent({
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    ...config,
  });
}

// A realistic-looking digest block with a unique marker the stable guidance never contains.
const DIGEST = '<dmoss_memory>\n- [pin] user prefers terse Chinese answers · #mem_sentinel42\n</dmoss_memory>';

// 1. digest is injected into the dynamic layer (not the cached stable prefix)
{
  const { provider, streamRequests } = captureProvider();
  const agent = makeAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    memoryContextProvider: () => DIGEST,
  });
  await drain(agent.streamChat('inj-1', 'hello', { runId: 'r1' }));
  assert.equal(streamRequests.length, 1, 'exactly one stream request');
  const parts = streamRequests[0].systemPromptParts;
  assert.ok(parts, 'prompt-cache split present');
  assert.ok(parts.dynamic.includes('#mem_sentinel42'), 'digest injected into the dynamic layer');
  assert.ok(!parts.stable.includes('#mem_sentinel42'), 'digest does NOT pollute the cached stable prefix');
  assert.ok(streamRequests[0].systemPrompt.includes('#mem_sentinel42'), 'digest present in the combined system prompt the model sees');
}

// 2. an async provider is awaited
{
  const { provider, streamRequests } = captureProvider();
  const agent = makeAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    memoryContextProvider: async () => DIGEST,
  });
  await drain(agent.streamChat('inj-2', 'hello', { runId: 'r2' }));
  assert.ok(streamRequests[0].systemPrompt.includes('#mem_sentinel42'), 'async digest awaited and injected');
}

// 3. no provider → no memory block injected (control; guidance text is in stable, not dynamic)
{
  const { provider, streamRequests } = captureProvider();
  const agent = makeAgent({ llmProvider: provider, sessionStore: new InMemorySessionStore() });
  await drain(agent.streamChat('inj-3', 'hello', { runId: 'r3' }));
  assert.ok(!streamRequests[0].systemPromptParts.dynamic.includes('<dmoss_memory>'), 'no memory block without a provider');
}

// 4. empty digest → nothing injected, run still completes
{
  const { provider, streamRequests } = captureProvider();
  const agent = makeAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    memoryContextProvider: () => '',
  });
  await drain(agent.streamChat('inj-4', 'hello', { runId: 'r4' }));
  assert.ok(!streamRequests[0].systemPromptParts.dynamic.includes('<dmoss_memory>'), 'empty digest injects nothing');
}

// 5. a throwing provider is non-fatal — the run still reaches the model
{
  const { provider, streamRequests } = captureProvider();
  const agent = makeAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    memoryContextProvider: () => {
      throw new Error('boom');
    },
  });
  await drain(agent.streamChat('inj-5', 'hello', { runId: 'r5' }));
  assert.equal(streamRequests.length, 1, 'run completes despite a provider error');
  assert.ok(!streamRequests[0].systemPromptParts.dynamic.includes('<dmoss_memory>'), 'no block when the provider throws');
}

console.log('[memory-context-injection.spec] PASS');
