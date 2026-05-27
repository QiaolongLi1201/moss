#!/usr/bin/env node
/**
 * Self-test for OpenAILLMProvider (P0-4).
 *
 * Uses a local HTTP server to mock OpenAI's SSE streaming response.
 * Verifies: streaming events, content assembly, tool_calls parsing.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/provider-openai.spec.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenAILLMProvider } from '../dist/provider/openai.js';
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

function sseChunks(res, chunks) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
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
  const { server, baseUrl } = await startMockServer((_req, res) => {
    sseChunks(res, [
      { choices: [{ delta: { role: 'assistant', content: '' } }] },
      { choices: [{ delta: { content: 'Hi ' } }] },
      { choices: [{ delta: { content: 'there' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 8, completion_tokens: 3 } },
    ]);
  });

  const provider = new OpenAILLMProvider({ apiKey: 'test-key', baseUrl });
  const events = [];
  const response = await provider.stream(
    { model: 'gpt-4o', systemPrompt: 'test', messages: [{ role: 'user', content: 'hello' }] },
    (e) => events.push(e),
  );

  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, 'text');
  assert.equal(response.content[0].text, 'Hi there');
  assert.equal(response.stopReason, 'end_turn');
  assert.equal(response.usage.inputTokens, 8);
  assert.equal(response.usage.outputTokens, 3);
  assert(events.some((e) => e.type === 'content_block_delta' && e.text === 'Hi '));
  assert(events.some((e) => e.type === 'content_block_delta' && e.text === 'there'));

  server.close();
  console.log('[PASS] Basic text streaming with events');
}

// ── Test 2: Tool calls streaming ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    sseChunks(res, [
      { choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'exec', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls -la"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 12, completion_tokens: 8 } },
    ]);
  });

  const provider = new OpenAILLMProvider({ apiKey: 'test-key', baseUrl });
  const events = [];
  const response = await provider.stream(
    { model: 'gpt-4o', systemPrompt: '', messages: [{ role: 'user', content: 'list files' }] },
    (e) => events.push(e),
  );

  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, 'tool_use');
  assert.equal(response.content[0].id, 'call_abc');
  assert.equal(response.content[0].name, 'exec');
  assert.deepEqual(response.content[0].input, { command: 'ls -la' });
  assert.equal(response.stopReason, 'tool_use');
  assert(events.some((e) => e.type === 'content_block_start' && e.toolUse?.name === 'exec'));
  assert(events.some((e) => e.type === 'content_block_delta' && e.partialJson));

  server.close();
  console.log('[PASS] Tool calls streaming with JSON assembly');
}

// ── Test 3: Mixed text + tool calls ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    sseChunks(res, [
      { choices: [{ delta: { role: 'assistant', content: 'Let me check.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_xyz', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 15, completion_tokens: 12 } },
    ]);
  });

  const provider = new OpenAILLMProvider({ apiKey: 'test-key', baseUrl });
  const response = await provider.stream(
    { model: 'gpt-4o', systemPrompt: '', messages: [{ role: 'user', content: 'read readme' }] },
    () => {},
  );

  assert.equal(response.content.length, 2);
  assert.equal(response.content[0].type, 'text');
  assert.equal(response.content[0].text, 'Let me check.');
  assert.equal(response.content[1].type, 'tool_use');
  assert.equal(response.content[1].name, 'read_file');
  assert.deepEqual(response.content[1].input, { path: 'README.md' });

  server.close();
  console.log('[PASS] Mixed text + tool calls');
}

// ── Test 4: capabilities.streaming === true ──
{
  const provider = new OpenAILLMProvider({ apiKey: 'test-key' });
  assert.equal(provider.capabilities.streaming, true);
  assert.equal(provider.id, 'openai');
  console.log('[PASS] capabilities.streaming === true');
}

// ── Test 5: API error handling ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    res.writeHead(429, { 'Content-Type': 'text/plain' });
    res.end('Rate limit exceeded');
  });

  const provider = new OpenAILLMProvider({ apiKey: 'test-key', baseUrl });
  try {
    await provider.complete({ model: 'gpt-4o', systemPrompt: '', messages: [] });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes('429'));
  }

  server.close();
  console.log('[PASS] API error handling');
}

// ── Test 6: Custom baseUrl (OpenAI-compatible) ──
{
  let receivedPath = '';
  const { server, baseUrl } = await startMockServer((req, res) => {
    receivedPath = req.url;
    sseChunks(res, [
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]);
  });

  const provider = new OpenAILLMProvider({ apiKey: 'test-key', baseUrl });
  await provider.complete({ model: 'deepseek-chat', systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(receivedPath, '/v1/chat/completions');

  server.close();
  console.log('[PASS] Custom baseUrl routes to /v1/chat/completions');
}

// ── Test 7: SSE comments are keepalive, not JSON payloads ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    rawSse(res, [
      ': keepalive',
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ]);
  });

  const provider = new OpenAILLMProvider({ apiKey: 'test-key', baseUrl });
  const response = await provider.stream(
    { model: 'gpt-4o', systemPrompt: '', messages: [{ role: 'user', content: 'hello' }] },
    () => {},
  );
  assert.equal(response.content[0].text, 'ok');

  server.close();
  console.log('[PASS] SSE comment keepalive lines are skipped');
}

// ── Test 8: Empty data lines are keepalive, not JSON payloads ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    rawSse(res, [
      'data:',
      'data: ',
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ]);
  });

  const provider = new OpenAILLMProvider({ apiKey: 'test-key', baseUrl });
  const response = await provider.stream(
    { model: 'gpt-4o', systemPrompt: '', messages: [{ role: 'user', content: 'hello' }] },
    () => {},
  );
  assert.equal(response.content[0].text, 'ok');

  server.close();
  console.log('[PASS] Empty SSE data keepalive lines are skipped');
}

// ── Test 9: Malformed SSE data is an upstream error ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    rawSse(res, [
      'data: {"choices":[',
      'data: [DONE]',
    ]);
  });

  const provider = new OpenAILLMProvider({ apiKey: 'test-key', baseUrl });
  await assert.rejects(
    () => provider.stream(
      { model: 'gpt-4o', systemPrompt: '', messages: [{ role: 'user', content: 'hello' }] },
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

// ── Test 10: A malformed frame after valid content still fails the stream ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    rawSse(res, [
      'data: {"choices":[{"delta":{"content":"partial"}}]}',
      'data: {"choices":[',
      'data: [DONE]',
    ]);
  });

  const provider = new OpenAILLMProvider({ apiKey: 'test-key', baseUrl });
  await assert.rejects(
    () => provider.stream(
      { model: 'gpt-4o', systemPrompt: '', messages: [{ role: 'user', content: 'hello' }] },
      () => {},
    ),
    (err) => err instanceof DmossError && err.code === ErrorCode.PROVIDER_UPSTREAM_ERROR,
  );

  server.close();
  console.log('[PASS] Malformed SSE data fails even after valid frames');
}

// ── Test 11: Structured stream error payloads are upstream errors ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    rawSse(res, [
      'data: {"error":{"type":"server_error","code":"overloaded_error","message":"upstream overloaded"}}',
      'data: [DONE]',
    ]);
  });

  const provider = new OpenAILLMProvider({ apiKey: 'test-key', baseUrl });
  await assert.rejects(
    () => provider.stream(
      { model: 'gpt-4o', systemPrompt: '', messages: [{ role: 'user', content: 'hello' }] },
      () => {},
    ),
    (err) => {
      assert.ok(err instanceof DmossError);
      assert.equal(err.code, ErrorCode.PROVIDER_UPSTREAM_ERROR);
      assert.match(err.message, /server_error|overloaded_error|upstream overloaded/);
      return true;
    },
  );

  server.close();
  console.log('[PASS] Structured OpenAI stream error payloads surface as upstream errors');
}

// ── Test 12: EOF with an incomplete SSE line fails the stream ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('data: {"choices":[');
    res.end();
  });

  const provider = new OpenAILLMProvider({ apiKey: 'test-key', baseUrl });
  await assert.rejects(
    () => provider.stream(
      { model: 'gpt-4o', systemPrompt: '', messages: [{ role: 'user', content: 'hello' }] },
      () => {},
    ),
    (err) => err instanceof DmossError && err.code === ErrorCode.PROVIDER_UPSTREAM_ERROR,
  );

  server.close();
  console.log('[PASS] Incomplete OpenAI SSE line at EOF fails the stream');
}

// ── Test 13: EOF without [DONE] or finish_reason fails even after valid deltas ──
{
  const { server, baseUrl } = await startMockServer((_req, res) => {
    rawSse(res, [
      'data: {"choices":[{"delta":{"content":"partial"}}]}',
    ]);
  });

  const provider = new OpenAILLMProvider({ apiKey: 'test-key', baseUrl });
  await assert.rejects(
    () => provider.stream(
      { model: 'gpt-4o', systemPrompt: '', messages: [{ role: 'user', content: 'hello' }] },
      () => {},
    ),
    (err) => {
      assert.ok(err instanceof DmossError);
      assert.equal(err.code, ErrorCode.PROVIDER_UPSTREAM_ERROR);
      assert.match(err.message, /terminated|finish_reason|DONE/i);
      return true;
    },
  );

  server.close();
  console.log('[PASS] OpenAI EOF without terminal marker fails the stream');
}

console.log('\n[pass] provider-openai: 13/13');
