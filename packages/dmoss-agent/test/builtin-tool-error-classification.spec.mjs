#!/usr/bin/env node
/**
 * Regression: builtin tool failures must be classified as errors.
 * Before the fix, read_file (and friends) returned "Error reading file: ..."
 * as a plain success string, so the CLI showed "ok", and skill-learning
 * recorded `failed: false` for a tool call that actually failed.
 *
 * Contract: tool failures THROW; the execution pipeline turns throws into
 * `isError: true` results.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/builtin-tool-error-classification.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinTools } from '../dist/tools/builtin.js';

const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]));
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-err-classify-'));
const ctx = { workspaceDir };

// 1) read_file on a missing path must reject (not return an "Error ..." string).
await assert.rejects(
  () => byName.read_file.execute({ path: 'does-not-exist.txt' }, ctx),
  /Error reading file/,
  'read_file must throw for a missing file',
);
console.log('  [PASS] read_file throws on missing file');

// 2) list_directory on a missing path must reject.
await assert.rejects(
  () => byName.list_directory.execute({ path: 'no-such-dir/' }, ctx),
  /Error listing directory/,
  'list_directory must throw for a missing directory',
);
console.log('  [PASS] list_directory throws on missing directory');

// 3) Successful read still returns content as a plain string.
fs.writeFileSync(path.join(workspaceDir, 'ok.txt'), 'hello\n');
const ok = await byName.read_file.execute({ path: 'ok.txt' }, ctx);
assert.match(ok, /hello/);
console.log('  [PASS] read_file success path unchanged');

fs.rmSync(workspaceDir, { recursive: true, force: true });
console.log('[PASS] builtin tool error classification');
