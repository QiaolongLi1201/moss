#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-provider-routing.spec.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

function runProviderProbe(env) {
  const script = `
    globalThis.fetch = async (url) => {
      console.log(String(url));
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }), { status: 200 });
    };
    const { cliProvider } = await import('./packages/dmoss-agent/dist/cli/providers.js');
    await cliProvider.stream({ model: 'test-model', messages: [], tools: [] }, () => {});
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: os.homedir(),
      DMOSS_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-provider-routing-')),
      DMOSS_API_KEY: 'test-key',
      ...env,
    },
    encoding: 'utf-8',
  });
}

{
  const result = runProviderProbe({
    DMOSS_PROVIDER: 'anthropic',
    DMOSS_BASE_URL: 'https://internal-llm-gateway.example.com',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /internal-llm-gateway\.example\.com\/v1\/messages/);
}

{
  const result = runProviderProbe({
    DMOSS_PROVIDER: 'anthropic',
    DMOSS_BASE_URL: 'https://internal-llm-gateway.example.com/v1',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /internal-llm-gateway\.example\.com\/v1\/messages/);
  assert.doesNotMatch(result.stdout, /\/v1\/v1\/messages/);
}

{
  const result = runProviderProbe({
    DMOSS_PROVIDER: 'openai-compatible',
    DMOSS_BASE_URL: 'https://anthropic-compatible-openai-proxy.example.com',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /anthropic-compatible-openai-proxy\.example\.com\/v1\/chat\/completions/);
}

{
  const result = runProviderProbe({
    DMOSS_PROVIDER: 'openai-compatible',
    DMOSS_BASE_URL: 'https://anthropic-compatible-openai-proxy.example.com/v1',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /anthropic-compatible-openai-proxy\.example\.com\/v1\/chat\/completions/);
  assert.doesNotMatch(result.stdout, /\/v1\/v1\/chat\/completions/);
}

{
  const { createCliProvider } = await import('../dist/cli/providers.js');
  let seenHeaders = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    seenHeaders = init?.headers ?? {};
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    }), { status: 200 });
  };
  try {
    const provider = createCliProvider({
      provider: 'openai-compatible',
      apiKey: 'gateway-token',
      model: 'Moss',
      baseUrl: 'https://gateway.example.test/v1',
      usingBundledDefault: true,
      communityAuth: {
        accessToken: 'community-access-token',
        user: { id: 'community-user', name: 'Community User' },
        expiresAt: Date.now() + 3_600_000,
        sessionPath: '/tmp/community-auth.json',
        ssoBaseUrl: 'https://sso.example.test',
      },
    });
    await provider.stream({ model: 'Moss', messages: [], tools: [] }, () => {});
    assert.equal(seenHeaders['x-dmoss-community-access-token'], 'community-access-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const { createCliProvider } = await import('../dist/cli/providers.js');
  let seenHeaders = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    seenHeaders = init?.headers ?? {};
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    }), { status: 200 });
  };
  try {
    const provider = createCliProvider({
      provider: 'openai-compatible',
      apiKey: 'private-key',
      model: 'private-model',
      baseUrl: 'https://private.example.test/v1',
      usingBundledDefault: false,
      communityAuth: {
        accessToken: 'community-access-token',
        user: { id: 'community-user', name: 'Community User' },
        expiresAt: Date.now() + 3_600_000,
        sessionPath: '/tmp/community-auth.json',
        ssoBaseUrl: 'https://sso.example.test',
      },
    });
    await provider.stream({ model: 'private-model', messages: [], tools: [] }, () => {});
    assert.equal(seenHeaders['x-dmoss-community-access-token'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const script = `
    globalThis.fetch = async () => new Response('   provider exploded '.repeat(100), { status: 502 });
    const { cliProvider } = await import('./packages/dmoss-agent/dist/cli/providers.js');
    try {
      await cliProvider.stream({ model: 'test-model', messages: [], tools: [] }, () => {});
    } catch (err) {
      console.log(err.message);
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: os.homedir(),
      DMOSS_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-provider-error-')),
      DMOSS_PROVIDER: 'openai-compatible',
      DMOSS_BASE_URL: 'https://proxy.example.com',
      DMOSS_API_KEY: 'test-key',
    },
    encoding: 'utf-8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OpenAI-compatible provider returned HTTP 502:/);
  assert.ok(result.stdout.length < 900, 'provider error should be truncated');
}

console.log('[PASS] CLI provider routing follows configured provider and frames upstream errors');
