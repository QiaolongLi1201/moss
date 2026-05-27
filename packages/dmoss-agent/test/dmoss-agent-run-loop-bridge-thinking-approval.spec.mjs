#!/usr/bin/env node
/**
 * Parity tests for DmossAgent.streamChat -> runAgentLoop bridge
 * thinking routing and tool approval denial.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/dmoss-agent-run-loop-bridge-thinking-approval.spec.mjs
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

async function collectEvents(agent, sessionKey, userMessage) {
  const events = [];
  for await (const event of agent.streamChat(sessionKey, userMessage)) {
    events.push(event);
  }
  return events;
}

function getDone(events) {
  const done = events.find((event) => event.type === 'done');
  assert(done, 'expected done event');
  return done;
}

{
  const store = new InMemorySessionStore();
  const { provider, requests } = createModelEventProvider((_options, onEvent) => {
    onEvent({
      type: 'content_block_delta',
      text: '<thinking>check hidden plan</thinking>visible answer',
      deltaRole: 'visible',
    });
    return {
      stopReason: 'end_turn',
      content: [
        { type: 'text', text: '<thinking>check hidden plan</thinking>visible answer' },
      ],
      usage: { inputTokens: 2, outputTokens: 3 },
    };
  });
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: store,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    maxAgentTurns: 3,
  });

  const events = await collectEvents(agent, 'bridge-inline-thinking', 'think inline');
  const thinkingText = events
    .filter((event) => event.type === 'thinking_delta')
    .map((event) => event.delta)
    .join('');
  const visibleText = events
    .filter((event) => event.type === 'text_delta')
    .map((event) => event.delta)
    .join('');
  const done = getDone(events);

  assert.equal(thinkingText, 'check hidden plan');
  assert.deepEqual(done.result.thinking, ['check hidden plan']);
  assert.equal(visibleText, 'visible answer');
  assert.equal(done.result.response, 'visible answer');
  assert(!done.result.response.includes('<thinking>'));
  assert(!done.result.response.includes('</thinking>'));
  assert.equal(requests.length, 1);
}

{
  const store = new InMemorySessionStore();
  const { provider, requests } = createModelEventProvider((_options, onEvent) => {
    onEvent({
      type: 'content_block_delta',
      text: 'native hidden plan',
      deltaRole: 'thinking',
    });
    onEvent({
      type: 'content_block_delta',
      text: 'native visible answer',
      deltaRole: 'visible',
    });
    return {
      stopReason: 'end_turn',
      thinking: ['native hidden plan'],
      content: [{ type: 'text', text: 'native visible answer' }],
      usage: { inputTokens: 2, outputTokens: 3 },
    };
  });
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: store,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    maxAgentTurns: 3,
  });

  const events = await collectEvents(agent, 'bridge-native-thinking', 'think native');
  const thinkingText = events
    .filter((event) => event.type === 'thinking_delta')
    .map((event) => event.delta)
    .join('');
  const done = getDone(events);

  assert.equal(thinkingText, 'native hidden plan');
  assert.deepEqual(done.result.thinking, ['native hidden plan']);
  assert.equal(done.result.response, 'native visible answer');
  assert(!done.result.response.includes('<thinking>'));
  assert.equal(requests.length, 1);
}

{
  const store = new InMemorySessionStore();
  const { provider, requests } = createModelEventProvider((_options, onEvent) => {
    onEvent({
      type: 'content_block_delta',
      text: 'only hidden plan',
      deltaRole: 'thinking',
    });
    return {
      stopReason: 'end_turn',
      thinking: ['only hidden plan'],
      content: [],
      usage: { inputTokens: 2, outputTokens: 3 },
    };
  });
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: store,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    maxAgentTurns: 3,
  });

  const events = await collectEvents(agent, 'bridge-thinking-only', 'think only');
  const done = getDone(events);
  const stored = await store.loadMessages('bridge-thinking-only');

  assert.deepEqual(done.result.thinking, ['only hidden plan']);
  assert.match(done.result.response, /模型产出了推理过程/);
  assert(
    stored.every((message) => message.role !== 'assistant'),
    'thinking-only turns must not persist an empty assistant message',
  );
  assert.equal(requests.length, 1);
}

{
  const store = new InMemorySessionStore();
  let executeCount = 0;
  const { provider, requests } = createModelEventProvider((_options, onEvent, requestNo) => {
    if (requestNo === 1) {
      return {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'call-safe-1', name: 'safe_probe', input: { value: 7 } }],
        usage: { inputTokens: 2, outputTokens: 3 },
      };
    }
    if (requestNo === 2) {
      onEvent({
        type: 'content_block_delta',
        text: 'post-tool hidden plan',
        deltaRole: 'thinking',
      });
      return {
        stopReason: 'end_turn',
        thinking: ['post-tool hidden plan'],
        content: [],
        usage: { inputTokens: 4, outputTokens: 5 },
      };
    }
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'visible post-tool summary' }],
      usage: { inputTokens: 6, outputTokens: 7 },
    };
  });
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: store,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    maxAgentTurns: 4,
  });
  agent.tools.register({
    name: 'safe_probe',
    description: 'Safe probe',
    inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    async execute() {
      executeCount += 1;
      return 'probe result OK';
    },
  });

  const events = await collectEvents(
    agent,
    'bridge-post-tool-thinking-only-retry',
    'use safe probe',
  );
  const done = getDone(events);
  const stored = await store.loadMessages('bridge-post-tool-thinking-only-retry');

  assert.equal(done.result.response, 'visible post-tool summary');
  assert(!done.result.response.includes('模型产出了推理过程'));
  assert.equal(done.result.toolCalls.length, 1);
  assert.equal(done.result.toolResults.length, 1);
  assert.equal(executeCount, 1);
  assert.equal(requests.length, 3);
  assert(
    stored.every(
      (message) =>
        message.role !== 'assistant' ||
        !Array.isArray(message.content) ||
        message.content.length > 0,
    ),
    'post-tool thinking-only retry must not persist an empty assistant message',
  );
}

{
  const store = new InMemorySessionStore();
  let executeCount = 0;
  const approvals = [];
  const { provider, requests } = createModelEventProvider((options) => {
    const hasToolResult = options.messages.some((message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'tool_result'),
    );
    if (!hasToolResult) {
      return {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'call-denied-1', name: 'danger_probe', input: { value: 9 } }],
        usage: { inputTokens: 2, outputTokens: 3 },
      };
    }
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'saw denied tool result' }],
      usage: { inputTokens: 4, outputTokens: 5 },
    };
  });
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: store,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    maxAgentTurns: 4,
    hooks: {
      async onBeforeToolExec(request) {
        approvals.push(request);
        return { approved: false, reason: 'blocked by test' };
      },
    },
  });
  agent.tools.register({
    name: 'danger_probe',
    description: 'Danger probe',
    inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    async execute() {
      executeCount += 1;
      return 'should not run';
    },
  });

  const events = await collectEvents(agent, 'bridge-approval-denied', 'use dangerous tool');
  const done = getDone(events);
  const toolEnd = events.find(
    (event) => event.type === 'tool_end' && event.toolName === 'danger_probe',
  );

  assert(toolEnd, 'expected denied tool_end event');
  assert.equal(toolEnd.isError, true);
  assert.match(toolEnd.result, /denied/i);
  assert.match(toolEnd.result, /blocked by test/);
  assert.equal(executeCount, 0);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].tool.name, 'danger_probe');
  assert.deepEqual(approvals[0].input, { value: 9 });
  assert.equal(done.result.response, 'saw denied tool result');
  assert.equal(done.result.toolCalls.length, 1);
  assert.equal(done.result.toolCalls[0].name, 'danger_probe');
  assert.equal(done.result.toolResults.length, 1);
  assert.equal(done.result.toolResults[0].isError, true);
  assert.match(done.result.toolResults[0].content, /denied/i);
  assert.match(done.result.toolResults[0].content, /blocked by test/);
  const storedToolResult = (await store.loadMessages('bridge-approval-denied'))
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .find((block) => block.type === 'tool_result' && block.tool_use_id === 'call-denied-1');
  assert(storedToolResult, 'expected denied tool_result to be persisted');
  assert.equal(storedToolResult.is_error, true);
  assert.match(String(storedToolResult.content), /blocked by test/);
  assert(requests.length >= 2, 'expected provider tool-call round and follow-up round');
  assert(
    requests[0].tools?.some((tool) => tool.name === 'danger_probe'),
    'expected provider request to include callable tool declaration',
  );
  assert(
    requests.some((request) =>
      request.messages.some((message) =>
        Array.isArray(message.content) &&
        message.content.some(
          (block) =>
            block.type === 'tool_result' &&
            block.tool_use_id === 'call-denied-1' &&
            /denied/i.test(String(block.content)) &&
            /blocked by test/.test(String(block.content)),
        ),
      ),
    ),
    'expected denied tool result to be sent back to provider',
  );
}

{
  const store = new InMemorySessionStore();
  let executeCount = 0;
  const { provider, requests } = createModelEventProvider((_options, _onEvent, requestNo) => {
    if (requestNo === 1) {
      return {
        stopReason: 'tool_use',
        thinking: ['first hidden tool plan'],
        content: [{ type: 'tool_use', id: 'call-first', name: 'safe_probe', input: { value: 1 } }],
        usage: { inputTokens: 2, outputTokens: 3 },
      };
    }
    if (requestNo === 2) {
      return {
        stopReason: 'tool_use',
        thinking: ['second hidden tool plan'],
        content: [{ type: 'tool_use', id: 'call-second', name: 'safe_probe', input: { value: 2 } }],
        usage: { inputTokens: 4, outputTokens: 5 },
      };
    }
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'finished both probes' }],
      usage: { inputTokens: 6, outputTokens: 7 },
    };
  });
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: store,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    maxAgentTurns: 5,
    roundTripAssistantThinking: true,
  });
  agent.tools.register({
    name: 'safe_probe',
    description: 'Safe probe',
    inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    async execute() {
      executeCount += 1;
      return `probe ${executeCount} OK`;
    },
  });

  const events = await collectEvents(
    agent,
    'bridge-roundtrip-all-thinking-tool-chain',
    'run both probes',
  );
  const done = getDone(events);
  const thirdRequestAssistants = requests[2].messages.filter(
    (message) => message.role === 'assistant',
  );

  assert.equal(done.result.response, 'finished both probes');
  assert.equal(executeCount, 2);
  assert.equal(requests.length, 3);
  assert.deepEqual(
    thirdRequestAssistants.map((message) => message.thinking),
    [['first hidden tool plan'], ['second hidden tool plan']],
    'tool-result follow-up must keep reasoning_content for resolved and unresolved assistant tool turns',
  );
}

console.log('[PASS] DmossAgent runAgentLoop bridge routes thinking and denied approvals');
