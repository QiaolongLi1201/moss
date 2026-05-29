#!/usr/bin/env node
/**
 * @rdk-moss/memory — memory-context-selector unit tests
 *
 * Run after package build:
 *   npm run build -w @rdk-moss/memory && node packages/dmoss-memory/test/memory-context-selector.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'index.js');
const {
  MemoryManager,
  selectMemoriesForContext,
  renderMemoryPicksForSystemPrompt,
} = await import(pathToFileURL(distJs).href);

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-mem-ctx-'));

function makeEntry(opts) {
  return {
    id: opts.id,
    content: opts.content,
    source: opts.source ?? 'memory',
    hash: opts.hash ?? opts.id.replace('mem_', ''),
    createdAt: opts.createdAt ?? Date.now(),
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts.scopeRef !== undefined ? { scopeRef: opts.scopeRef } : {}),
    ...(opts.pinned !== undefined ? { pinned: opts.pinned } : {}),
  };
}

async function seedManager(subdir, entries) {
  const memDir = path.join(base, subdir);
  await fs.mkdir(memDir, { recursive: true });
  await fs.writeFile(path.join(memDir, 'index.json'), JSON.stringify(entries));
  const mgr = new MemoryManager(memDir);
  await mgr.load();
  return mgr;
}

try {
  // ── selectMemoriesForContext ──

  // Test: returns empty array when no memories exist
  {
    const mgr = await seedManager('empty', []);
    const picks = await selectMemoriesForContext({
      memoryManager: mgr,
      query: 'anything',
    });
    assert.equal(picks.length, 0, 'should return empty array for empty memory');
  }

  // Test: returns empty array when query has no keyword overlap
  {
    const mgr = await seedManager('no-match', [
      makeEntry({ id: 'mem_a', content: 'RDK X5 OpenClaw configuration', scope: 'workspace' }),
    ]);
    const picks = await selectMemoriesForContext({
      memoryManager: mgr,
      query: 'something unrelated xyz',
    });
    assert.equal(picks.length, 0, 'should return empty when no keyword overlap');
  }

  // Test: returns picks when query matches content
  {
    const mgr = await seedManager('basic-match', [
      makeEntry({ id: 'mem_a', content: '用户偏好中文简洁回答', scope: 'workspace' }),
    ]);
    const picks = await selectMemoriesForContext({
      memoryManager: mgr,
      query: '用户偏好',
    });
    assert.ok(picks.length >= 1, 'should return at least one pick');
    assert.equal(picks[0].entry.id, 'mem_a');
    assert.equal(picks[0].scope, 'workspace');
    assert.ok(picks[0].score > 0, 'score should be positive');
    assert.ok(typeof picks[0].snippet === 'string');
  }

  // Test: scope priority — device picks come before workspace
  {
    const mgr = await seedManager('scope-priority', [
      makeEntry({ id: 'mem_ws', content: 'workspace level RDK config', scope: 'workspace', scopeRef: 'proj1' }),
      makeEntry({ id: 'mem_dev', content: 'device level RDK X5 board', scope: 'device', scopeRef: 'dev1' }),
    ]);
    const picks = await selectMemoriesForContext({
      memoryManager: mgr,
      deviceId: 'dev1',
      projectHash: 'proj1',
      query: 'RDK',
      deviceTopN: 2,
      workspaceTopN: 2,
      maxTotal: 4,
      minScore: 0,
    });
    assert.ok(picks.length >= 2, 'should have both device and workspace picks');
    // device picks should appear first
    const devicePick = picks.find(p => p.scope === 'device');
    const workspacePick = picks.find(p => p.scope === 'workspace');
    assert.ok(devicePick, 'should have device pick');
    assert.ok(workspacePick, 'should have workspace pick');
    const deviceIdx = picks.indexOf(devicePick);
    const workspaceIdx = picks.indexOf(workspacePick);
    assert.ok(deviceIdx < workspaceIdx, 'device pick should come before workspace pick');
  }

  // Test: respects maxTotal cap
  {
    const mgr = await seedManager('max-total', [
      makeEntry({ id: 'mem_1', content: 'RDK device config one', scope: 'device', scopeRef: 'dev1' }),
      makeEntry({ id: 'mem_2', content: 'RDK workspace setup two', scope: 'workspace', scopeRef: 'proj1' }),
      makeEntry({ id: 'mem_3', content: 'RDK user preference three', scope: 'user' }),
    ]);
    const picks = await selectMemoriesForContext({
      memoryManager: mgr,
      deviceId: 'dev1',
      projectHash: 'proj1',
      query: 'RDK',
      deviceTopN: 2,
      workspaceTopN: 2,
      userTopN: 2,
      maxTotal: 2,
      minScore: 0,
    });
    assert.equal(picks.length, 2, 'should cap at maxTotal=2');
    // should have device and workspace (highest priority scopes fill first)
    assert.ok(picks.some(p => p.scope === 'device'), 'should include device pick');
  }

  // Test: deduplication — same entry id not added twice across scopes
  {
    // An entry with scope=workspace but searched in both device and workspace
    // won't be double-counted because scope filtering in MemoryManager.search
    // prevents it. But we verify the seenIds dedup works regardless.
    const mgr = await seedManager('dedup', [
      makeEntry({ id: 'mem_shared', content: 'shared RDK config', scope: 'workspace', scopeRef: 'proj1' }),
    ]);
    const picks = await selectMemoriesForContext({
      memoryManager: mgr,
      projectHash: 'proj1',
      query: 'RDK',
      workspaceTopN: 2,
      maxTotal: 5,
      minScore: 0,
    });
    const ids = picks.map(p => p.entry.id);
    assert.equal(new Set(ids).size, ids.length, 'should not have duplicate entry ids');
  }

  // Test: minScore filtering — entries below threshold excluded
  {
    const mgr = await seedManager('min-score', [
      makeEntry({ id: 'mem_weak', content: 'something barely related mention', scope: 'workspace' }),
    ]);
    const picksHighBar = await selectMemoriesForContext({
      memoryManager: mgr,
      query: 'barely',
      workspaceTopN: 5,
      minScore: 100, // impossibly high
    });
    assert.equal(picksHighBar.length, 0, 'should exclude all entries with minScore=100');

    const picksZeroBar = await selectMemoriesForContext({
      memoryManager: mgr,
      query: 'barely',
      workspaceTopN: 5,
      minScore: 0, // accept all
    });
    assert.ok(picksZeroBar.length >= 1, 'should include entries with minScore=0');
  }

  // Test: default parameter values
  {
    const mgr = await seedManager('defaults', [
      makeEntry({ id: 'mem_d1', content: 'RDK board info', scope: 'device', scopeRef: 'dev1' }),
      makeEntry({ id: 'mem_w1', content: 'RDK project setup', scope: 'workspace', scopeRef: 'proj1' }),
      makeEntry({ id: 'mem_u1', content: 'RDK user tips', scope: 'user' }),
    ]);
    // defaults: deviceTopN=2, workspaceTopN=1, userTopN=1, maxTotal=3, minScore=0.3
    const picks = await selectMemoriesForContext({
      memoryManager: mgr,
      deviceId: 'dev1',
      projectHash: 'proj1',
      query: 'RDK',
    });
    assert.ok(picks.length <= 3, 'should respect default maxTotal=3');
  }

  // Test: deviceId not provided → skip device scope
  {
    const mgr = await seedManager('no-device', [
      makeEntry({ id: 'mem_dev', content: 'RDK device only', scope: 'device', scopeRef: 'dev1' }),
      makeEntry({ id: 'mem_ws', content: 'RDK workspace entry', scope: 'workspace' }),
    ]);
    const picks = await selectMemoriesForContext({
      memoryManager: mgr,
      query: 'RDK',
      workspaceTopN: 2,
      maxTotal: 5,
      minScore: 0,
      // no deviceId
    });
    assert.ok(picks.length >= 1, 'should find workspace entries');
    assert.ok(picks.every(p => p.scope !== 'device'), 'should not include device scope picks');
  }

  // Test: lower scopes not searched if higher scopes fill maxTotal
  {
    const mgr = await seedManager('early-stop', [
      makeEntry({ id: 'mem_d1', content: 'RDK device alpha', scope: 'device', scopeRef: 'dev1' }),
      makeEntry({ id: 'mem_d2', content: 'RDK device beta', scope: 'device', scopeRef: 'dev1' }),
      makeEntry({ id: 'mem_d3', content: 'RDK device gamma', scope: 'device', scopeRef: 'dev1' }),
      makeEntry({ id: 'mem_u1', content: 'RDK user preference', scope: 'user' }),
    ]);
    const picks = await selectMemoriesForContext({
      memoryManager: mgr,
      deviceId: 'dev1',
      query: 'RDK',
      deviceTopN: 5,
      maxTotal: 3,
      minScore: 0,
    });
    assert.equal(picks.length, 3, 'should fill from device scope and stop');
    assert.ok(picks.every(p => p.scope === 'device'), 'all picks should be device scope');
  }

  // ── renderMemoryPicksForSystemPrompt ──

  // Test: empty picks returns empty string
  {
    const result = renderMemoryPicksForSystemPrompt([]);
    assert.equal(result, '', 'should return empty string for empty picks');
  }

  // Test: renders header and pick lines
  {
    const picks = [
      {
        entry: { id: 'mem_abc', content: 'test content' },
        score: 1.5,
        snippet: 'test content snippet',
        scope: 'device',
      },
      {
        entry: { id: 'mem_def', content: 'other content' },
        score: 0.8,
        snippet: 'other content snippet',
        scope: 'user',
      },
    ];
    const result = renderMemoryPicksForSystemPrompt(picks);
    assert.ok(result.includes('## 已有记忆'), 'should include header');
    assert.ok(result.includes('[device · #mem_abc]'), 'should include device pick line');
    assert.ok(result.includes('[user · #mem_def]'), 'should include user pick line');
    assert.ok(result.includes('test content snippet'), 'should include snippet text');
  }

  // Test: uses snippet over content
  {
    const picks = [
      {
        entry: { id: 'mem_x', content: 'full content that is longer' },
        score: 1.0,
        snippet: 'short snippet',
        scope: 'workspace',
      },
    ];
    const result = renderMemoryPicksForSystemPrompt(picks);
    assert.ok(result.includes('short snippet'), 'should use snippet');
    assert.ok(!result.includes('full content that is longer'), 'should not use full content when snippet available');
  }

  // Test: falls back to content.slice when snippet is nullish
  {
    const picks = [
      {
        entry: { id: 'mem_y', content: 'fallback content text here' },
        score: 0.5,
        snippet: null,
        scope: 'user',
      },
    ];
    const result = renderMemoryPicksForSystemPrompt(picks);
    // null triggers ?? fallback to entry.content.slice(0, 200)
    assert.ok(result.includes('fallback content text here'), 'should fall back to content when snippet is null');
  }

  // Test: empty string snippet is used as-is (?? only checks nullish, not falsy)
  {
    const picks = [
      {
        entry: { id: 'mem_y2', content: 'content not shown' },
        score: 0.5,
        snippet: '',
        scope: 'workspace',
      },
    ];
    const result = renderMemoryPicksForSystemPrompt(picks);
    // '' is not nullish, so ?? uses the empty string, not the fallback
    assert.ok(!result.includes('content not shown'), 'should use empty snippet rather than fallback');
  }

  // Test: applies sanitizeFn when provided
  {
    const picks = [
      {
        entry: { id: 'mem_z', content: 'has <script>evil</script> content' },
        score: 1.0,
        snippet: 'has <script>evil</script> content',
        scope: 'workspace',
      },
    ];
    const sanitize = (text) => text.replace(/<[^>]*>/g, '');
    const result = renderMemoryPicksForSystemPrompt(picks, sanitize);
    assert.ok(result.includes('has evil content'), 'should apply sanitize function');
    assert.ok(!result.includes('<script>'), 'should remove script tags');
  }

  // Test: output format — each line is [scope · #id] content
  {
    const picks = [
      {
        entry: { id: 'mem_fmt', content: 'formatted line' },
        score: 1.0,
        snippet: 'formatted line',
        scope: 'device',
      },
    ];
    const result = renderMemoryPicksForSystemPrompt(picks);
    const lines = result.split('\n');
    const contentLine = lines.find(l => l.includes('#mem_fmt'));
    assert.ok(contentLine, 'should have content line with id');
    assert.match(contentLine, /^\[device · #mem_fmt\] formatted line$/, 'line format should match [scope · #id] content');
  }

  console.log('[memory-context-selector.spec] PASS');
} finally {
  await rmrf(base);
}
