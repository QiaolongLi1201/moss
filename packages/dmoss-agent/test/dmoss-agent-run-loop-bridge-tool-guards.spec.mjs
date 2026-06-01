#!/usr/bin/env node
/**
 * Parity tests for DmossAgent.streamChat -> runAgentLoop bridge:
 * tool loop guard, idempotent replay, and redundant web_fetch suppression.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/dmoss-agent-run-loop-bridge-tool-guards.spec.mjs
 */

import assert from 'node:assert/strict';
import { DmossAgent, InMemorySessionStore } from '../dist/core/index.js';

function createModelEventProvider(handler) {
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
        return handler(options, onEvent, requests.length);
      },
    },
  };
}

function toolResultCount(options) {
  return options.messages.reduce((count, message) => {
    if (!Array.isArray(message.content)) return count;
    return count + message.content.filter((block) => block.type === 'tool_result').length;
  }, 0);
}

async function collectEvents(agent, sessionKey, prompt) {
  const events = [];
  for await (const event of agent.streamChat(sessionKey, prompt)) {
    events.push(event);
  }
  return events;
}

{
  const store = new InMemorySessionStore();
  let executeCount = 0;
  const { provider } = createModelEventProvider((options) => {
    const results = toolResultCount(options);
    if (results < 3) {
      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: `probe-call-${results + 1}`,
            name: 'preset_probe',
            input: { value: 1 },
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'finished after guard' }],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: store,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    maxAgentTurns: 5,
  });
  agent.tools.register({
    name: 'preset_probe',
    description: 'Readonly probe',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
    },
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    async execute(input) {
      executeCount += 1;
      return `probe:${input.value}`;
    },
  });

  const events = await collectEvents(agent, 'bridge-tool-guard-replay', 'repeat readonly probe');
  const done = events.find((event) => event.type === 'done');
  assert(done, 'expected done event');
  assert.equal(done.result.response, 'finished after guard');
  assert.equal(executeCount, 1, 'second identical readonly call should replay, third should guard');
  assert.equal(done.result.toolResults.length, 3);
  assert.equal(done.result.toolResults[0].content, 'probe:1');
  assert.equal(done.result.toolResults[1].content, 'probe:1');
  assert.match(done.result.toolResults[2].content, /Tool loop guard stopped another preset_probe/);
  assert(
    events.some(
      (event) =>
        event.type === 'tool_end' &&
        event.toolName === 'preset_probe' &&
        event.isError &&
        /Tool loop guard stopped/.test(event.result),
    ),
    'expected visible guard tool_end error',
  );
}

{
  const store = new InMemorySessionStore();
  let openCount = 0;
  let fetchCount = 0;
  const { provider } = createModelEventProvider((options) => {
    const results = toolResultCount(options);
    if (results === 0) {
      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'open-call-1',
            name: 'host_open_url',
            input: { url: 'https://example.com/page#section' },
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    if (results === 1) {
      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'fetch-call-1',
            name: 'web_fetch',
            input: { url: 'https://example.com/page' },
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'opened without redundant fetch' }],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: store,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    maxAgentTurns: 5,
  });
  agent.tools.register({
    name: 'host_open_url',
    description: 'Open URL',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    async execute(input) {
      openCount += 1;
      return `open_url_ok: 已请求打开 ${input.url}`;
    },
  });
  agent.tools.register({
    name: 'web_fetch',
    description: 'Fetch URL',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    async execute() {
      fetchCount += 1;
      return 'should not fetch';
    },
  });

  const events = await collectEvents(agent, 'bridge-web-fetch-suppress', 'open this page');
  const done = events.find((event) => event.type === 'done');
  assert(done, 'expected done event');
  assert.equal(done.result.response, 'opened without redundant fetch');
  assert.equal(openCount, 1);
  assert.equal(fetchCount, 0, 'redundant web_fetch should be suppressed after open_url success');
  assert.equal(done.result.toolResults.length, 2);
  assert.match(done.result.toolResults[1].content, /web_fetch_suppressed/);
  assert(
    events.some(
      (event) =>
        event.type === 'tool_end' &&
        event.toolName === 'web_fetch' &&
        event.isError === false &&
        /web_fetch_suppressed/.test(event.result),
    ),
    'expected visible suppressed web_fetch result',
  );
}

console.log('[PASS] DmossAgent bridge tool guard/replay/suppression parity tests');
