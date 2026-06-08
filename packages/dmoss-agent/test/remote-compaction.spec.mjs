#!/usr/bin/env node
/**
 * Remote Compaction provider self-test.
 *
 * Covers:
 *  - hybridCompact uses remote provider when available
 *  - hybridCompact falls back to local summarize when remote fails / unavailable
 *  - hybridCompact uses local-only when no remote provider is configured
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/remote-compaction.spec.mjs
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { hybridCompact, resolveRemoteCompactUrls } from '../dist/context/index.js';

function makeMessages(n) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i} with some payload to give the estimator non-trivial token count`,
    timestamp: 1700000000000 + i,
  }));
}

const localSummarize = async ({ system, userPrompt, maxTokens }) => {
  assert.ok(system && system.length > 0, 'system prompt should be passed through');
  assert.ok(userPrompt.includes('<conversation>'), 'user prompt should include conversation');
  assert.ok(maxTokens > 0, 'maxTokens should be positive');
  return '<summary>fallback local summary</summary>';
};

// 1. Remote provider available → uses remote, never calls local
{
  let localCalls = 0;
  const wrappedLocal = async (...args) => {
    localCalls += 1;
    return localSummarize(...args);
  };
  const remoteProvider = {
    async isAvailable() {
      return true;
    },
    async compact(request) {
      assert.ok(Array.isArray(request.messages), 'remote sees messages');
      assert.ok(request.maxOutputTokens > 0);
      return {
        summary: 'remote summary text',
        tokensSaved: 1234,
        method: 'remote',
      };
    },
  };

  const result = await hybridCompact(
    {
      remoteProvider,
      localSummarize: wrappedLocal,
      contextWindowTokens: 128_000,
    },
    makeMessages(10),
  );

  assert.equal(result.method, 'remote');
  assert.equal(result.summary, 'remote summary text');
  assert.equal(result.tokensSaved, 1234);
  assert.equal(localCalls, 0, 'local summarize should not be called when remote succeeds');
}

// 2. Remote provider unavailable → falls back to local
{
  const remoteProvider = {
    async isAvailable() {
      return false;
    },
    async compact() {
      assert.fail('compact() must not be called when isAvailable returned false');
    },
  };

  const result = await hybridCompact(
    {
      remoteProvider,
      localSummarize,
      contextWindowTokens: 128_000,
    },
    makeMessages(8),
  );

  assert.equal(result.method, 'local_fallback');
  assert.match(result.summary, /fallback local summary/);
}

// 3. Remote provider throws → falls back to local
{
  const remoteProvider = {
    async isAvailable() {
      return true;
    },
    async compact() {
      throw new Error('remote service unreachable');
    },
  };

  const result = await hybridCompact(
    {
      remoteProvider,
      localSummarize,
      contextWindowTokens: 128_000,
    },
    makeMessages(8),
  );

  assert.equal(result.method, 'local_fallback');
  assert.match(result.summary, /fallback local summary/);
}

// 4. No remote provider configured → local_only
{
  const result = await hybridCompact(
    {
      localSummarize,
      contextWindowTokens: 128_000,
    },
    makeMessages(6),
  );

  assert.equal(result.method, 'local_only');
  assert.match(result.summary, /fallback local summary/);
  assert.ok(result.tokensSaved >= 0);
}

console.log('[PASS] Remote Compaction: remote-first with local fallback');

// 5. URL normalization matches host /api/d-moss/compact routes
{
  const a = resolveRemoteCompactUrls('http://localhost:5174/api/d-moss');
  assert.equal(a.compactUrl, 'http://localhost:5174/api/d-moss/compact');
  assert.equal(a.healthUrl, 'http://localhost:5174/api/d-moss/compact/health');
  const b = resolveRemoteCompactUrls('http://localhost:5174/api/d-moss/compact/');
  assert.equal(b.compactUrl, 'http://localhost:5174/api/d-moss/compact');
  assert.equal(b.healthUrl, 'http://localhost:5174/api/d-moss/compact/health');
}

console.log('[PASS] Remote Compaction: URL normalization');

// 6. Remote HTTP payload redacts secrets in messages, system prompt, and custom instructions
{
  let capturedPayload;
  const server = createServer((req, res) => {
    if (req.url === '/compact/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    assert.equal(req.url, '/compact');
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      capturedPayload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ summary: 'remote summary', tokens_saved: 42 }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const { HttpRemoteCompactProvider } = await import('../dist/context/index.js');
    const provider = new HttpRemoteCompactProvider({
      endpoint: `http://127.0.0.1:${port}`,
    });
    const rawKey = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
    const rawToken = ['ghp', 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ'].join('_');
    const result = await provider.compact({
      messages: [{
        role: 'user',
        content: `message secret ${rawKey}`,
        timestamp: 1700000000000,
      }],
      systemPrompt: `system prompt has ${rawKey}`,
      customInstructions: `custom instructions have ${rawToken}`,
      maxOutputTokens: 256,
      contextWindowTokens: 8192,
    });

    assert.equal(result.method, 'remote');
    assert.ok(capturedPayload, 'server should capture remote compact payload');
    const serialized = JSON.stringify(capturedPayload);
    assert.doesNotMatch(serialized, new RegExp(rawKey));
    assert.doesNotMatch(serialized, new RegExp(rawToken));
    assert.match(capturedPayload.messages[0].content, /\*\*\*/);
    assert.match(capturedPayload.system_prompt, /\*\*\*/);
    assert.match(capturedPayload.custom_instructions, /\*\*\*/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

console.log('[PASS] Remote Compaction: HTTP payload redacts prompt secrets');
