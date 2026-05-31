#!/usr/bin/env node
/**
 * Self-test for pi-ai LLM provider adapter.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/pi-ai-adapter.spec.mjs
 */

import assert from 'node:assert/strict';
import { PiAiFirstEventTimeoutError } from '../dist/provider/pi-ai-adapter.js';

// ── PiAiFirstEventTimeoutError ──

{
  const err = new PiAiFirstEventTimeoutError({
    timeoutMs: 45_000,
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
  });
  assert.equal(err.name, 'PiAiFirstEventTimeoutError');
  assert.equal(err.timeoutMs, 45_000);
  assert.equal(err.provider, 'anthropic');
  assert.equal(err.model, 'claude-sonnet-4-20250514');
  assert.ok(err.message.includes('45s'), 'message should mention timeout seconds');
  assert.ok(err.message.includes('anthropic'), 'message should mention provider');
  assert.ok(err.message.includes('claude-sonnet-4-20250514'), 'message should mention model');
  assert.ok(err instanceof Error, 'should be instanceof Error');
}

{
  // Different timeout values
  const err30 = new PiAiFirstEventTimeoutError({
    timeoutMs: 30_000,
    provider: 'openai',
    model: 'gpt-5',
  });
  assert.equal(err30.timeoutMs, 30_000);
  assert.ok(err30.message.includes('30s'), 'message should mention 30s');

  const err120 = new PiAiFirstEventTimeoutError({
    timeoutMs: 120_000,
    provider: 'deepseek',
    model: 'deepseek-chat',
  });
  assert.equal(err120.timeoutMs, 120_000);
  assert.ok(err120.message.includes('120s') || err120.message.includes('2m'), 'message should mention the timeout');
}

{
  // Error should carry provider/model for upstream retry/logic decisions
  const err = new PiAiFirstEventTimeoutError({
    timeoutMs: 10_000,
    provider: 'groq',
    model: 'llama-4',
  });
  // Provider/model accessible for host-layer retry decisions
  assert.equal(err.provider, 'groq');
  assert.equal(err.model, 'llama-4');
}

// ── PiAiLLMProvider constructor: OAuth token rejection ──
// The constructor rejects Anthropic OAuth tokens before any network call.
// We test this via a thin dynamic import of the constructor.

{
  // We can't easily instantiate PiAiLLMProvider without a real pi-ai streamFn,
  // but we can verify the OAuth guard is reachable by constructing with the
  // minimum valid config and confirming it does NOT throw for a normal API key.
  // For the OAuth rejection path, we import dynamically to catch the throw.
  const { PiAiLLMProvider } = await import('../dist/provider/pi-ai-adapter.js');

  // OAuth token should be rejected for anthropic api
  let oauthRejected = false;
  try {
    new PiAiLLMProvider({
      streamFn: async function* () {},
      model: { api: 'anthropic', provider: 'anthropic', id: 'claude-sonnet-4-20250514' },
      apiKey: 'sk-ant-oat-abcdef1234567890ghij',
    });
  } catch (err) {
    oauthRejected = true;
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes('sk-ant-oat'), 'error should mention OAuth token pattern');
    assert.ok(err.message.includes('SECURITY.md'), 'error should point to SECURITY.md');
  }
  assert.equal(oauthRejected, true, 'Anthropic OAuth token should be rejected');
}

{
  // Normal Anthropic API key should NOT be rejected
  const { PiAiLLMProvider } = await import('../dist/provider/index.js');
  let threw = false;
  try {
    new PiAiLLMProvider({
      streamFn: async function* () {},
      model: { api: 'anthropic', provider: 'anthropic', id: 'claude-sonnet-4-20250514' },
      apiKey: 'sk-ant-api03-abcdef1234567890ghijklmnopqrstuv',
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'Normal Anthropic API key should not be rejected');
}

{
  // Non-anthropic provider should NOT check for OAuth tokens
  const { PiAiLLMProvider } = await import('../dist/provider/index.js');
  let threw = false;
  try {
    new PiAiLLMProvider({
      streamFn: async function* () {},
      model: { api: 'openai', provider: 'openai', id: 'gpt-5' },
      apiKey: 'sk-ant-oat-abcdef1234567890ghij', // OAuth-format but on OpenAI api
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'OAuth-format token on non-Anthropic provider should not be rejected');
}

{
  const { PiAiLLMProvider } = await import('../dist/provider/index.js');
  const provider = new PiAiLLMProvider({
    streamFn: async function* () {
      yield {
        type: 'toolCall',
        toolCall: {
          id: 'call_1',
          name: 'studio_open_url',
          partialArgs: '{"url":"https://developer"',
        },
      };
      yield { type: 'done', stopReason: 'toolCall' };
    },
    model: { api: 'openai', provider: 'openai', id: 'gpt-5' },
    apiKey: 'sk-test',
    repairToolCallUrl: (url) => (
      url === 'https://developer'
        ? 'https://developer.d-robotics.cc/forum'
        : url.trim()
    ),
  });
  const res = await provider.complete({
    messages: [{ role: 'user', content: '打开开发者论坛' }],
  });
  const toolUse = res.content.find((block) => block.type === 'tool_use');
  assert.equal(toolUse?.input?.url, 'https://developer.d-robotics.cc/forum');
}

{
  const { PiAiLLMProvider } = await import('../dist/provider/index.js');
  let capturedContext;
  let capturedPayload;
  const provider = new PiAiLLMProvider({
    streamFn: async function* (_model, context, options) {
      capturedContext = context;
      const payload = {
        system: [
          {
            type: 'text',
            text: 'You are Claude Code, Anthropic\'s official CLI for Claude.',
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: 'stable prompt\n\ndynamic turn context',
            cache_control: { type: 'ephemeral', ttl: '5m' },
          },
        ],
      };
      options?.onPayload?.(payload);
      capturedPayload = payload;
      yield {
        type: 'done',
        stopReason: 'stop',
        message: {
          content: [{ type: 'text', text: 'ok' }],
          usage: { input: 1, output: 1 },
        },
      };
    },
    model: { api: 'anthropic-messages', provider: 'anthropic', id: 'claude-sonnet-4-20250514' },
    apiKey: 'sk-ant-api03-abcdef1234567890ghijklmnopqrstuv',
  });

  await provider.complete({
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'stable prompt\n\ndynamic turn context',
    systemPromptParts: { stable: 'stable prompt', dynamic: 'dynamic turn context' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.deepEqual(capturedContext.systemPromptParts, {
    stable: 'stable prompt',
    dynamic: 'dynamic turn context',
  });
  assert.deepEqual(capturedPayload.system[1], {
    type: 'text',
    text: 'stable prompt',
    cache_control: { type: 'ephemeral', ttl: '5m' },
  });
  assert.deepEqual(capturedPayload.system[2], {
    type: 'text',
    text: 'dynamic turn context',
  });
}

console.log('All pi-ai-adapter checks passed.');
