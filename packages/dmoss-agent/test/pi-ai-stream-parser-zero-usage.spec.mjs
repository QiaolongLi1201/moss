#!/usr/bin/env node
/**
 * Test that processEvent handles usage with 0 tokens correctly.
 * Regression test for: Incomplete usage mapping when event has no message.usage fallback
 */

import assert from 'node:assert/strict';
import { processEvent } from '../dist/provider/pi-ai-stream-parser.js';

const content = [];
const thinkingChunks = [];

// Event with 0 output tokens (valid but falsy) should still extract usage
const event = {
  type: 'done',
  stopReason: 'stop',
  message: undefined,
  usage: { input: 10, output: 0 }, // output is 0 (falsy but valid)
};

const result = processEvent(event, content, (url) => url, thinkingChunks);

assert.notStrictEqual(
  result.usage,
  undefined,
  'usage should not be undefined when event.usage has 0 tokens'
);
assert.strictEqual(
  result.usage?.inputTokens,
  10,
  'should preserve input tokens'
);
assert.strictEqual(
  result.usage?.outputTokens,
  0,
  'should preserve output tokens even when 0'
);

console.log('[PASS] processEvent correctly handles usage with 0 tokens');
