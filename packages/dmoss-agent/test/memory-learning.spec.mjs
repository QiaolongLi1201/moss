#!/usr/bin/env node
/**
 * @rdk-moss/agent MemoryManager — learning scope + topic/starred (2026-05-01-memory-learning-scope-add)
 *
 * Run after package build:
 *   npm run build -w @rdk-moss/agent && node packages/dmoss-agent/test/memory-learning.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'core', 'memory', 'memory.js');
const { MemoryManager } = await import(pathToFileURL(distJs).href);

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-mem-learn-'));

try {
  const memDir = path.join(base, 'm1');

  await fs.mkdir(memDir, { recursive: true });
  const legacyRaw = [
    {
      id: 'mem_legacy',
      content: 'legacy fact',
      source: 'memory',
      hash: 'abc',
      createdAt: 1,
    },
  ];
  await fs.writeFile(path.join(memDir, 'index.json'), JSON.stringify(legacyRaw));

  const m1 = new MemoryManager(memDir);
  await m1.load();

  const ws = await m1.listByScope('workspace');
  assert.equal(ws.length, 1);
  assert.equal(ws[0].scope ?? 'workspace', 'workspace');
  assert.equal(ws[0].starred, undefined);
  assert.equal(ws[0].topic, undefined);

  await m1.add('learning note one', 'memory', undefined, {
    scope: 'learning',
    topic: 'usb',
    starred: true,
  });
  await m1.update('mem_legacy', { scope: 'learning', topic: 'ros', starred: false });

  const leg = await m1.getById('mem_legacy');
  assert.ok(leg);
  assert.equal(leg.scope, 'learning');
  assert.equal(leg.topic, 'ros');
  assert.equal(leg.starred, undefined);

  const learn = await m1.listByScope('learning');
  assert.ok(learn.length >= 2);

  const ranks = await m1.search('learning', 10, { scope: 'learning' });
  assert.ok(Array.isArray(ranks));

  const idUsb = learn.find((e) => e.topic === 'usb')?.id;
  assert.ok(idUsb);
  assert.equal(await m1.update(idUsb, { topic: '', starred: false }), true);
  const after = await m1.getById(idUsb);
  assert.ok(after);
  assert.equal(after.topic, undefined);
  assert.equal(after.starred, undefined);

  /** Case 4: stale JSON with unknown scope string — survives load; coerce not required */
  const memDir2 = path.join(base, 'm2');
  await fs.mkdir(memDir2, { recursive: true });
  await fs.writeFile(path.join(memDir2, 'index.json'), '[{"id":"x","content":"z","source":"memory","hash":"dead","createdAt":2,"scope":"workspace"}]');
  const m2 = new MemoryManager(memDir2);
  const ws2 = await m2.listByScope('workspace');
  assert.equal(ws2.length, 1);
} finally {
  await rmrf(base);
}

console.log('[memory-learning.spec] PASS');
