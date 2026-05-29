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

// 5. URL normalization matches RDK Studio /api/d-moss/compact routes
{
  const a = resolveRemoteCompactUrls('http://localhost:5174/api/d-moss');
  assert.equal(a.compactUrl, 'http://localhost:5174/api/d-moss/compact');
  assert.equal(a.healthUrl, 'http://localhost:5174/api/d-moss/compact/health');
  const b = resolveRemoteCompactUrls('http://localhost:5174/api/d-moss/compact/');
  assert.equal(b.compactUrl, 'http://localhost:5174/api/d-moss/compact');
  assert.equal(b.healthUrl, 'http://localhost:5174/api/d-moss/compact/health');
}

console.log('[PASS] Remote Compaction: URL normalization');
