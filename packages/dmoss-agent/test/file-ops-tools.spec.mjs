#!/usr/bin/env node
/**
 * Test: read_file paging (offset/limit) and the move_file tool.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readFileTool, moveFileTool } from '../dist/tools/builtin.js';

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-fileops-'));
const CTX = { workspaceDir: dir, sessionKey: 'test' };
await fs.writeFile(path.join(dir, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\n');

console.log('[TEST] read_file offset/limit returns a line range');
{
  const out = await readFileTool.execute({ path: 'a.txt', offset: 2, limit: 2 }, CTX);
  assert.match(out, /\[lines 2-3 of 6\]/, 'should report the line range');
  assert.match(out, /l2\nl3/, 'should return the requested lines');
  assert.doesNotMatch(out, /l1/, 'lines before the offset should be excluded');
  assert.doesNotMatch(out, /l4/, 'lines past the limit should be excluded');
}

console.log('[TEST] read_file without range is unchanged (full content)');
{
  const out = await readFileTool.execute({ path: 'a.txt' }, CTX);
  assert.equal(out, 'l1\nl2\nl3\nl4\nl5\n', 'full read should return raw content');
}

console.log('[TEST] move_file renames and creates parent dirs');
{
  const out = await moveFileTool.execute({ source: 'a.txt', destination: 'sub/b.txt' }, CTX);
  assert.match(out, /Moved a\.txt -> sub\/b\.txt/);
  assert.ok(await exists(path.join(dir, 'sub', 'b.txt')), 'destination should exist');
  assert.ok(!(await exists(path.join(dir, 'a.txt'))), 'source should be gone');
}

console.log('[TEST] move_file refuses to clobber without overwrite');
{
  await fs.writeFile(path.join(dir, 'c.txt'), 'existing');
  const out = await moveFileTool.execute({ source: 'sub/b.txt', destination: 'c.txt' }, CTX);
  assert.match(out, /already exists/);
  assert.equal(await fs.readFile(path.join(dir, 'c.txt'), 'utf8'), 'existing', 'target must be untouched');
}

console.log('[TEST] move_file overwrite=true replaces the destination');
{
  const out = await moveFileTool.execute(
    { source: 'sub/b.txt', destination: 'c.txt', overwrite: true },
    CTX,
  );
  assert.match(out, /Moved/);
  assert.ok(!(await exists(path.join(dir, 'sub', 'b.txt'))), 'source should be gone after overwrite move');
}

console.log('[TEST] move_file rejects a missing source');
{
  const out = await moveFileTool.execute({ source: 'nope.txt', destination: 'x.txt' }, CTX);
  assert.match(out, /source does not exist/);
}

console.log('[TEST] move_file blocks escaping the sandbox');
{
  const out = await moveFileTool.execute({ source: 'c.txt', destination: '../escape.txt' }, CTX);
  assert.match(out, /Error/, 'a path outside the workspace must be rejected');
  assert.ok(!(await exists(path.join(dir, '..', 'escape.txt'))), 'no file should be written outside the sandbox');
}

await fs.rm(dir, { recursive: true, force: true });
console.log('\n[PASS] file-ops tool tests');
