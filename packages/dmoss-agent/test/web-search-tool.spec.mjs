#!/usr/bin/env node
/**
 * Test: web_search tool
 *
 * Verifies the keyless Bing/DuckDuckGo backend parsing, input validation,
 * result capping, custom-backend injection, and Brave provider config handling.
 */

import assert from 'node:assert/strict';
import { createWebSearchTool } from '../dist/tools/web-search.js';
import { DmossError, ErrorCode } from '../dist/errors.js';

const CTX = { workspaceDir: '/tmp', sessionKey: 'test' };
/** Zero-delay retry config so retry/fallback tests run instantly. */
const NO_SLEEP = { retry: { sleep: async () => {} } };

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
    const tool = createWebSearchTool({ provider: 'duckduckgo' });
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
    const tool = createWebSearchTool({ provider: 'duckduckgo' });
    const out = await tool.execute({ query: 'rdk', max_results: 1 }, CTX);
    assert.match(out, /Found 1 result\(s\)/, 'should cap to 1 result');
    assert.doesNotMatch(out, /github\.com/, 'second result should be dropped by the cap');
  },
)();

// Test 4: a 429 (on every backend) surfaces as a recoverable rate-limit error.
console.log('[TEST] HTTP 429 -> recoverable rate-limit error');
await withMockedFetch(
  async () => new Response('rate limited', { status: 429 }),
  async () => {
    const tool = createWebSearchTool(NO_SLEEP);
    await assert.rejects(
      () => tool.execute({ query: 'rdk' }, CTX),
      (err) => err?.code === 'PROVIDER_RATE_LIMITED' && err?.recoverable === true,
      'a 429 on every backend must map to a recoverable rate-limit error',
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

// Test 8: DDG anti-bot/anomaly page (HTTP 200, no results parsed) must surface as a
// backend failure — NOT a silent "No results" that would mislead the model into
// thinking the topic has no information (the confabulation hazard from the bug hunt).
console.log('[TEST] DDG anomaly page -> honest "blocked" error (not "No results")');
await withMockedFetch(
  async () => new Response(
    '<html><body>If this error persists, please let us know. anomaly detected <form class="challenge-form">...</form></body></html>',
    { status: 200, headers: { 'content-type': 'text/html' } },
  ),
  async () => {
    const tool = createWebSearchTool({ ...NO_SLEEP, provider: 'duckduckgo' });
    await assert.rejects(
      () => tool.execute({ query: 'rdk x5' }, CTX),
      (err) =>
        err?.code === 'PROVIDER_UPSTREAM_ERROR' &&
        err?.recoverable === true &&
        /blocked automated access|anti-bot|backend failure/i.test(err?.message || ''),
      'an anti-bot/anomaly page must surface as a recoverable backend failure, not "No results"',
    );
  },
)();

// Test 9: a genuine empty result set (real DDG markup, zero hits) reports "No results".
console.log('[TEST] genuine empty results -> "No results" (not an error)');
await withMockedFetch(
  async () => new Response(
    '<html><body><div class="no-results">No results found.</div></body></html>',
    { status: 200, headers: { 'content-type': 'text/html' } },
  ),
  async () => {
    const tool = createWebSearchTool({ provider: 'duckduckgo' });
    const out = await tool.execute({ query: 'zxqwv nonsense token' }, CTX);
    assert.match(out, /No results for "zxqwv nonsense token"/, 'genuine empty must report No results, not throw');
  },
)();

// Test 10: a recoverable failure is retried, and a subsequent success is returned.
console.log('[TEST] recoverable failure -> retried then succeeds');
{
  let calls = 0;
  const tool = createWebSearchTool({
    retry: { maxAttempts: 2, sleep: async () => {} },
    search: async () => {
      calls++;
      if (calls === 1) {
        throw new DmossError({
          code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
          message: 'transient blip',
          recoverable: true,
        });
      }
      return [{ title: 'Recovered', url: 'https://example.com/ok', snippet: 'after retry' }];
    },
  });
  const out = await tool.execute({ query: 'retry me' }, CTX);
  assert.equal(calls, 2, 'should retry exactly once after a recoverable failure');
  assert.match(out, /Recovered/, 'the post-retry result must be returned');
}

// Test 11: a blocked primary (DDG html) falls through to the keyless Lite endpoint.
console.log('[TEST] blocked primary -> falls back to DuckDuckGo Lite');
const LITE_HTML = `
<html><body><table>
<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Flite&rut=z">Lite Result Title</a></td></tr>
<tr><td class="result-snippet">A snippet from the lite endpoint.</td></tr>
</table></body></html>`;
await withMockedFetch(
  async (url) => {
    if (String(url).includes('lite.duckduckgo.com')) {
      return new Response(LITE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    // Primary html endpoint (and the Bing fallback) serve anti-bot pages.
    return new Response(
      '<html><body>anomaly detected <form class="challenge-form"></form> captcha</body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  },
  async () => {
    const tool = createWebSearchTool({ ...NO_SLEEP, provider: 'duckduckgo' });
    const out = await tool.execute({ query: 'rdk docs' }, CTX);
    assert.match(out, /Lite Result Title/, 'should return the Lite endpoint result after the html endpoint is blocked');
    assert.match(out, /https:\/\/example\.com\/lite/, 'lite redirect href should be unwrapped');
    assert.doesNotMatch(out, /duckduckgo\.com\/l\//, 'no redirect wrapper should leak through');
  },
)();

// Test 12: aborting during the retry backoff surfaces USER_ABORTED and starts no new attempt.
console.log('[TEST] abort during retry -> USER_ABORTED');
{
  const controller = new AbortController();
  let attempts = 0;
  const tool = createWebSearchTool({
    retry: {
      maxAttempts: 3,
      sleep: async () => {
        controller.abort(); // user cancels mid-backoff
      },
    },
    search: async () => {
      attempts++;
      throw new DmossError({
        code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
        message: 'still failing',
        recoverable: true,
      });
    },
  });
  await assert.rejects(
    () => tool.execute({ query: 'cancel me' }, { ...CTX, abortSignal: controller.signal }),
    (err) => err?.code === 'USER_ABORTED',
    'aborting during backoff must surface USER_ABORTED',
  );
  assert.equal(attempts, 1, 'must not start a new attempt after abort');
}

// Test 13: when every backend fails, the last backend's error is surfaced (not swallowed).
console.log('[TEST] all backends fail -> last error preserved');
await withMockedFetch(
  async (url) => {
    if (String(url).includes('lite.duckduckgo.com')) return new Response('boom', { status: 500 });
    return new Response('rate limited', { status: 429 });
  },
  async () => {
    const tool = createWebSearchTool(NO_SLEEP);
    await assert.rejects(
      () => tool.execute({ query: 'all fail' }, CTX),
      (err) => err?.code === 'PROVIDER_UPSTREAM_ERROR' && err?.recoverable === true,
      'when every backend fails, the last backend error (lite 500) must surface',
    );
  },
)();

// Test 14: fallback:false uses only the primary backend (no DDG fallback).
console.log('[TEST] fallback:false -> single backend, no fallback call');
await withMockedFetch(
  async (url) => {
    assert.ok(String(url).includes('bing.com/search'), 'fallback:false must only hit the primary (Bing) endpoint');
    // Genuine Bing "no results" page (b_no marker, zero b_algo blocks).
    return new Response(
      '<html><body><ol id="b_results"><li class="b_no">没有与此相关的结果</li></ol></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  },
  async () => {
    const tool = createWebSearchTool({ ...NO_SLEEP, fallback: false });
    const out = await tool.execute({ query: 'single backend' }, CTX);
    assert.match(out, /No results for "single backend"/, 'a genuine empty result must still report "No results"');
  },
)();

// A minimal Bing result page: one direct link, one /ck/a redirect-wrapped link
// (u=a1<base64url> encodes https://github.com/D-Robotics).
const BING_HTML = `
<html><body><ol id="b_results">
<li class="b_algo"><div class="b_title"><h2><a href="https://developer.d-robotics.cc/rdk_doc" h="ID=SERP,1">RDK X5 &amp; BPU 文档</a></h2></div>
  <div class="b_caption"><p>Official RDK documentation &amp; model conversion guide.</p></div></li>
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc123&amp;u=a1aHR0cHM6Ly9naXRodWIuY29tL0QtUm9ib3RpY3M&amp;ntb=1">D-Robotics on GitHub</a></h2>
  <div class="b_caption"><p>Source &lt;repos&gt; for the RDK ecosystem.</p></div></li>
</ol></body></html>`;

// Test 15: Bing is the default primary backend; it parses titles, snippets,
// and unwraps /ck/a redirect links to the real target URL.
console.log('[TEST] Bing default backend parses + unwraps /ck/a results');
await withMockedFetch(
  async (url, init) => {
    const u = String(url);
    assert.ok(u.startsWith('https://www.bing.com/search?'), 'default primary must be the Bing endpoint');
    assert.match(u, /q=RDK\+X5/, 'query should be URL-encoded');
    assert.equal((init?.method ?? 'GET'), 'GET', 'Bing endpoint expects GET');
    return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
  },
  async () => {
    const tool = createWebSearchTool();
    const out = await tool.execute({ query: 'RDK X5 BPU docs' }, CTX);
    assert.match(out, /Found 2 result\(s\) for "RDK X5 BPU docs"/);
    assert.match(out, /https:\/\/developer\.d-robotics\.cc\/rdk_doc/, 'direct urls should pass through');
    assert.match(out, /RDK X5 & BPU 文档/, 'title entities should be decoded');
    assert.match(out, /https:\/\/github\.com\/D-Robotics/, '/ck/a redirect should be unwrapped to the target URL');
    assert.match(out, /Source <repos> for the RDK ecosystem\./, 'snippet entities should be decoded');
    assert.doesNotMatch(out, /bing\.com\/ck\//, 'no redirect wrapper should leak through');
  },
)();

// Test 16: a blocked Bing primary (captcha page) falls through to DuckDuckGo.
console.log('[TEST] blocked Bing primary -> falls back to DuckDuckGo');
await withMockedFetch(
  async (url) => {
    if (String(url).includes('html.duckduckgo.com')) {
      return new Response(DDG_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response(
      '<html><body>Please verify you are a human. captcha</body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  },
  async () => {
    const tool = createWebSearchTool(NO_SLEEP);
    const out = await tool.execute({ query: 'rdk docs' }, CTX);
    assert.match(out, /RDK X5 & BPU 文档/, 'should return DDG results after Bing is blocked');
  },
)();

console.log('\n[PASS] web_search tool tests');
