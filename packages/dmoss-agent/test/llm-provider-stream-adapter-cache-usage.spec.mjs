#!/usr/bin/env node
/**
 * Test that mapUsage correctly includes cache tokens in totalTokens.
 * Regression test for: totalTokens calculation excludes cache tokens
 */

import assert from 'node:assert/strict';
import { createStreamFunctionFromLlmProvider } from '../dist/core/index.js';

const cacheProvider = {
  id: 'cache-test',
  displayName: 'Cache Test Provider',
  async complete() {
    throw new Error('unused');
  },
  async stream(_options, onEvent) {
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'response' }],
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 30,
        cacheCreationTokens: 20,
      },
    };
  },
};

const streamFn = createStreamFunctionFromLlmProvider({ provider: cacheProvider });
const stream = streamFn(
  {
    id: 'cache-model',
    name: 'Cache Model',
    api: 'anthropic',
    provider: 'cache-test',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  { systemPrompt: '', messages: [], tools: [] },
);

const events = [];
for await (const event of stream) {
  events.push(event);
}
const result = await stream.result();

// Verify cache tokens are included in totalTokens
assert.strictEqual(result.usage.input, 100, 'input tokens should be 100');
assert.strictEqual(result.usage.output, 50, 'output tokens should be 50');
assert.strictEqual(result.usage.cacheRead, 30, 'cache read tokens should be 30');
assert.strictEqual(result.usage.cacheWrite, 20, 'cache write tokens should be 20');

// The key assertion: totalTokens must include cache tokens
assert.strictEqual(
  result.usage.totalTokens,
  200,
  'totalTokens should be input(100) + output(50) + cacheRead(30) + cacheWrite(20) = 200'
);

console.log('[PASS] mapUsage correctly includes cache tokens in totalTokens calculation');
