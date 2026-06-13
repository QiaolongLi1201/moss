#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSessionFile } from '../dist/core/session/session-jsonl-codec.js';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codec-val-'));
const testFile = path.join(tmpDir, 'bad.jsonl');

const hdr = { type: 'session', version: 3, id: 'id1', timestamp: new Date().toISOString() };
const msg = { type: 'message', id: 'msg1', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi', timestamp: Date.now() } };
const comp = { type: 'compaction', id: 'comp1', parentId: 'msg1', timestamp: new Date().toISOString(), summary: 'sum', firstKeptEntryId: 'missing', tokensBefore: 100 };

const content = [hdr, msg, comp].map(e => JSON.stringify(e)).join('\n') + '\n';
await fs.writeFile(testFile, content);

const warns = [];
const old = console.warn;
console.warn = (...a) => warns.push(a.join(' '));
try {
  const { entries } = await loadSessionFile(testFile);
  assert.ok(entries.length > 0, 'compaction with bad ID loads');
  assert.ok(warns.some(w => w.includes('nonexistent')), 'warns about missing ID');
} finally {
  console.warn = old;
}

console.log('[PASS] session-codec-validation');
