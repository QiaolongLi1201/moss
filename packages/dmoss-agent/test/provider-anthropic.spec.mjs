#!/usr/bin/env node
/**
 * Self-test for AnthropicLLMProvider (P0-4).
 *
 * Uses a local HTTP server to mock Anthropic's SSE streaming response.
 * Verifies: streaming events, content assembly, tool_use parsing, thinking.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/provider-anthropic.spec.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { AnthropicLLMProvider } from '../dist/provider/anthropic.js';
import { classifyLlmError } from '../dist/core/index.js';
import { DmossError, ErrorCode } from '../dist/errors.js';

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function sseWrite(res, events) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const [eventType, data] of events) {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
}

function rawSse(res, lines) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const line of lines) {
    res.write(`${line}\n\n`);
  }
  res.end();
}

// ── Test 1: Basic text streaming ──
{
  const { server, baseUrl } = await startMockServer((req, res) => {
    assert.equal(req.method, 'POST');
    assert.ok(req.url.includes('/v1/messages'));
    sseWrite(res, [
      ['message_start', { type: 'message_start', message: { usage: { input_tokens: 10 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
  });

  const provider = new AnthropicLLMProvider({ apiKey: 'test-key', baseUrl });
  const events = [];
  const response = await provider.stream(
    { model: 'test-model', systemPrompt: 'test', messages: [{ role: 'user', content: 'hi' }] },
    (e) => events.push(e),
  );

  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, 'text');
  assert.equal(response.content[0].text, 'Hello world');
  assert.equal(response.stopReason, 'end_turn');
  assert.equal(response.usage.inputTokens, 10);
  assert.equal(response.usage.outputTokens, 5);
  assert(events.some((e) => e.type === 'content_block_delta' && e.text === 'Hello '));
  assert(events.some((e) => e.type === 'content_block_delta' && e.text === 'world'));
  assert(events.some((e) => e.type === 'message_start'));
  assert(events.some((e) => e.type === 'message_stop'));

  server.close();
  console.log('[PASS] Basic text streaming with events');
}

// ── Test 2: Tool use streaming ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    sseWrite(res, [
      ['message_start', { type: 'message_start', message: { usage: { input_tokens: 20 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_1', name: 'read_file' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"src/index.ts"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
  });

  const provider = new AnthropicLLMProvider({ apiKey: 'test-key', baseUrl });
  const events = [];
  const response = await provider.stream(
    { model: 'test-model', systemPrompt: '', messages: [{ role: 'user', content: 'read it' }] },
    (e) => events.push(e),
  );

  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, 'tool_use');
  assert.equal(response.content[0].id, 'tool_1');
  assert.equal(response.content[0].name, 'read_file');
  assert.deepEqual(response.content[0].input, { path: 'src/index.ts' });
  assert.equal(response.stopReason, 'tool_use');
  assert(events.some((e) => e.type === 'content_block_start' && e.toolUse?.name === 'read_file'));
  assert(events.some((e) => e.type === 'content_block_delta' && e.partialJson));

  server.close();
  console.log('[PASS] Tool use streaming with JSON assembly');
}

// ── Test 3: capabilities.streaming === true ──
{
  const provider = new AnthropicLLMProvider({ apiKey: 'test-key' });
  assert.equal(provider.capabilities.streaming, true);
  assert.equal(provider.id, 'anthropic');
  console.log('[PASS] capabilities.streaming === true');
}

// ── Test 4: API error handling ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Invalid API key');
  });

  const provider = new AnthropicLLMProvider({ apiKey: 'bad-key', baseUrl });
  try {
    await provider.complete({ model: 'test', systemPrompt: '', messages: [] });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes('401'));
  }

  server.close();
  console.log('[PASS] API error handling');
}

// ── Test 5: Ping events are keepalive, not content ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    rawSse(res, [
      'event: ping\ndata: {"type":"ping"}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]);
  });

  const provider = new AnthropicLLMProvider({ apiKey: 'test-key', baseUrl });
  const response = await provider.stream(
    { model: 'test-model', systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] },
    () => {},
  );
  assert.equal(response.content[0].text, 'ok');

  server.close();
  console.log('[PASS] Ping SSE events are skipped');
}

// ── Test 6: Unknown event types are ignored gracefully ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    rawSse(res, [
      'event: future_event\ndata: {"type":"future_event","value":1}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]);
  });

  const provider = new AnthropicLLMProvider({ apiKey: 'test-key', baseUrl });
  const response = await provider.stream(
    { model: 'test-model', systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] },
    () => {},
  );
  assert.equal(response.content[0].text, 'ok');

  server.close();
  console.log('[PASS] Unknown Anthropic SSE events are ignored gracefully');
}

// ── Test 7: Malformed SSE data is an upstream error ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    rawSse(res, [
      'data: {"type":"message_start","message":',
      'data: {"type":"message_stop"}',
    ]);
  });

  const provider = new AnthropicLLMProvider({ apiKey: 'test-key', baseUrl });
  await assert.rejects(
    () => provider.stream(
      { model: 'test-model', systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
    ),
    (err) => {
      assert.ok(err instanceof DmossError);
      assert.equal(err.code, ErrorCode.PROVIDER_UPSTREAM_ERROR);
      assert.match(err.message, /malformed.*sse|sse.*json/i);
      return true;
    },
  );

  server.close();
  console.log('[PASS] Malformed SSE data surfaces as upstream error');
}

// ── Test 8: Transient stream error events surface as retryable upstream errors ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    rawSse(res, [
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    ]);
  });

  const provider = new AnthropicLLMProvider({ apiKey: 'test-key', baseUrl });
  await assert.rejects(
    () => provider.stream(
      { model: 'test-model', systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
    ),
    (err) => {
      assert.ok(err instanceof DmossError);
      assert.equal(err.code, ErrorCode.PROVIDER_UPSTREAM_ERROR);
      assert.match(err.message, /overloaded_error|Overloaded/);
      const classification = classifyLlmError(err);
      assert.equal(classification.category, 'server_error');
      assert.equal(classification.retryable, true);
      return true;
    },
  );

  server.close();
  console.log('[PASS] Anthropic overloaded stream errors are retryable upstream errors');
}

// ── Test 9: Client stream error events surface as non-retryable upstream errors ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    rawSse(res, [
      'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"Invalid request: bad tool schema"}}',
    ]);
  });

  const provider = new AnthropicLLMProvider({ apiKey: 'test-key', baseUrl });
  await assert.rejects(
    () => provider.stream(
      { model: 'test-model', systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
    ),
    (err) => {
      assert.ok(err instanceof DmossError);
      assert.equal(err.code, ErrorCode.PROVIDER_UPSTREAM_ERROR);
      assert.match(err.message, /invalid_request_error|Invalid request/);
      const classification = classifyLlmError(err);
      assert.equal(classification.category, 'client_error');
      assert.equal(classification.retryable, false);
      return true;
    },
  );

  server.close();
  console.log('[PASS] Anthropic invalid_request stream errors are non-retryable upstream errors');
}

// ── Test 10: A malformed frame after valid content still fails the stream ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    rawSse(res, [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]);
  });

  const provider = new AnthropicLLMProvider({ apiKey: 'test-key', baseUrl });
  await assert.rejects(
    () => provider.stream(
      { model: 'test-model', systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
    ),
    (err) => err instanceof DmossError && err.code === ErrorCode.PROVIDER_UPSTREAM_ERROR,
  );

  server.close();
  console.log('[PASS] Malformed SSE data fails even after valid frames');
}

// ── Test 11: EOF with an incomplete SSE line fails the stream ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('data: {"type":"message_start","message":');
    res.end();
  });

  const provider = new AnthropicLLMProvider({ apiKey: 'test-key', baseUrl });
  await assert.rejects(
    () => provider.stream(
      { model: 'test-model', systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
    ),
    (err) => err instanceof DmossError && err.code === ErrorCode.PROVIDER_UPSTREAM_ERROR,
  );

  server.close();
  console.log('[PASS] Incomplete Anthropic SSE line at EOF fails the stream');
}

// ── Test 12: Anthropic streams must end with message_stop ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    rawSse(res, [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    ]);
  });

  const provider = new AnthropicLLMProvider({ apiKey: 'test-key', baseUrl });
  await assert.rejects(
    () => provider.stream(
      { model: 'test-model', systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
    ),
    (err) => {
      assert.ok(err instanceof DmossError);
      assert.equal(err.code, ErrorCode.PROVIDER_UPSTREAM_ERROR);
      assert.match(err.message, /message_stop|ended.*without/i);
      return true;
    },
  );

  server.close();
  console.log('[PASS] Anthropic stream EOF without message_stop fails the stream');
}

console.log('\n[pass] provider-anthropic: 12/12');
