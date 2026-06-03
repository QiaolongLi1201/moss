#!/usr/bin/env node
/**
 * Test: web_search tool
 *
 * Verifies the keyless DuckDuckGo backend parsing, input validation, result
 * capping, custom-backend injection, and Brave provider config handling.
 */

import assert from 'node:assert/strict';
import { createWebSearchTool } from '../dist/tools/web-search.js';

const CTX = { workspaceDir: '/tmp', sessionKey: 'test' };

// A minimal DuckDuckGo HTML result page (two results, redirect-wrapped hrefs).
const DDG_HTML = `
<html><body>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdeveloper.d-robotics.cc%2Frdk_doc&rut=x">RDK X5 &amp; BPU 文档</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdeveloper.d-robotics.cc%2Frdk_doc">Official RDK documentation &amp; model conversion guide.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2FD-Robotics&rut=y">D-Robotics on GitHub</a>
  <a class="result__snippet" href="#">Source &lt;repos&gt; for the RDK ecosystem.</a>
</div>
</body></html>`;

function withMockedFetch(handler, fn) {
  return async () => {
    const original = globalThis.fetch;
    globalThis.fetch = handler;
    try {
      return await fn();
    } finally {
      globalThis.fetch = original;
    }
  };
}

// Test 1: DuckDuckGo backend parses titles, unwraps redirect URLs, pairs snippets.
console.log('[TEST] DuckDuckGo backend parses + unwraps results');
await withMockedFetch(
  async (url, init) => {
    assert.equal(String(url), 'https://html.duckduckgo.com/html/', 'should hit the DDG html endpoint');
    assert.equal(init.method, 'POST', 'DDG html endpoint expects POST');
    assert.match(String(init.body), /q=RDK\+X5/, 'query should be form-encoded');
    return new Response(DDG_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
  },
  async () => {
    const tool = createWebSearchTool();
    const out = await tool.execute({ query: 'RDK X5 BPU docs' }, CTX);
    assert.match(out, /Found 2 result\(s\) for "RDK X5 BPU docs"/);
    assert.match(out, /https:\/\/developer\.d-robotics\.cc\/rdk_doc/, 'first url should be unwrapped from uddg');
    assert.match(out, /RDK X5 & BPU 文档/, 'title entities should be decoded');
    assert.match(out, /https:\/\/github\.com\/D-Robotics/, 'second url should be unwrapped');
    assert.match(out, /Source <repos> for the RDK ecosystem\./, 'snippet entities should be decoded');
    assert.doesNotMatch(out, /duckduckgo\.com\/l\//, 'no redirect wrapper should leak through');
  },
)();

// Test 2: empty query is rejected before any network call.
console.log('[TEST] empty query throws USER_INPUT_INVALID');
{
  const tool = createWebSearchTool();
  await assert.rejects(
    () => tool.execute({ query: '   ' }, CTX),
    (err) => err?.code === 'USER_INPUT_INVALID',
    'blank query must be rejected',
  );
}

// Test 3: max_results caps the returned set.
console.log('[TEST] max_results caps the result set');
await withMockedFetch(
  async () => new Response(DDG_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
  async () => {
    const tool = createWebSearchTool();
    const out = await tool.execute({ query: 'rdk', max_results: 1 }, CTX);
    assert.match(out, /Found 1 result\(s\)/, 'should cap to 1 result');
    assert.doesNotMatch(out, /github\.com/, 'second result should be dropped by the cap');
  },
)();

// Test 4: a 429 surfaces as a recoverable rate-limit error.
console.log('[TEST] HTTP 429 -> recoverable rate-limit error');
await withMockedFetch(
  async () => new Response('rate limited', { status: 429 }),
  async () => {
    const tool = createWebSearchTool();
    await assert.rejects(
      () => tool.execute({ query: 'rdk' }, CTX),
      (err) => err?.code === 'PROVIDER_RATE_LIMITED' && err?.recoverable === true,
      'a 429 must map to a recoverable rate-limit error',
    );
  },
)();

// Test 5: host-injected custom backend takes precedence and receives the query.
console.log('[TEST] custom backend injection');
{
  let seenQuery = '';
  const tool = createWebSearchTool({
    search: async (query, opts) => {
      seenQuery = query;
      assert.ok(opts.maxResults > 0, 'backend should receive a positive maxResults');
      return [{ title: 'Injected', url: 'https://example.com/x', snippet: 'from host backend' }];
    },
  });
  const out = await tool.execute({ query: 'custom path' }, CTX);
  assert.equal(seenQuery, 'custom path', 'backend should receive the verbatim query');
  assert.match(out, /Injected/);
  assert.match(out, /https:\/\/example\.com\/x/);
}

// Test 6: Brave provider without a key fails fast at construction.
console.log('[TEST] brave provider without key throws PROVIDER_CONFIG_MISSING');
{
  const savedKey = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;
  try {
    assert.throws(
      () => createWebSearchTool({ provider: 'brave' }),
      (err) => err?.code === 'PROVIDER_CONFIG_MISSING',
      'brave without an API key must fail fast',
    );
  } finally {
    if (savedKey !== undefined) process.env.BRAVE_API_KEY = savedKey;
  }
}

// Test 7: tool exposes the stable `web_search` name + `query` schema the UI expects.
console.log('[TEST] tool contract: name + query input');
{
  const tool = createWebSearchTool();
  assert.equal(tool.name, 'web_search');
  assert.deepEqual(tool.inputSchema.required, ['query']);
  assert.equal(tool.metadata?.sideEffectClass, 'readonly');
  assert.equal(tool.metadata?.planMode, 'allow');
}

console.log('\n[PASS] web_search tool tests');
