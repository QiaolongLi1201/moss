#!/usr/bin/env node
/**
 * Test: web_fetch honors HTTP(S)_PROXY.
 *
 * Regression (twin of the web_search proxy bug): web_fetch attached a
 * per-request DNS-pinned dispatcher for HTTPS (overriding the global proxy
 * agent) and rewrote HTTP hostnames to the resolved IP — both bypass the proxy,
 * so doc-reading died behind a proxy / in mainland China. Under a proxy we must
 * NOT pin/rewrite, letting the global EnvHttpProxyAgent route the request; the
 * SSRF pre-flight (resolveHostIp) still runs. Without a proxy the pinning and
 * IP-rewrite SSRF protections are preserved.
 */

import assert from 'node:assert/strict';

const { createWebFetchTool } = await import('../dist/tools/web-fetch.js');

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];

async function capture(url, proxy) {
  const originalFetch = globalThis.fetch;
  const saved = Object.fromEntries(PROXY_VARS.map((k) => [k, process.env[k]]));
  for (const k of PROXY_VARS) delete process.env[k];
  if (proxy) {
    process.env.HTTP_PROXY = proxy;
    process.env.HTTPS_PROXY = proxy;
  }
  let captured;
  globalThis.fetch = async (u, init) => {
    captured = { url: String(u), dispatcher: init?.dispatcher };
    return new Response('<html><body>ok</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };
  try {
    const tool = createWebFetchTool({ resolveHostAddresses: async () => ['93.184.216.34'] });
    await tool.execute({ url }, { workspaceDir: '/tmp', sessionKey: 'web-fetch-proxy' });
    return captured;
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of PROXY_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const PROXY = 'http://127.0.0.1:7890';

// HTTP under proxy: hostname must stay the original (proxy resolves + routes), no per-request dispatcher.
console.log('[TEST] HTTP under proxy: no host→IP rewrite, no pinned dispatcher');
{
  const c = await capture('http://example.com/doc', PROXY);
  assert.match(c.url, /^http:\/\/example\.com\//, 'under proxy, HTTP host must NOT be rewritten to the IP');
  assert.equal(c.dispatcher, undefined, 'under proxy, no per-request dispatcher (use the global proxy agent)');
}

// HTTP without proxy: the existing SSRF host→IP pinning is preserved.
console.log('[TEST] HTTP without proxy: host pinned to verified IP (SSRF preserved)');
{
  const c = await capture('http://example.com/doc', null);
  assert.match(c.url, /^http:\/\/93\.184\.216\.34\//, 'without proxy, HTTP host is pinned to the verified IP');
}

// HTTPS under proxy: no pinned dispatcher, so the global proxy agent routes it.
console.log('[TEST] HTTPS under proxy: no pinned dispatcher attached');
{
  const c = await capture('https://example.com/doc', PROXY);
  assert.equal(c.dispatcher, undefined, 'under proxy, HTTPS must not attach a pinned dispatcher');
}

// HTTPS without proxy: DNS-pinning dispatcher is preserved (rebinding protection).
console.log('[TEST] HTTPS without proxy: pinned dispatcher preserved');
{
  const c = await capture('https://example.com/doc', null);
  assert.ok(c.dispatcher, 'without proxy, HTTPS attaches a pinned dispatcher (DNS rebinding protection)');
}

console.log('[PASS] web_fetch honors proxy env without losing SSRF protection');
