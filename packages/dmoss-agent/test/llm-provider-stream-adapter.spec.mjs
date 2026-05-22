#!/usr/bin/env node
/**
 * Self-test for LLMProvider → pi-ai StreamFunction adapter.
 *
 * Run:
 *   npm run build -w @dmoss/agent
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
