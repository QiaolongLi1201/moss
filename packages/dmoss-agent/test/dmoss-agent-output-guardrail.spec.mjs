#!/usr/bin/env node
/**
 * Regression tests for agent-level output guardrails.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/dmoss-agent-output-guardrail.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  DmossAgent,
  InMemorySessionStore,
} from '../dist/core/index.js';

function createProvider(responseText) {
  const requests = [];
  return {
    requests,
    provider: {
      id: 'fake-provider',
      displayName: 'Fake Provider',
      async complete() {
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'summary' }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async stream(options, onEvent) {
        requests.push(options);
        onEvent({ type: 'content_block_delta', text: responseText, deltaRole: 'visible' });
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: responseText }],
          usage: { inputTokens: 2, outputTokens: 3 },
        };
      },
    },
  };
}

async function collectEvents(agent, sessionKey, prompt, options) {
  const events = [];
  for await (const event of agent.streamChat(sessionKey, prompt, options)) {
    events.push(event);
  }
  return events;
}

{
  const store = new InMemorySessionStore();
  const { provider, requests } = createProvider('public answer SECRET=abc123');
  const seen = [];
  const agent = new DmossAgent({
    sessionStore: store,
    llmProvider: provider,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    baseSystemPrompt: 'base',
    hooks: {
      async onOutputGuardrail(request) {
        seen.push(request);
        return {
          approved: true,
          response: request.response.replace('SECRET=abc123', 'SECRET=[redacted]'),
        };
      },
    },
  });

  const events = await collectEvents(
    agent,
    'output-guardrail-normalize',
    'answer with secret',
    { platform: 'rdk-x5', runId: 'run-output-normalize' },
  );
  const deltas = events
    .filter((event) => event.type === 'text_delta')
    .map((event) => event.delta)
    .join('');
  const done = events.find((event) => event.type === 'done');
  assert.equal(requests.length, 1, 'approved output should still call the provider once');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionKey, 'output-guardrail-normalize');
  assert.equal(seen[0].runId, 'run-output-normalize');
  assert.equal(seen[0].platform, 'rdk-x5');
  assert.equal(seen[0].response, 'public answer SECRET=abc123');
  assert.equal(deltas, 'public answer SECRET=[redacted]');
  assert.equal(done.result.response, 'public answer SECRET=[redacted]');
  const stored = await store.loadMessages('output-guardrail-normalize');
  assert.match(JSON.stringify(stored), /SECRET=\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(stored), /abc123/);
}

{
  const store = new InMemorySessionStore();
  const { provider } = createProvider('unsafe final answer with SECRET=abc123');
  const agent = new DmossAgent({
    sessionStore: store,
    llmProvider: provider,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    baseSystemPrompt: 'base',
    hooks: {
      async onOutputGuardrail() {
        return { approved: false, reason: 'contains private token', response: '[blocked]' };
      },
    },
  });

  const events = await collectEvents(agent, 'output-guardrail-deny', 'answer unsafely');
  const deltas = events
    .filter((event) => event.type === 'text_delta')
    .map((event) => event.delta)
    .join('');
  const done = events.find((event) => event.type === 'done');
  assert.equal(deltas, '[blocked]');
  assert.equal(done.result.response, '[blocked]');
  assert.doesNotMatch(JSON.stringify(events), /abc123/);
  const stored = await store.loadMessages('output-guardrail-deny');
  assert.match(JSON.stringify(stored), /\[blocked\]/);
  assert.doesNotMatch(JSON.stringify(stored), /abc123/);
}

{
  const store = new InMemorySessionStore();
  const { provider } = createProvider('guard failure should hide SECRET=abc123');
  const agent = new DmossAgent({
    sessionStore: store,
    llmProvider: provider,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    baseSystemPrompt: 'base',
    hooks: {
      async onOutputGuardrail() {
        throw new Error('policy service unavailable');
      },
    },
  });

  const events = await collectEvents(agent, 'output-guardrail-fail-closed', 'answer unsafely');
  const text = events
    .filter((event) => event.type === 'text_delta')
    .map((event) => event.delta)
    .join('');
  const done = events.find((event) => event.type === 'done');
  assert.match(text, /Output blocked by host policy/);
  assert.match(done.result.response, /Output blocked by host policy/);
  assert.doesNotMatch(JSON.stringify(events), /abc123/);
  const stored = await store.loadMessages('output-guardrail-fail-closed');
  assert.match(JSON.stringify(stored), /Output blocked by host policy/);
  assert.doesNotMatch(JSON.stringify(stored), /abc123/);
}

console.log('[PASS] DmossAgent output guardrail gates visible assistant text before streaming and persistence');
