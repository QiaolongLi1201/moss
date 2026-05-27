#!/usr/bin/env node
/**
 * Test: web_fetch HTTPS DNS rebinding fix
 *
 * Verifies that HTTPS URLs are not rewritten to IP addresses, preserving TLS SNI.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWebFetchTool } from '../dist/tools/web-fetch.js';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Test 0: HTTPS pinning uses undici at runtime, so package metadata must ship it.
console.log('[TEST] undici is declared as a runtime dependency');
{
  assert.ok(packageJson.dependencies?.undici, 'web_fetch HTTPS pinning requires a runtime undici dependency');
  assert.equal(
    packageJson.peerDependencies?.undici,
    undefined,
    'undici must not be optional peer-only when default HTTPS pinning imports it',
  );
  assert.equal(
    packageJson.peerDependenciesMeta?.undici,
    undefined,
    'undici must not be marked optional when default HTTPS pinning imports it',
  );
}

// Mock DNS resolver that returns a public IP
const mockResolver = async () => ['93.184.216.34']; // example.com IP

const tool = createWebFetchTool({
  resolveHostAddresses: mockResolver,
});

// Test 1: HTTPS URL should preserve hostname while pinning connection DNS.
console.log('[TEST] HTTPS URL uses a pinned dispatcher');
{
  const originalFetch = globalThis.fetch;
  const httpsUrl = 'https://example.com/test';
  let seenUrl = '';
  let seenDispatcher = null;
  globalThis.fetch = async (url, init = {}) => {
    seenUrl = String(url);
    seenDispatcher = init.dispatcher ?? null;
    return new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  };
  try {
    const result = await tool.execute({ url: httpsUrl }, { workspaceDir: '/tmp', sessionKey: 'test' });
    assert.equal(seenUrl, httpsUrl, 'HTTPS fetch should keep the original hostname for TLS/SNI');
    assert.ok(seenDispatcher, 'HTTPS fetch should pin DNS via a per-request dispatcher');
    assert.match(result, /ok/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Test 2: HTTP URL can still be rewritten (no TLS/SNI issues)
console.log('[TEST] HTTP URL hostname rewrite allowed');
{
  const originalFetch = globalThis.fetch;
  const httpUrl = 'http://example.com/test';
  let seenUrl = '';
  let seenHost = '';
  globalThis.fetch = async (url, init = {}) => {
    seenUrl = String(url);
    seenHost = init.headers?.Host ?? '';
    return new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  };
  try {
    await tool.execute({ url: httpUrl }, { workspaceDir: '/tmp', sessionKey: 'test' });
    assert.equal(seenUrl, 'http://93.184.216.34/test');
    assert.equal(seenHost, 'example.com');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('[PASS] web_fetch HTTPS DNS rebinding tests');
