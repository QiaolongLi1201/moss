#!/usr/bin/env node
/**
 * @rdk-moss/memory — MemoryManager.buildDigest unit tests
 *
 * Run after package build:
 *   npm run build -w @rdk-moss/memory && node packages/dmoss-memory/test/memory-digest.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'index.js');
const { MemoryManager } = await import(pathToFileURL(distJs).href);

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-mem-digest-'));

let seq = 0;
function makeEntry(opts) {
  seq += 1;
  return {
    id: opts.id,
    content: opts.content,
    source: opts.source ?? 'memory',
    hash: opts.hash ?? opts.id.replace('mem_', ''),
    createdAt: opts.createdAt ?? 1_700_000_000_000 + seq * 1000,
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts.scopeRef !== undefined ? { scopeRef: opts.scopeRef } : {}),
    ...(opts.pinned !== undefined ? { pinned: opts.pinned } : {}),
    ...(opts.stale !== undefined ? { stale: opts.stale } : {}),
    ...(opts.accessedAt !== undefined ? { accessedAt: opts.accessedAt } : {}),
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

const digestLines = (d) => d.split('\n').filter((l) => l.startsWith('- '));

try {
  // empty memory → empty string (inject unconditionally without noise)
  {
    const mgr = await seedManager('empty', []);
    assert.equal(await mgr.buildDigest(), '', 'empty memory yields empty digest');
  }

  // single entry → wrapped block with content, id, and usage guidance
  {
    const mgr = await seedManager('single', [
      makeEntry({ id: 'mem_a', content: '用户偏好中文、简洁回答', scope: 'user' }),
    ]);
    const d = await mgr.buildDigest();
    assert.ok(d.includes('<dmoss_memory>') && d.includes('</dmoss_memory>'), 'wrapped in block');
    assert.ok(d.includes('用户偏好中文、简洁回答'), 'includes content');
    assert.ok(d.includes('#mem_a'), 'includes id');
    assert.ok(d.includes('memory_read') && d.includes('memory_write'), 'includes usage guidance');
  }

  // pinned sorts first and is tagged, regardless of recency
  {
    const mgr = await seedManager('pinned', [
      makeEntry({ id: 'mem_new', content: 'newer non-pinned fact', scope: 'workspace', createdAt: 9000 }),
      makeEntry({ id: 'mem_pin', content: 'pinned fact', scope: 'workspace', pinned: true, createdAt: 2 }),
    ]);
    const lines = digestLines(await mgr.buildDigest());
    assert.ok(lines[0].includes('#mem_pin'), 'pinned entry first even though older');
    assert.ok(lines[0].includes('[pin]'), 'pinned entry tagged');
  }

  // newest non-pinned first
  {
    const mgr = await seedManager('recency', [
      makeEntry({ id: 'mem_1', content: 'first', scope: 'workspace', createdAt: 1000 }),
      makeEntry({ id: 'mem_2', content: 'second', scope: 'workspace', createdAt: 2000 }),
    ]);
    const lines = digestLines(await mgr.buildDigest());
    assert.ok(lines[0].includes('#mem_2'), 'newer entry first');
  }

  // excludes learning scope and explicitly-stale entries
  {
    const mgr = await seedManager('exclude', [
      makeEntry({ id: 'mem_learn', content: 'study note', scope: 'learning' }),
      makeEntry({ id: 'mem_stale', content: 'stale fact', scope: 'workspace', stale: true }),
      makeEntry({ id: 'mem_live', content: 'live fact', scope: 'workspace' }),
    ]);
    const d = await mgr.buildDigest();
    assert.ok(d.includes('#mem_live'), 'includes live entry');
    assert.ok(!d.includes('#mem_learn'), 'excludes learning scope');
    assert.ok(!d.includes('#mem_stale'), 'excludes stale entry');
  }

  // maxEntries cap + overflow footer
  {
    const entries = [];
    for (let i = 0; i < 20; i++) {
      entries.push(makeEntry({ id: `mem_${i}`, content: `fact ${i}`, scope: 'workspace', createdAt: 1000 + i }));
    }
    const mgr = await seedManager('cap', entries);
    const d = await mgr.buildDigest({ maxEntries: 5 });
    assert.equal(digestLines(d).length, 5, 'caps at maxEntries');
    assert.ok(d.includes('…and 15 more'), 'footer reports remaining count');
  }

  // scopes option narrows what is included
  {
    const mgr = await seedManager('scopes', [
      makeEntry({ id: 'mem_u', content: 'user pref', scope: 'user' }),
      makeEntry({ id: 'mem_w', content: 'workspace fact', scope: 'workspace' }),
    ]);
    const d = await mgr.buildDigest({ scopes: ['user'] });
    assert.ok(d.includes('#mem_u'), 'includes requested scope');
    assert.ok(!d.includes('#mem_w'), 'excludes non-requested scope');
  }

  // device scopeRef leniency: ref-less = global, matching ref kept, mismatched ref dropped
  {
    const mgr = await seedManager('deviceref', [
      makeEntry({ id: 'mem_noref', content: 'ref-less device fact', scope: 'device' }),
      makeEntry({ id: 'mem_dev1', content: 'dev1 fact', scope: 'device', scopeRef: 'dev1' }),
      makeEntry({ id: 'mem_dev2', content: 'dev2 fact', scope: 'device', scopeRef: 'dev2' }),
    ]);
    const d = await mgr.buildDigest({ deviceId: 'dev1' });
    assert.ok(d.includes('#mem_noref'), 'ref-less device entry treated as global');
    assert.ok(d.includes('#mem_dev1'), 'matching device ref kept');
    assert.ok(!d.includes('#mem_dev2'), 'mismatched device ref dropped');
  }

  // maxChars budget keeps at least one entry but bounds the rest
  {
    const long = 'x'.repeat(300);
    const entries = [];
    for (let i = 0; i < 10; i++) {
      entries.push(makeEntry({ id: `mem_${i}`, content: `${long} ${i}`, scope: 'workspace', createdAt: 1000 + i }));
    }
    const mgr = await seedManager('chars', entries);
    const lines = digestLines(await mgr.buildDigest({ maxChars: 400, maxEntries: 50 }));
    assert.ok(lines.length >= 1, 'keeps at least one entry under a tight budget');
    assert.ok(lines.length < 10, 'char budget bounds entry count');
  }

  console.log('[memory-digest.spec] PASS');
} finally {
  await rmrf(base);
}
