#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../dist/core/session/session-manager.js';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rot-val-'));
const manager = new SessionManager(tmpDir);
const key = 'rotation-val';

const m1 = { role: 'user', content: 'test', timestamp: 1000 };
const m2 = { role: 'assistant', content: 'ok', timestamp: 2000 };

await manager.append(key, m1);
await manager.append(key, m2);

const reloaded = await manager.load(key);
assert.equal(reloaded.length, 2, 'rotation validation preserves messages');

console.log('[PASS] session-rotation-validation');
