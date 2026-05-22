#!/usr/bin/env node
/**
 * Focused regression tests for provider-native reasoning history roundtrip.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/reasoning-history-roundtrip.spec.mjs
 */

import assert from 'node:assert/strict';
import { PiAiLLMProvider } from '../dist/provider/index.js';

function modelInfo() {
  return {
    api: 'openai-chat',
    provider: 'post-tool-test',
    id: 'post-tool-test-model',
    reasoning: 'high',
  };
}

async function testMultiToolFollowPayloadKeepsAllPriorReasoningContent() {
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
      {
        role: 'assistant',
        thinking: ['first device-list planner'],
        content: [{ type: 'tool_use', id: 'call_list_devices', name: 'device_list', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_list_devices', content: 'no selected device' }],
      },
      {
        role: 'assistant',
        thinking: ['second network-scan planner'],
        content: [{ type: 'tool_use', id: 'call_scan_network', name: 'device_scan_network', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_scan_network', content: 'found 3 devices' }],
      },
    ],
    maxTokens: 16,
    reasoning: null,
  });

  assert.ok(captured, 'streamFn should be called');
  const assistantWires = captured.context.messages.filter((msg) => msg.role === 'assistant');
  assert.equal(assistantWires.length, 2, 'both assistant tool-use turns should be present');
  assert.deepEqual(
    assistantWires.map((msg) => msg.content.some((block) => block.type === 'thinking')),
    [true, true],
    'Moss/DeepSeek thinking tool loops must pass back every prior assistant reasoning_content, not only the tail tool call',
  );
  assert.equal(
    captured.model.reasoning,
    'high',
    'tool-follow model should retain reasoning marker for history serialization',
  );
  assert.equal(captured.options.reasoning, undefined, 'tool-follow options should still omit new reasoning');
  console.log('  [PASS] multi-tool follow-up keeps all prior reasoning_content while suppressing new reasoning');
}

async function testSplitToolResultsKeepPriorReasoningContent() {
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
      thinking: ['hidden planner text for both tools'],
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'conversation_search',
          input: { query: 'history' },
        },
        {
          type: 'tool_use',
          id: 'call_2',
          name: 'knowledge_lookup',
          input: { query: 'desktop pet' },
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
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_2',
          content: 'found knowledge snippets',
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
    'split tool_result messages must still pass back prior reasoning_content',
  );
  assert.equal(
    captured.model.reasoning,
    'high',
    'split tool follow model should retain reasoning marker for history serialization',
  );
  assert.equal(
    captured.options.reasoning,
    undefined,
    'split tool follow options should omit reasoning',
  );
  console.log('  [PASS] split tool_result messages keep prior reasoning_content');
}

async function testToolFollowKeepsThinkingEvenWhenReasoningConfigIsOff() {
  let captured = null;
  const provider = new PiAiLLMProvider({
    apiKey: 'test-key',
    model: {
      api: 'openai-chat',
      provider: 'post-tool-test',
      id: 'post-tool-test-model',
      reasoning: false,
    },
    reasoning: null,
    streamFn: async function* (model, context, options) {
      captured = { model, context, options };
      yield { type: 'done', stopReason: 'stop' };
    },
  });

  await provider.complete({
    model: 'post-tool-test-model',
    systemPrompt: '',
    messages: [
      {
        role: 'assistant',
        thinking: ['first planner from a gateway that returns reasoning_content by default'],
        content: [{ type: 'tool_use', id: 'call_a', name: 'device_list', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'no device' }],
      },
      {
        role: 'assistant',
        thinking: ['second planner from the same gateway'],
        content: [{ type: 'tool_use', id: 'call_b', name: 'rdk_doc_search_local', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_b', content: 'yolo docs' }],
      },
    ],
    maxTokens: 16,
    reasoning: null,
  });

  assert.ok(captured, 'streamFn should be called');
  const assistantWires = captured.context.messages.filter((msg) => msg.role === 'assistant');
  assert.deepEqual(
    assistantWires.map((msg) => msg.content.some((block) => block.type === 'thinking')),
    [true, true],
    'tool follow-up must preserve existing assistant thinking history even when the configured model reasoning flag is off',
  );
  assert.equal(captured.model.reasoning, false);
  assert.equal(captured.options.reasoning, undefined);
  console.log('  [PASS] tool follow-up keeps existing thinking history even when reasoning config is off');
}

async function testNullRequestReasoningStillKeepsThinkingHistoryMarker() {
  let captured = null;
  const provider = new PiAiLLMProvider({
    apiKey: 'test-key',
    model: { ...modelInfo(), reasoning: true },
    reasoning: null,
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
    reasoning: null,
  });

  assert.ok(captured, 'streamFn should be called');
  const assistantWire = captured.context.messages.find((msg) => msg.role === 'assistant');
  assert.ok(assistantWire, 'assistant message should be present');
  assert.equal(
    assistantWire.content.some((block) => block.type === 'thinking'),
    true,
    'explicit null request reasoning must still pass back prior reasoning_content',
  );
  assert.equal(
    captured.model.reasoning,
    true,
    'explicit null request reasoning must retain model marker for history serialization',
  );
  assert.equal(
    captured.options.reasoning,
    undefined,
    'explicit null request reasoning should only suppress new reasoning effort',
  );
  console.log('  [PASS] null request reasoning still keeps prior reasoning_content');
}

await testMultiToolFollowPayloadKeepsAllPriorReasoningContent();
await testSplitToolResultsKeepPriorReasoningContent();
await testToolFollowKeepsThinkingEvenWhenReasoningConfigIsOff();
await testNullRequestReasoningStillKeepsThinkingHistoryMarker();

console.log('reasoning history roundtrip tests passed');
