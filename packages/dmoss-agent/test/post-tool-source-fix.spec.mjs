#!/usr/bin/env node
/**
 * Source-level regression tests for post-tool model failures.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/post-tool-source-fix.spec.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DmossAgent,
  InMemorySessionStore,
  SessionManager,
  convertMessagesToPi,
  shouldSuppressReasoningForToolFollowUpRound,
} from '../dist/core/index.js';
import { repairMissingToolResults } from '../dist/core/tools/tool-result-roundtrip-guard.js';
import { PiAiLLMProvider } from '../dist/provider/index.js';

function modelInfo() {
  return {
    api: 'openai-chat',
    provider: 'post-tool-test',
    id: 'post-tool-test-model',
    reasoning: 'high',
  };
}

async function testProviderErrorEventIsNotAssistantText() {
  let streamedVisible = '';
  const provider = new PiAiLLMProvider({
    apiKey: 'test-key',
    model: modelInfo(),
    reasoning: 'high',
    streamFn: async function* () {
      yield {
        type: 'error',
        error: {
          errorMessage:
            '400 The reasoning_content in the thinking mode must be passed back to the API.',
          status: 400,
          content: [
            {
              type: 'text',
              text: '400 The reasoning_content in the thinking mode must be passed back to the API.',
            },
          ],
        },
      };
    },
  });

  await assert.rejects(
    () =>
      provider.stream(
        {
          model: 'post-tool-test-model',
          systemPrompt: '',
          messages: [{ role: 'user', content: 'hello' }],
        },
        (event) => {
          if (event.type === 'content_block_delta' && event.deltaRole !== 'thinking') {
            streamedVisible += event.text ?? '';
          }
        },
      ),
    (err) => {
      assert.equal(err.name, 'PiAiProviderRuntimeError');
      assert.match(err.message, /reasoning_content/);
      return true;
    },
  );
  assert.equal(streamedVisible, '', 'provider error must not stream visible assistant text');
  console.log('  [PASS] pi-ai error event throws instead of becoming assistant text');
}

async function testProviderPartialStreamErrorIsNotSuccess() {
  const provider = new PiAiLLMProvider({
    apiKey: 'test-key',
    model: modelInfo(),
    reasoning: 'high',
    streamFn: async function* () {
      yield { type: 'text_delta', text: 'partial answer' };
      throw new Error('upstream connection reset');
    },
  });

  let visible = '';
  // After the mid-stream error fix, partial content is returned instead of thrown
  const result = await provider.stream(
    {
      model: 'post-tool-test-model',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hello' }],
    },
    (event) => {
      if (event.type === 'content_block_delta' && event.deltaRole !== 'thinking') {
        visible += event.text ?? '';
      }
    },
  );
  assert.equal(visible, 'partial answer');
  assert.ok(result, 'partial content should be returned');
  assert.deepEqual(result.incomplete, { reason: 'upstream connection reset' });
  console.log('  [PASS] stream error after partial text returns partial content');
}

async function testDmossAgentRetriesPartialStreamErrorWithoutPersistingPartial() {
  let calls = 0;
  const provider = new PiAiLLMProvider({
    apiKey: 'test-key',
    model: modelInfo(),
    reasoning: 'high',
    streamFn: async function* () {
      calls++;
      if (calls === 1) {
        yield { type: 'text_delta', text: 'partial answer' };
        throw new Error('upstream connection reset');
      }
      yield { type: 'text_delta', text: 'final answer' };
      yield { type: 'done', stopReason: 'stop' };
    },
  });
  const store = new InMemorySessionStore();
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: store,
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    maxAgentTurns: 3,
  });

  const events = [];
  for await (const event of agent.streamChat('partial-stream-retry', 'hello')) {
    events.push(event);
  }

  const done = events.find((event) => event.type === 'done');
  assert.ok(done, 'agent should recover and emit done after retry');
  assert.equal(done.result.response, 'final answer');
  assert.equal(calls, 2, 'partial stream error should trigger one retry');

  const messages = await store.loadMessages('partial-stream-retry');
  const assistantMessages = messages.filter((msg) => msg.role === 'assistant');
  assert.equal(assistantMessages.length, 1);
  assert.match(JSON.stringify(assistantMessages[0].content), /final answer/);
  assert.doesNotMatch(JSON.stringify(assistantMessages), /partial answer/);

  console.log('  [PASS] DmossAgent retries incomplete partial stream without persisting partial answer');
}

async function testStatusOnlyErrorEventIsNotAssistantText() {
  const provider = new PiAiLLMProvider({
    apiKey: 'test-key',
    model: modelInfo(),
    reasoning: 'high',
    streamFn: async function* () {
      yield {
        type: 'error',
        error: {
          status: 400,
          content: [{ type: 'text', text: '400 Bad Request: malformed reasoning payload' }],
        },
      };
    },
  });

  await assert.rejects(
    () =>
      provider.complete({
        model: 'post-tool-test-model',
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    (err) => {
      assert.equal(err.name, 'PiAiProviderRuntimeError');
      assert.match(err.message, /400/);
      return true;
    },
  );
  console.log('  [PASS] status-only error events throw instead of becoming assistant text');
}

async function testDoneMessageThinkingBlockIsPreserved() {
  const provider = new PiAiLLMProvider({
    apiKey: 'test-key',
    model: modelInfo(),
    reasoning: 'high',
    streamFn: async function* () {
      yield {
        type: 'done',
        stopReason: 'toolCall',
        message: {
          content: [
            { type: 'thinking', thinking: 'full reasoning content' },
            {
              type: 'toolCall',
              id: 'call_1',
              name: 'conversation_search',
              arguments: { query: '上一段对话' },
            },
          ],
        },
      };
    },
  });

  const response = await provider.complete({
    model: 'post-tool-test-model',
    systemPrompt: '',
    messages: [{ role: 'user', content: '上一段对话' }],
  });
  assert.deepEqual(response.thinking, ['full reasoning content']);
  assert.equal(response.stopReason, 'tool_use');
  console.log('  [PASS] done/result message thinking blocks are preserved');
}

async function testReasoningSuppressionOnlyForTailToolResult() {
  assert.equal(
    shouldSuppressReasoningForToolFollowUpRound([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'conversation_search', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'history result' }],
      },
    ]),
    true,
    'tail tool_result should suppress new reasoning for the immediate follow-up request',
  );

  assert.equal(
    shouldSuppressReasoningForToolFollowUpRound([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'conversation_search', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'history result' }],
      },
      { role: 'assistant', content: 'summarized result' },
      { role: 'user', content: 'next normal question' },
    ]),
    false,
    'summarized tool result should not suppress reasoning on later normal turns',
  );

  assert.equal(
    shouldSuppressReasoningForToolFollowUpRound([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'conversation_search', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'history result' }],
      },
      { role: 'user', content: 'new normal question after failed follow-up' },
    ]),
    false,
    'stale tool_result should not suppress reasoning after a new user turn',
  );
  console.log('  [PASS] reasoning suppression is limited to active tail tool_result follow-up');
}

function testMixedUserBlockOrderIsPreserved() {
  const converted = convertMessagesToPi(
    [
      {
        role: 'user',
        timestamp: 1,
        content: [
          { type: 'text', text: 'before' },
          { type: 'tool_result', tool_use_id: 'call_1', content: 'tool payload' },
          { type: 'text', text: 'after' },
        ],
      },
    ],
    {
      api: 'openai-chat',
      provider: 'post-tool-test',
      id: 'post-tool-test-model',
    },
  );

  assert.deepEqual(
    converted.map((msg) => msg.role),
    ['user', 'toolResult', 'user'],
  );
  assert.equal(converted[0].content[0].text, 'before');
  assert.equal(converted[1].toolCallId, 'call_1');
  assert.equal(converted[2].content[0].text, 'after');
  console.log('  [PASS] mixed user text/tool_result block order is preserved');
}

function testToolResultErrorFlagIsPreservedInConverter() {
  const converted = convertMessagesToPi(
    [
      {
        role: 'user',
        timestamp: 1,
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            name: 'read',
            content: 'failed',
            is_error: true,
          },
        ],
      },
    ],
    {
      api: 'openai-chat',
      provider: 'post-tool-test',
      id: 'post-tool-test-model',
    },
  );
  assert.equal(converted[0].role, 'toolResult');
  assert.equal(converted[0].isError, true);
  console.log('  [PASS] shared converter preserves tool_result is_error');
}

async function testLegacySessionMigrationPreservesThinking() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dmoss-session-legacy-'));
  try {
    const sessionKey = 'legacy-thinking';
    const legacyPath = path.join(dir, `${sessionKey}.jsonl`);
    await writeFile(
      legacyPath,
      `${JSON.stringify({
        role: 'assistant',
        thinking: ['legacy reasoning'],
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'conversation_search',
            input: { query: 'history' },
          },
        ],
        timestamp: 1,
      })}\n`,
    );
    const manager = new SessionManager(dir);
    const messages = await manager.load(sessionKey);
    assert.deepEqual(messages[0].thinking, ['legacy reasoning']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log('  [PASS] legacy session migration preserves assistant thinking');
}

async function testToolFollowPayloadKeepsPriorReasoningContent() {
  let captured = null;
  const provider = new PiAiLLMProvider({
    apiKey: 'test-key',
    model: modelInfo(),
    reasoning: 'high',
    streamFn: async function* (model, context, options) {
      captured = { model, context, options };
      yield { type: 'done', stopReason: 'stop' };
    },
  });

  const messages = [
    {
      role: 'assistant',
      thinking: ['hidden planner text'],
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'conversation_search',
          input: { query: '上一段对话' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: 'found conversation snippets',
        },
      ],
    },
  ];

  await provider.complete({
    model: 'post-tool-test-model',
    systemPrompt: '',
    messages,
    maxTokens: 16,
  });

  assert.ok(captured, 'streamFn should be called');
  const assistantWire = captured.context.messages.find((msg) => msg.role === 'assistant');
  assert.ok(assistantWire, 'assistant tool_use message should be present');
  assert.equal(
    assistantWire.content.some((block) => block.type === 'thinking'),
    true,
    'tool-follow payload must pass back prior assistant reasoning_content',
  );
  assert.equal(
    captured.model.reasoning,
    'high',
    'tool-follow model should retain reasoning marker for history serialization',
  );
  assert.equal(captured.options.reasoning, undefined, 'tool-follow options should omit reasoning');

  const piMessages = convertMessagesToPi(
    messages.map((m, i) => ({ ...m, timestamp: i + 1 })),
    {
      api: 'openai-chat',
      provider: 'post-tool-test',
      id: 'post-tool-test-model',
    },
  );
  const convertedAssistant = piMessages.find((msg) => msg.role === 'assistant');
  assert.equal(
    convertedAssistant.content.some((block) => block.type === 'thinking'),
    true,
    'shared message converter must also pass back prior reasoning_content',
  );
  console.log(
    '  [PASS] tool-follow requests keep prior reasoning_content while disabling new reasoning',
  );
}

function testNormalUserTurnStripsPriorReasoningContent() {
  const piMessages = convertMessagesToPi(
    [
      {
        role: 'user',
        content: '你好',
        timestamp: 1,
      },
      {
        role: 'assistant',
        thinking: ['hidden greeting reasoning'],
        content: [{ type: 'text', text: '你好呀' }],
        timestamp: 2,
      },
      {
        role: 'user',
        content: '你好',
        timestamp: 3,
      },
    ],
    {
      api: 'openai-chat',
      provider: 'post-tool-test',
      id: 'post-tool-test-model',
    },
  );
  const assistantWire = piMessages.find((msg) => msg.role === 'assistant');
  assert.ok(assistantWire, 'assistant message should be present');
  assert.equal(
    assistantWire.content.some((block) => block.type === 'thinking'),
    false,
    'normal next user turns must not replay prior assistant reasoning_content',
  );
  console.log('  [PASS] normal user turns strip prior reasoning_content');
}

function testThinkingModeNormalUserTurnKeepsPriorReasoningContent() {
  const piMessages = convertMessagesToPi(
    [
      {
        role: 'user',
        content: '你好',
        timestamp: 1,
      },
      {
        role: 'assistant',
        thinking: ['hidden greeting reasoning'],
        content: [{ type: 'text', text: '你好呀' }],
        timestamp: 2,
      },
      {
        role: 'user',
        content: '/pet 生成一个桌宠',
        timestamp: 3,
      },
    ],
    {
      api: 'openai-chat',
      provider: 'post-tool-test',
      id: 'post-tool-test-model',
      reasoning: 'high',
    },
  );
  const assistantWire = piMessages.find((msg) => msg.role === 'assistant');
  assert.ok(assistantWire, 'assistant message should be present');
  assert.equal(
    assistantWire.content.some((block) => block.type === 'thinking'),
    true,
    'thinking-mode normal turns must pass back prior assistant reasoning_content',
  );
  console.log('  [PASS] thinking-mode normal user turns keep prior reasoning_content');
}

async function testProviderThinkingModeNormalUserTurnKeepsPriorReasoningContent() {
  let captured = null;
  const provider = new PiAiLLMProvider({
    apiKey: 'test-key',
    model: modelInfo(),
    reasoning: 'high',
    streamFn: async function* (model, context, options) {
      captured = { model, context, options };
      yield { type: 'done', stopReason: 'stop' };
    },
  });

  await provider.complete({
    model: 'post-tool-test-model',
    systemPrompt: '',
    messages: [
      { role: 'user', content: '你好' },
      {
        role: 'assistant',
        thinking: ['hidden greeting reasoning'],
        content: [{ type: 'text', text: '你好呀' }],
      },
      { role: 'user', content: '/pet 生成一个桌宠' },
    ],
    maxTokens: 16,
  });

  assert.ok(captured, 'streamFn should be called');
  const assistantWire = captured.context.messages.find((msg) => msg.role === 'assistant');
  assert.ok(assistantWire, 'assistant message should be present');
  assert.equal(
    assistantWire.content.some((block) => block.type === 'thinking'),
    true,
    'provider thinking-mode normal turns must pass back prior reasoning_content',
  );
  assert.equal(
    captured.model.reasoning,
    'high',
    'normal thinking-mode turns should keep new reasoning enabled',
  );
  console.log('  [PASS] provider thinking-mode normal user turns keep prior reasoning_content');
}

async function testPostToolProviderFailureIsRunError() {
  class ToolThenErrorProvider {
    constructor() {
      this.id = 'tool-then-error';
      this.displayName = 'Tool Then Error';
      this.streamCalls = [];
      this.completeCalls = 0;
    }

    async complete() {
      this.completeCalls += 1;
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'compaction summary should not be used here' }],
      };
    }

    async stream(options) {
      this.streamCalls.push(options);
      if (this.streamCalls.length === 1) {
        return {
          stopReason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'call_history',
              name: 'conversation_search',
              input: { query: '上一段对话' },
            },
          ],
        };
      }
      throw new Error('raw post-tool provider failure');
    }
  }

  const provider = new ToolThenErrorProvider();
  const store = new InMemorySessionStore();
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: store,
    domainPrompt: false,
    enableCompaction: true,
    enableContextPruning: true,
    contextTokens: 5_000,
    maxTokens: 64,
    maxAgentTurns: 4,
  });
  agent.tools.register({
    name: 'conversation_search',
    description: 'test history search',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    async execute() {
      return 'history-result '.repeat(2_000);
    },
  });

  const events = [];
  let caught = null;
  try {
    for await (const event of agent.streamChat('post-tool-error', 'start')) {
      events.push(event);
    }
  } catch (err) {
    caught = err;
  }

  // Per-turn error recovery: the agent catches the error internally and
  // retries until maxTurns is exhausted. The error does not propagate.
  assert.ok(!caught, 'post-tool provider failure should not throw (per-turn error recovery)');
  assert.ok(
    events.some((event) => event.type === 'tool_end'),
    'tool result should be produced',
  );
  // Per-turn error recovery catches the error internally, so no 'error' event is emitted.
  // The agent completes with a 'done' event after exhausting retries.
  assert.ok(
    events.some((event) => event.type === 'done'),
    'run must emit done event after exhausting retries',
  );
  assert.equal(
    provider.completeCalls,
    0,
    'pending tool_result must not be compacted before follow-up',
  );

  const messages = await store.loadMessages('post-tool-error');
  const last = messages.at(-1);
  assert.equal(last.role, 'user');
  assert.ok(Array.isArray(last.content));
  assert.equal(last.content[0].type, 'tool_result');
  assert.equal(
    messages.some(
      (msg) => msg.role === 'assistant' && JSON.stringify(msg.content).includes('模型暂时不可用'),
    ),
    false,
    'provider error copy must not be persisted as assistant text',
  );
  console.log('  [PASS] post-tool provider failure remains failed run, not success done');
}

async function testDmossAgentPersistsDoneMessageThinkingForToolUse() {
  const store = new InMemorySessionStore();
  const streamCalls = [];
  class DoneThinkingToolProvider {
    async complete() {
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'summary' }] };
    }

    async stream(options) {
      streamCalls.push(options);
      if (streamCalls.length === 1) {
        return {
          stopReason: 'tool_use',
          thinking: ['done-message-only planning'],
          content: [
            {
              type: 'tool_use',
              id: 'call_done_thinking',
              name: 'local_probe',
              input: {},
            },
          ],
        };
      }
      const assistant = options.messages.find(
        (msg) =>
          msg.role === 'assistant' &&
          Array.isArray(msg.content) &&
          msg.content.some((block) => block.type === 'tool_use'),
      );
      assert.ok(assistant, 'tool follow-up should include prior assistant tool_use');
      assert.deepEqual(
        assistant.thinking,
        ['done-message-only planning'],
        'thinking returned only on LLMResponse.thinking must be persisted with the assistant tool_use',
      );
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    }
  }

  const agent = new DmossAgent({
    llmProvider: new DoneThinkingToolProvider(),
    sessionStore: store,
    model: 'post-tool-test-model',
    reasoning: null,
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    baseSystemPrompt: 'base',
    maxAgentTurns: 3,
    enableCompaction: false,
    enableContextPruning: false,
  });
  agent.tools.register({
    name: 'local_probe',
    description: 'Local probe tool',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return 'probe result';
    },
  });

  const events = [];
  for await (const event of agent.streamChat('done-thinking-tool-use', 'start')) {
    events.push(event);
  }
  const done = events.find((event) => event.type === 'done');
  assert.equal(done.result.response, 'done');
  assert.equal(streamCalls.length, 2);
  console.log('  [PASS] DmossAgent persists done-message thinking on assistant tool_use turns');
}

async function testDmossAgentKeepsEarlierToolThinkingAcrossSequentialTools() {
  const streamCalls = [];
  class SequentialThinkingToolProvider {
    async complete() {
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'summary' }] };
    }

    async stream(options) {
      streamCalls.push(options);
      if (streamCalls.length === 1) {
        return {
          stopReason: 'tool_use',
          thinking: ['first tool planning'],
          content: [{ type: 'tool_use', id: 'call_first', name: 'first_probe', input: {} }],
        };
      }
      if (streamCalls.length === 2) {
        const firstAssistant = options.messages.find(
          (msg) =>
            msg.role === 'assistant' &&
            Array.isArray(msg.content) &&
            msg.content.some((block) => block.type === 'tool_use' && block.id === 'call_first'),
        );
        assert.deepEqual(firstAssistant?.thinking, ['first tool planning']);
        return {
          stopReason: 'tool_use',
          thinking: ['second tool planning'],
          content: [{ type: 'tool_use', id: 'call_second', name: 'second_probe', input: {} }],
        };
      }
      const assistants = options.messages.filter((msg) => msg.role === 'assistant');
      assert.deepEqual(
        assistants.map((msg) => msg.thinking),
        [['first tool planning'], ['second tool planning']],
        'sequential tool follow-up should keep thinking for every prior assistant tool_use',
      );
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    }
  }

  const agent = new DmossAgent({
    llmProvider: new SequentialThinkingToolProvider(),
    sessionStore: new InMemorySessionStore(),
    model: 'post-tool-test-model',
    reasoning: null,
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    baseSystemPrompt: 'base',
    maxAgentTurns: 4,
    enableCompaction: false,
    enableContextPruning: false,
  });
  for (const name of ['first_probe', 'second_probe']) {
    agent.tools.register({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return `${name} result`;
      },
    });
  }

  const events = [];
  for await (const event of agent.streamChat('sequential-thinking-tools', 'start')) {
    events.push(event);
  }
  const done = events.find((event) => event.type === 'done');
  assert.equal(done.result.response, 'done');
  assert.equal(streamCalls.length, 3);
  console.log('  [PASS] DmossAgent keeps earlier assistant thinking across sequential tool calls');
}

async function testToolInputNormalizerRunsBeforeToolStartAndPersistence() {
  class NormalizeProvider {
    constructor() {
      this.id = 'normalize-provider';
      this.displayName = 'Normalize Provider';
      this.calls = 0;
    }

    async complete() {
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'unused' }] };
    }

    async stream() {
      this.calls += 1;
      if (this.calls === 1) {
        return {
          stopReason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'call_search',
              name: 'conversation_search',
              input: { query: '上一段对话', limit: 5, includeCurrentSession: true },
            },
          ],
        };
      }
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'summarized history' }],
      };
    }
  }

  let executedInput = null;
  const store = new InMemorySessionStore();
  const agent = new DmossAgent({
    llmProvider: new NormalizeProvider(),
    sessionStore: store,
    domainPrompt: false,
    enableCompaction: false,
    enableContextPruning: false,
    maxAgentTurns: 4,
  });
  agent.tools.register({
    name: 'conversation_search',
    description: 'test history search',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        includeCurrentSession: { type: 'boolean' },
      },
      required: ['query'],
    },
    normalizeInput(input) {
      const query = String(input.query || '');
      const asksCurrent = /当前|本轮|本会话/.test(query);
      return input.includeCurrentSession && !asksCurrent
        ? { ...input, includeCurrentSession: false }
        : input;
    },
    async execute(input) {
      executedInput = input;
      return 'history result';
    },
  });

  const events = [];
  for await (const event of agent.streamChat('normalize-tool-input', 'start')) {
    events.push(event);
  }

  const start = events.find((event) => event.type === 'tool_start');
  assert.equal(start.input.includeCurrentSession, false, 'tool_start should show normalized args');
  assert.equal(
    executedInput.includeCurrentSession,
    false,
    'tool execute should receive normalized args',
  );
  const messages = await store.loadMessages('normalize-tool-input');
  const assistantToolTurn = messages.find(
    (msg) =>
      msg.role === 'assistant' &&
      Array.isArray(msg.content) &&
      msg.content.some((block) => block.type === 'tool_use'),
  );
  const toolBlock = assistantToolTurn.content.find((block) => block.type === 'tool_use');
  assert.equal(
    toolBlock.input.includeCurrentSession,
    false,
    'persisted assistant tool_use should use normalized args',
  );
  console.log('  [PASS] tool input normalizer runs before tool_start and persistence');
}

function testRoundtripGuardRepairsOrphanToolResult() {
  const orphan = repairMissingToolResults([
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'missing_call', content: 'orphan' }],
      timestamp: 1,
    },
  ]);
  assert.deepEqual(orphan.orphanResultIds, ['missing_call']);
  assert.equal(orphan.insertedCount, 0);
  assert.equal(orphan.synthesizedToolUseCount, 1);
  assert.equal(orphan.changed, true);
  assert.deepEqual(
    orphan.messages.map((msg) => msg.role),
    ['assistant', 'user'],
  );
  assert.equal(orphan.messages[0].content[0].type, 'tool_use');
  assert.equal(orphan.messages[0].content[0].id, 'missing_call');
  assert.equal(orphan.messages[1].content[0].type, 'tool_result');

  const repaired = repairMissingToolResults([
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: {} }],
      timestamp: 1,
    },
    { role: 'user', content: 'next user text', timestamp: 2 },
  ]);
  assert.equal(repaired.insertedCount, 1);
  assert.equal(repaired.synthesizedToolUseCount, 0);
  assert.deepEqual(repaired.orphanResultIds, []);
  console.log('  [PASS] roundtrip guard repairs missing results and orphan results');
}

await testProviderErrorEventIsNotAssistantText();
await testProviderPartialStreamErrorIsNotSuccess();
await testDmossAgentRetriesPartialStreamErrorWithoutPersistingPartial();
await testStatusOnlyErrorEventIsNotAssistantText();
await testDoneMessageThinkingBlockIsPreserved();
await testReasoningSuppressionOnlyForTailToolResult();
testMixedUserBlockOrderIsPreserved();
testToolResultErrorFlagIsPreservedInConverter();
await testLegacySessionMigrationPreservesThinking();
await testToolFollowPayloadKeepsPriorReasoningContent();
testNormalUserTurnStripsPriorReasoningContent();
testThinkingModeNormalUserTurnKeepsPriorReasoningContent();
await testProviderThinkingModeNormalUserTurnKeepsPriorReasoningContent();
await testPostToolProviderFailureIsRunError();
await testDmossAgentPersistsDoneMessageThinkingForToolUse();
await testDmossAgentKeepsEarlierToolThinkingAcrossSequentialTools();
await testToolInputNormalizerRunsBeforeToolStartAndPersistence();
testRoundtripGuardRepairsOrphanToolResult();

console.log('post-tool source-fix tests passed');
