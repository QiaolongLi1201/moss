#!/usr/bin/env node
/**
 * Test: OpenAI/Anthropic tool parameter parse failures
 *
 * Verifies that malformed tool call arguments throw PROVIDER_UPSTREAM_ERROR
 * instead of silently using empty input.
 */

import assert from 'node:assert/strict';
import { OpenAILLMProvider } from '../dist/provider/openai.js';
import { AnthropicLLMProvider } from '../dist/provider/anthropic.js';
import { DmossError, ErrorCode } from '../dist/errors.js';

// Mock fetch for OpenAI provider
const mockOpenAIFetch = (response) => {
  return async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'application/json']]),
    json: async () => response,
    text: async () => JSON.stringify(response),
  });
};

console.log('[TEST] OpenAI malformed tool call arguments');
{
  const provider = new OpenAILLMProvider({
    apiKey: 'test-key',
    baseUrl: 'http://localhost:9999',
  });

  // Mock SSE stream with malformed tool call arguments
  const mockSSEStream = () => {
    const encoder = new TextEncoder();
    const events = [
      'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"test_tool","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{ invalid json }"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ];
    let index = 0;
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/event-stream']]),
      body: {
        getReader: () => ({
          read: async () => {
            if (index >= events.length) return { done: true };
            return { done: false, value: encoder.encode(events[index++]) };
          },
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    };
  };

  // Replace global fetch with mock
  const originalFetch = global.fetch;
  global.fetch = mockSSEStream;

  try {
    await provider.complete({
      model: 'gpt-4',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{
        name: 'test_tool',
        description: 'test',
        input_schema: { type: 'object', properties: {} },
      }],
    });
    assert.fail('Should have thrown PROVIDER_UPSTREAM_ERROR');
  } catch (err) {
    assert.ok(err instanceof DmossError, 'Should be DmossError');
    assert.equal(err.code, ErrorCode.PROVIDER_UPSTREAM_ERROR, `Expected PROVIDER_UPSTREAM_ERROR, got ${err.code}`);
    console.log('  Error message:', err.message);
    assert.ok(err.message.includes('malformed') || err.message.includes('parse'), 'Error message should mention malformed/parse');
    console.log('  ✓ OpenAI malformed arguments throw PROVIDER_UPSTREAM_ERROR');
  } finally {
    global.fetch = originalFetch;
  }
}

console.log('[TEST] Anthropic malformed tool call arguments');
{
  const provider = new AnthropicLLMProvider({
    apiKey: 'test-key',
    baseUrl: 'http://localhost:9999',
  });

  // Mock SSE stream with malformed tool input
  const mockSSEStream = () => {
    const encoder = new TextEncoder();
    const events = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_123","name":"test_tool"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{ invalid json"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];
    let index = 0;
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/event-stream']]),
      body: {
        getReader: () => ({
          read: async () => {
            if (index >= events.length) return { done: true };
            return { done: false, value: encoder.encode(events[index++]) };
          },
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    };
  };

  const originalFetch = global.fetch;
  global.fetch = mockSSEStream;

  try {
    await provider.complete({
      model: 'claude-3-sonnet',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{
        name: 'test_tool',
        description: 'test',
        input_schema: { type: 'object', properties: {} },
      }],
    });
    assert.fail('Should have thrown PROVIDER_UPSTREAM_ERROR');
  } catch (err) {
    assert.ok(err instanceof DmossError, 'Should be DmossError');
    assert.equal(err.code, ErrorCode.PROVIDER_UPSTREAM_ERROR, `Expected PROVIDER_UPSTREAM_ERROR, got ${err.code}`);
    assert.ok(err.message.includes('malformed tool call arguments'), 'Error message should mention malformed arguments');
    console.log('  ✓ Anthropic malformed arguments throw PROVIDER_UPSTREAM_ERROR');
  } finally {
    global.fetch = originalFetch;
  }
}

console.log('[PASS] OpenAI/Anthropic tool parameter parse failure tests');
