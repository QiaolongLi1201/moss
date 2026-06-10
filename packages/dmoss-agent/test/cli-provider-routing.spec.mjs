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

// Model env vars are ignored by design (IGNORED_MODEL_ENV_VARS): the probe
// configures provider/baseUrl/apiKey via a config FILE in a temp config dir.
function writeProbeConfig(modelConfig) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-provider-routing-'));
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ apiKey: 'test-key', ...modelConfig }),
    { mode: 0o600 },
  );
  return configDir;
}

function runProviderProbe(modelConfig) {
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
      DMOSS_CONFIG_DIR: writeProbeConfig(modelConfig),
      DMOSS_NO_BUNDLED_DEFAULT: '1',
    },
    encoding: 'utf-8',
  });
}

{
  const result = runProviderProbe({
    provider: 'anthropic',
    baseUrl: 'https://internal-llm-gateway.example.com',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /internal-llm-gateway\.example\.com\/v1\/messages/);
}

{
  const result = runProviderProbe({
    provider: 'anthropic',
    baseUrl: 'https://internal-llm-gateway.example.com/v1',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /internal-llm-gateway\.example\.com\/v1\/messages/);
  assert.doesNotMatch(result.stdout, /\/v1\/v1\/messages/);
}

{
  const result = runProviderProbe({
    provider: 'openai-compatible',
    baseUrl: 'https://anthropic-compatible-openai-proxy.example.com',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /anthropic-compatible-openai-proxy\.example\.com\/v1\/chat\/completions/);
}

{
  const result = runProviderProbe({
    provider: 'openai-compatible',
    baseUrl: 'https://anthropic-compatible-openai-proxy.example.com/v1',
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
  const { createCliProvider } = await import('../dist/cli/providers.js');
  let seenBody = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    seenBody = JSON.parse(init?.body ?? '{}');
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
      imageInput: false,
    });
    await provider.stream({
      model: 'private-model',
      systemPrompt: '',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Please inspect this image.' },
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', filename: 'screen.png' },
        ],
      }],
      tools: [],
    }, () => {});

    const bodyJson = JSON.stringify(seenBody);
    assert.doesNotMatch(bodyJson, /image_url/, 'OpenAI-compatible providers must not receive image_url unless image input is enabled');
    assert.equal(seenBody.messages[0].content, 'Please inspect this image.\n[Image attachment not sent: screen.png; imageInput=false for this provider, so the assistant cannot inspect the image content.]');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const { createCliProvider } = await import('../dist/cli/providers.js');
  let seenBody = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    seenBody = JSON.parse(init?.body ?? '{}');
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    }), { status: 200 });
  };
  try {
    const provider = createCliProvider({
      provider: 'openai-compatible',
      apiKey: 'private-key',
      model: 'vision-model',
      baseUrl: 'https://private.example.test/v1',
      imageInput: true,
    });
    await provider.stream({
      model: 'vision-model',
      systemPrompt: '',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Please inspect this image.' },
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', filename: 'screen.png' },
        ],
      }],
      tools: [],
    }, () => {});

    assert.equal(seenBody.messages[0].content[1].type, 'image_url');
    assert.equal(seenBody.messages[0].content[1].image_url.url, 'data:image/png;base64,iVBORw0KGgo=');
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
      DMOSS_CONFIG_DIR: writeProbeConfig({
        provider: 'openai-compatible',
        baseUrl: 'https://proxy.example.com',
      }),
      DMOSS_NO_BUNDLED_DEFAULT: '1',
    },
    encoding: 'utf-8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OpenAI-compatible provider returned HTTP 502:/);
  assert.ok(result.stdout.length < 900, 'provider error should be truncated');
}

console.log('[PASS] CLI provider routing follows configured provider and frames upstream errors');
