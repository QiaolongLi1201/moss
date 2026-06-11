#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-file-suggest.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  suggestWorkspaceFiles,
  detectAtReference,
  parseAtReferences,
} from '../dist/cli/file-suggest.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-filesuggest-'));
try {
  fs.writeFileSync(path.join(ws, 'README.md'), '# readme');
  fs.writeFileSync(path.join(ws, 'package.json'), '{}');
  fs.writeFileSync(path.join(ws, 'robot.ts'), 'export const r = 1;');
  fs.writeFileSync(path.join(ws, 'robot-config.ts'), 'export const c = 1;');
  fs.mkdirSync(path.join(ws, 'src'));
  fs.writeFileSync(path.join(ws, 'src', 'index.ts'), 'export {};');
  fs.writeFileSync(path.join(ws, 'src', 'runtime.ts'), 'export {};');
  fs.mkdirSync(path.join(ws, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'node_modules', 'pkg', 'index.js'), '');
  fs.mkdirSync(path.join(ws, '.git'));
  fs.writeFileSync(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/main');

  // ── detectAtReference ──
  assert.deepEqual(detectAtReference('', 0), null);
  assert.deepEqual(detectAtReference('hello world', 11), null);
  assert.deepEqual(detectAtReference('@rob', 4), { partial: 'rob', start: 0 });
  assert.deepEqual(detectAtReference('look at @src/', 13), { partial: 'src/', start: 8 });
  assert.deepEqual(detectAtReference('foo@bar', 7), null);
  assert.deepEqual(detectAtReference('@robot.ts ', 10), null);

  // ── suggestWorkspaceFiles: top-level fuzzy ──
  const rob = suggestWorkspaceFiles('rob', ws).map((s) => s.rel);
  assert.ok(rob.includes('robot.ts'), 'robot.ts suggested for "rob"');
  assert.ok(rob.includes('robot-config.ts'), 'robot-config.ts suggested for "rob"');

  const rbt = suggestWorkspaceFiles('rbt', ws).map((s) => s.rel);
  assert.ok(rbt.includes('robot.ts'), '"rbt" fuzzy-matches robot.ts');

  const all = suggestWorkspaceFiles('', ws).map((s) => s.rel);
  assert.ok(all.includes('src/'), 'src/ offered as a directory with trailing slash');
  assert.ok(!all.includes('node_modules/'), 'node_modules skipped');
  assert.ok(!all.includes('.git/'), '.git skipped');

  const inSrc = suggestWorkspaceFiles('src/ind', ws).map((s) => s.rel);
  assert.deepEqual(inSrc, ['src/index.ts'], 'src/ind → src/index.ts');

  const allSrc = suggestWorkspaceFiles('src/', ws).map((s) => s.rel).sort();
  assert.deepEqual(allSrc, ['src/index.ts', 'src/runtime.ts'], 'src/ lists both files');

  const capped = suggestWorkspaceFiles('', ws, { limit: 2 });
  assert.equal(capped.length, 2, 'limit caps results');

  assert.deepEqual(suggestWorkspaceFiles('../', ws), [], 'parent-dir escape returns nothing');
  assert.deepEqual(suggestWorkspaceFiles('zzzznope', ws), [], 'no match → empty');

  // ── parseAtReferences ──
  assert.deepEqual(parseAtReferences('explain @robot.ts please'), ['robot.ts']);
  assert.deepEqual(parseAtReferences('@src/index.ts and @robot.ts'), ['src/index.ts', 'robot.ts']);
  assert.deepEqual(parseAtReferences('@src/ @src/ foo@bar'), ['src']);
  assert.deepEqual(parseAtReferences('no refs here'), []);

  console.log('[PASS] cli-file-suggest: @-file suggestion + detection + extraction');
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}
