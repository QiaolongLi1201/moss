#!/usr/bin/env node

import assert from 'node:assert/strict';

const { createWebFetchTool, isPrivateHost } = await import('../dist/tools/web-fetch.js');

async function assertRejectsPrivateHost(resolver, label) {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('should not fetch');
  };
  try {
    const tool = createWebFetchTool({ resolveHostAddresses: resolver });
    await assert.rejects(
      () => tool.execute(
        { url: 'https://example.com/private' },
        { workspaceDir: '/tmp', sessionKey: `web-fetch-ssrf-${label}` },
      ),
      /refused to connect to private host/,
    );
    assert.equal(fetchCalled, false, `${label}: fetch must not run after failed SSRF preflight`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await assertRejectsPrivateHost(async () => ['127.0.0.1'], 'private-a-record');
await assertRejectsPrivateHost(async () => ['::ffff:127.0.0.1'], 'ipv4-mapped-private');
await assertRejectsPrivateHost(async () => { throw new Error('dns timeout'); }, 'dns-failure');

assert.equal(await isPrivateHost('example.test', async () => ['93.184.216.34']), false);

console.log('[PASS] web_fetch SSRF preflight fails closed on private or unverifiable DNS');
