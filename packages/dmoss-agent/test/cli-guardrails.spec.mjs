#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-guardrails.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  DmossAgent,
  InMemorySessionStore,
} from '../dist/core/index.js';
import { createConfiguredGuardrailHooks } from '../dist/cli/guardrails.js';
import { resolveCliConfig } from '../dist/cli/config.js';

function createProvider(responseText = 'ok') {
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

async function collectEvents(agent, sessionKey, prompt) {
  const events = [];
  for await (const event of agent.streamChat(sessionKey, prompt)) {
    events.push(event);
  }
  return events;
}

{
  const config = resolveCliConfig({}, {
    guardrails: {
      input: { redactPatterns: ['SECRET=[^\\s]+'] },
      output: { redactPatterns: ['TOKEN=[^\\s]+'] },
    },
  });
  const baseSeen = [];
  const hooks = createConfiguredGuardrailHooks(config, {
    async onInputGuardrail(request) {
      baseSeen.push(request.userMessage);
      return { approved: true };
    },
  });
  const decision = await hooks.onInputGuardrail({
    sessionKey: 'session',
    runId: 'run',
    userMessage: 'please use SECRET=abc123',
  });
  assert.deepEqual(decision, { approved: true, userMessage: 'please use [redacted]' });
  assert.deepEqual(baseSeen, ['please use [redacted]']);
}

{
  const config = resolveCliConfig({}, {
    guardrails: {
      input: { blockPatterns: ['delete\\s+the\\s+repo'] },
    },
  });
  const hooks = createConfiguredGuardrailHooks(config);
  const decision = await hooks.onInputGuardrail({
    sessionKey: 'session',
    runId: 'run',
    userMessage: 'please delete the repo',
  });
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /configured input guardrail/);
}

{
  const config = resolveCliConfig({}, {
    guardrails: {
      output: { blockPatterns: ['private token'] },
    },
  });
  const hooks = createConfiguredGuardrailHooks(config);
  const decision = await hooks.onOutputGuardrail({
    sessionKey: 'session',
    runId: 'run',
    turn: 1,
    response: 'this includes a private token',
  });
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /configured output guardrail/);
}

{
  const config = resolveCliConfig({}, {
    guardrails: {
      input: { redactPatterns: ['SECRET=[^\\s]+'] },
      output: { redactPatterns: ['TOKEN=[^\\s]+'] },
    },
  });
  const store = new InMemorySessionStore();
  const { provider, requests } = createProvider('answer TOKEN=xyz');
  const agent = new DmossAgent({
    sessionStore: store,
    llmProvider: provider,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    baseSystemPrompt: 'base',
    hooks: createConfiguredGuardrailHooks(config),
  });

  const events = await collectEvents(agent, 'configured-guardrails', 'please use SECRET=abc123');
  const text = events
    .filter((event) => event.type === 'text_delta')
    .map((event) => event.delta)
    .join('');
  assert.equal(text, 'answer [redacted]');
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0].messages), /please use \[redacted\]/);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /abc123/);
  const stored = await store.loadMessages('configured-guardrails');
  assert.match(JSON.stringify(stored), /please use \[redacted\]/);
  assert.match(JSON.stringify(stored), /answer \[redacted\]/);
  assert.doesNotMatch(JSON.stringify(stored), /abc123|TOKEN=xyz/);
}

assert.throws(
  () => createConfiguredGuardrailHooks(resolveCliConfig({}, {
    guardrails: { input: { blockPatterns: ['['] } },
  })),
  /Invalid guardrails\.input\.blockPatterns pattern/,
);

console.log('[PASS] CLI config guardrails block and redact input/output at runtime');
