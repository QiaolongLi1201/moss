#!/usr/bin/env node
/**
 * Regression tests for search_files path-aware glob matching.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/search-files-glob-path.spec.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { searchFilesTool } from '../dist/tools/builtin.js';

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-search-files-'));

function resultPaths(output) {
  if (output === 'No files found') return [];
  return output
    .split('\n')
    .filter(Boolean)
    .map((file) => path.relative(workspaceDir, file).split(path.sep).join('/'))
    .sort();
}

try {
  await fs.mkdir(path.join(workspaceDir, 'src', 'nested'), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, 'src', 'a.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(workspaceDir, 'src', 'nested', 'b.ts'), 'export const b = 1;\n');
  await fs.writeFile(path.join(workspaceDir, 'docs', 'c.ts'), 'export const c = 1;\n');
  await fs.writeFile(path.join(workspaceDir, 'README.md'), '# test\n');

  const ctx = { workspaceDir, sessionKey: 'search-files-glob-path' };
  const pathGlobResult = await searchFilesTool.execute({ pattern: 'src/**/*.ts' }, ctx);
  const pathGlobMatches = resultPaths(pathGlobResult);

  assert.deepEqual(
    pathGlobMatches,
    ['src/a.ts', 'src/nested/b.ts'],
    'path glob should match files under src and not unrelated basenames',
  );

  const scopedPathGlobResult = await searchFilesTool.execute(
    { pattern: '**/*.ts', path: 'src' },
    ctx,
  );
  const scopedPathGlobMatches = resultPaths(scopedPathGlobResult);

  assert.deepEqual(
    scopedPathGlobMatches,
    ['src/a.ts', 'src/nested/b.ts'],
    'path option should make glob matching relative to the selected search root',
  );

  const basenameGlobResult = await searchFilesTool.execute({ pattern: '*.md' }, ctx);
  const basenameGlobMatches = resultPaths(basenameGlobResult);

  assert.deepEqual(
    basenameGlobMatches,
    ['README.md'],
    'basename glob behavior should stay compatible',
  );
} finally {
  await fs.rm(workspaceDir, { recursive: true, force: true });
}

console.log('[PASS] search_files supports path globs and basename globs');
