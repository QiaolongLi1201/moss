#!/usr/bin/env node
/**
 * Test that convertStreamEvent correctly maps 'length' to 'max_tokens'.
 * Regression test for: convertStreamEvent missing max_tokens stop reason mapping
 */

import assert from 'node:assert/strict';
import { convertStreamEvent } from '../dist/provider/pi-ai-stream-parser.js';

// Test stopReason='length' maps to 'max_tokens'
const maxTokensEvent = {
  type: 'done',
  stopReason: 'length',
  reason: undefined,
};

const result = convertStreamEvent(maxTokensEvent);

assert.strictEqual(result.type, 'message_delta', 'event type should be message_delta');
assert.strictEqual(
  result.stopReason,
  'max_tokens',
  'stopReason="length" should map to "max_tokens", not "end_turn"'
);

// Test that 'stop' still maps to 'end_turn'
const endTurnEvent = {
  type: 'result',
  stopReason: 'stop',
  reason: undefined,
};

const endTurnResult = convertStreamEvent(endTurnEvent);
assert.strictEqual(endTurnResult.stopReason, 'end_turn');

// Test that 'toolCall' still maps to 'tool_use'
const toolUseEvent = {
  type: 'result',
  stopReason: 'toolCall',
  reason: undefined,
};

const toolUseResult = convertStreamEvent(toolUseEvent);
assert.strictEqual(toolUseResult.stopReason, 'tool_use');

console.log('[PASS] convertStreamEvent correctly maps all stop reasons including max_tokens');
