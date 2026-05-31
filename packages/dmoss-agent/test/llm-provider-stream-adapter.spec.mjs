#!/usr/bin/env node
/**
 * Self-test for LLMProvider → pi-ai StreamFunction adapter.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/llm-provider-stream-adapter.spec.mjs
 */

import assert from 'node:assert/strict';
import { createStreamFunctionFromLlmProvider } from '../dist/core/index.js';

const requests = [];
const provider = {
  id: 'fake',
  displayName: 'Fake Provider',
  async complete() {
    throw new Error('unused');
  },
  async stream(options, onEvent) {
    requests.push(options);
    onEvent({ type: 'content_block_delta', text: 'hello ', deltaRole: 'visible' });
    onEvent({ type: 'content_block_delta', text: 'thinking', deltaRole: 'thinking' });
    onEvent({ type: 'content_block_delta', text: 'world', deltaRole: 'visible' });
    return {
      stopReason: 'tool_use',
      thinking: ['thinking'],
      content: [
        { type: 'text', text: 'hello world' },
        { type: 'tool_use', id: 'call-1', name: 'probe', input: { value: 1 } },
      ],
      usage: { inputTokens: 3, outputTokens: 5 },
    };
  },
};

const streamFn = createStreamFunctionFromLlmProvider({ provider });
const stream = streamFn(
  {
    id: 'fake-model',
    name: 'Fake Model',
    api: 'openai-completions',
    provider: 'fake',
    baseUrl: 'http://fake',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    systemPrompt: 'system',
    systemPromptParts: { stable: 'stable system', dynamic: 'dynamic turn' },
    messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
    tools: [
      {
        name: 'probe',
        description: 'Probe',
        parameters: { type: 'object', properties: { value: { type: 'number' } } },
      },
    ],
  },
  { maxTokens: 128, temperature: 0.2, reasoning: 'low' },
);

const events = [];
for await (const event of stream) {
  events.push(event);
}
const result = await stream.result();

assert.equal(requests.length, 1);
assert.equal(requests[0].model, 'fake-model');
assert.equal(requests[0].systemPrompt, 'system');
assert.deepEqual(requests[0].systemPromptParts, {
  stable: 'stable system',
  dynamic: 'dynamic turn',
});
assert.equal(requests[0].messages[0].role, 'user');
assert.equal(requests[0].messages[0].content, 'hi');
assert.equal(requests[0].tools[0].name, 'probe');
assert.equal(requests[0].maxTokens, 128);
assert.equal(requests[0].temperature, 0.2);
assert.equal(requests[0].reasoning, 'low');

assert.equal(
  events.filter((event) => event.type === 'text_delta').map((event) => event.delta).join(''),
  'hello world',
);
assert(events.some((event) => event.type === 'thinking_delta' && event.delta === 'thinking'));
assert(events.some((event) => event.type === 'text_end' && event.content === 'hello world'));
assert(events.some((event) => event.type === 'toolcall_end' && event.toolCall.name === 'probe'));
assert.equal(result.stopReason, 'toolUse');
assert.equal(result.usage.input, 3);
assert.equal(result.usage.output, 5);

{
  const inlineEvents = [];
  const inlineProvider = {
    id: 'inline',
    displayName: 'Inline Provider',
    async complete() {
      throw new Error('unused');
    },
    async stream(_options, onEvent) {
      onEvent({ type: 'content_block_delta', text: 'say <thinking>plan</thinking> done', deltaRole: 'visible' });
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'say <thinking>plan</thinking> done' }],
        usage: { inputTokens: 1, outputTokens: 2 },
      };
    },
  };
  const inlineStream = createStreamFunctionFromLlmProvider({ provider: inlineProvider })(
    {
      id: 'inline-model',
      name: 'Inline Model',
      api: 'openai-completions',
      provider: 'inline',
      baseUrl: 'http://inline',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    { systemPrompt: '', messages: [], tools: [] },
  );
  for await (const event of inlineStream) inlineEvents.push(event);
  const inlineResult = await inlineStream.result();

  assert(inlineEvents.some((event) => event.type === 'text_delta' && event.delta === 'say '));
  assert(inlineEvents.some((event) => event.type === 'thinking_delta' && event.delta === 'plan'));
  assert(inlineEvents.some((event) => event.type === 'text_delta' && event.delta === ' done'));
  assert(inlineEvents.some((event) => event.type === 'text_end' && event.content === 'say  done'));
  assert(inlineResult.content.some((block) => block.type === 'thinking' && block.thinking === 'plan'));
  assert(inlineResult.content.some((block) => block.type === 'text' && block.text === 'say  done'));
}

{
  const nativeEvents = [];
  const nativeProvider = {
    id: 'native',
    displayName: 'Native Provider',
    async complete() {
      throw new Error('unused');
    },
    async stream(_options, onEvent) {
      onEvent({ type: 'content_block_delta', text: '<thinking>literal</thinking>', deltaRole: 'thinking' });
      return {
        stopReason: 'end_turn',
        thinking: ['<thinking>literal</thinking>'],
        content: [{ type: 'text', text: 'answer' }],
        usage: { inputTokens: 1, outputTokens: 2 },
      };
    },
  };
  const nativeStream = createStreamFunctionFromLlmProvider({ provider: nativeProvider })(
    {
      id: 'native-model',
      name: 'Native Model',
      api: 'openai-completions',
      provider: 'native',
      baseUrl: 'http://native',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    { systemPrompt: '', messages: [], tools: [] },
  );
  for await (const event of nativeStream) nativeEvents.push(event);
  const nativeResult = await nativeStream.result();

  assert(nativeEvents.some(
    (event) => event.type === 'thinking_delta' && event.delta === '<thinking>literal</thinking>',
  ));
  assert(nativeResult.content.some(
    (block) => block.type === 'thinking' && block.thinking === '<thinking>literal</thinking>',
  ));
}

console.log('[PASS] LLMProvider stream adapter bridges provider events to pi-ai stream events');

// ── Non-streaming provider: capabilities.streaming === false ──
{
  let completeCalled = false;
  let streamCalled = false;
  const nonStreamingProvider = {
    id: 'non-streaming',
    displayName: 'Non-Streaming Provider',
    capabilities: { streaming: false },
    async complete(options) {
      completeCalled = true;
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'complete response' }],
        usage: { inputTokens: 2, outputTokens: 3 },
      };
    },
    async stream(_options, _onEvent) {
      streamCalled = true;
      throw new Error('stream() should not be called for non-streaming provider');
    },
  };
  const nsStream = createStreamFunctionFromLlmProvider({ provider: nonStreamingProvider })(
    {
      id: 'ns-model',
      name: 'NS Model',
      api: 'openai-completions',
      provider: 'non-streaming',
      baseUrl: 'http://ns',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    { systemPrompt: '', messages: [{ role: 'user', content: 'hi', timestamp: 1 }], tools: [] },
  );
  const nsEvents = [];
  for await (const event of nsStream) nsEvents.push(event);
  const nsResult = await nsStream.result();

  assert.equal(completeCalled, true, 'complete() must be called for non-streaming provider');
  assert.equal(streamCalled, false, 'stream() must NOT be called for non-streaming provider');
  assert(nsEvents.some((e) => e.type === 'text_end' && e.content === 'complete response'));
  assert(nsEvents.some((e) => e.type === 'done'));
  assert.equal(nsResult.stopReason, 'stop');
  assert.equal(nsResult.usage.input, 2);
  assert.equal(nsResult.usage.output, 3);
  console.log('[PASS] Non-streaming provider uses complete() and emits synthetic events');
}

// ── Hook ordering snapshot: provider terminal event precedes onResponse ──
{
  const hookOrder = [];
  const terminalProvider = {
    id: 'terminal',
    displayName: 'Terminal Provider',
    async complete() {
      throw new Error('unused');
    },
    async stream(_options, onEvent) {
      onEvent({ type: 'message_start' });
      onEvent({ type: 'content_block_delta', text: 'done', deltaRole: 'visible' });
      onEvent({ type: 'message_stop' });
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const terminalStream = createStreamFunctionFromLlmProvider({
    provider: terminalProvider,
    onProviderEvent: (event) => hookOrder.push(`provider:${event.type}`),
    onResponse: () => hookOrder.push('onResponse'),
    onError: () => hookOrder.push('onError'),
  })(
    {
      id: 'terminal-model',
      name: 'Terminal Model',
      api: 'openai-completions',
      provider: 'terminal',
      baseUrl: 'http://terminal',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    { systemPrompt: '', messages: [{ role: 'user', content: 'hi', timestamp: 1 }], tools: [] },
  );
  const terminalEvents = [];
  for await (const event of terminalStream) terminalEvents.push(event);

  assert.deepEqual(hookOrder, [
    'provider:message_start',
    'provider:content_block_delta',
    'provider:message_stop',
    'onResponse',
  ]);
  assert.equal(terminalEvents.filter((event) => event.type === 'done').length, 1);
  console.log('[PASS] onResponse runs once after provider terminal events');
}

// ── Incomplete provider responses are failures, not completed responses ──
{
  const responses = [];
  const errors = [];
  const incompleteProvider = {
    id: 'incomplete',
    displayName: 'Incomplete Provider',
    async complete() {
      throw new Error('unused');
    },
    async stream(_options, onEvent) {
      onEvent({ type: 'content_block_delta', text: 'partial', deltaRole: 'visible' });
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'partial' }],
        incomplete: { reason: 'stream_error' },
      };
    },
  };
  const incompleteStream = createStreamFunctionFromLlmProvider({
    provider: incompleteProvider,
    onResponse: (response) => {
      responses.push(response);
    },
    onError: (error) => {
      errors.push(error);
    },
  })(
    {
      id: 'incomplete-model',
      name: 'Incomplete Model',
      api: 'openai-completions',
      provider: 'incomplete',
      baseUrl: 'http://incomplete',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    { systemPrompt: '', messages: [{ role: 'user', content: 'hi', timestamp: 1 }], tools: [] },
  );
  const incompleteEvents = [];
  for await (const event of incompleteStream) incompleteEvents.push(event);
  const incompleteResult = await incompleteStream.result();

  assert.equal(responses.length, 0, 'incomplete responses must not trigger onResponse');
  assert.equal(errors.length, 1, 'incomplete responses should trigger onError');
  assert(incompleteEvents.some((event) => event.type === 'error'));
  assert.equal(incompleteResult.stopReason, 'error');
  console.log('[PASS] Incomplete provider responses do not trigger completed-response hooks');
}
