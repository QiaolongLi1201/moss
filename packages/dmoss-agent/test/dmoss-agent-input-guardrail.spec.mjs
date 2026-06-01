#!/usr/bin/env node
/**
 * Regression tests for agent-level input guardrails.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/dmoss-agent-input-guardrail.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  DmossAgent,
  InMemorySessionStore,
} from '../dist/core/index.js';
import { DmossError, ErrorCode } from '../dist/errors.js';

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

{
  const store = new InMemorySessionStore();
  const { provider, requests } = createProvider('should not run');
  const seen = [];
  const agent = new DmossAgent({
    sessionStore: store,
    llmProvider: provider,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    baseSystemPrompt: 'base',
    hooks: {
      async onInputGuardrail(request) {
        seen.push(request);
        return { approved: false, reason: 'workspace is read-only for this request' };
      },
    },
  });

  await assert.rejects(
    () => agent.chat('input-guardrail-deny', 'delete the repo', { platform: 'rdk-x5', runId: 'run-deny' }),
    (err) => {
      assert.ok(err instanceof DmossError);
      assert.equal(err.code, ErrorCode.TOOL_NOT_ALLOWED);
      assert.match(err.message, /input guardrail rejected/);
      assert.match(err.message, /workspace is read-only/);
      assert.equal(err.context?.sessionKey, 'input-guardrail-deny');
      assert.equal(err.context?.runId, 'run-deny');
      return true;
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionKey, 'input-guardrail-deny');
  assert.equal(seen[0].runId, 'run-deny');
  assert.equal(seen[0].userMessage, 'delete the repo');
  assert.equal(seen[0].platform, 'rdk-x5');
  assert.equal(requests.length, 0, 'denied input must not call the provider');
  assert.deepEqual(
    await store.loadMessages('input-guardrail-deny'),
    [],
    'denied input must not be persisted to the session',
  );
}

{
  const store = new InMemorySessionStore();
  const { provider, requests } = createProvider('normalized ok');
  const agent = new DmossAgent({
    sessionStore: store,
    llmProvider: provider,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    baseSystemPrompt: 'base',
    maxAgentTurns: 3,
    hooks: {
      async onInputGuardrail(request) {
        return {
          approved: true,
          userMessage: request.userMessage.replace('SECRET=abc123', 'SECRET=[redacted]'),
        };
      },
    },
  });

  const result = await agent.chat('input-guardrail-normalize', 'please use SECRET=abc123');
  assert.equal(result.response, 'normalized ok');
  assert.equal(requests.length, 1, 'approved input should call the provider once');
  const stored = await store.loadMessages('input-guardrail-normalize');
  assert.equal(stored[0].role, 'user');
  assert.match(JSON.stringify(stored[0]), /SECRET=\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(stored), /abc123/);
  assert.match(
    requests[0].messages.map((message) => JSON.stringify(message)).join('\n'),
    /SECRET=\[redacted\]/,
    'provider request should receive normalized input',
  );
}

console.log('[PASS] DmossAgent input guardrail gates and normalizes user messages before persistence');
