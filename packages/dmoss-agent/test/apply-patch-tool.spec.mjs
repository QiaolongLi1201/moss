#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyPatchTool } from '../dist/tools/builtin.js';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-apply-patch-tool-'));
const workspaceDir = path.join(tmpRoot, 'workspace');
const ctx = { workspaceDir, sessionKey: 'apply-patch-tool-test' };

try {
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, 'app.ts'), 'const oldName = 1;\nconsole.log(oldName);\n');
  await fs.writeFile(path.join(workspaceDir, 'dead.ts'), 'remove me\n');

  {
    const patch = [
      '*** Begin Patch',
      '*** Update File: app.ts',
      '@@',
      '-const oldName = 1;',
      '+const newName = 1;',
      '-console.log(oldName);',
      '+console.log(newName);',
      '*** Add File: added.ts',
      '+export const added = true;',
      '*** Delete File: dead.ts',
      '*** End Patch',
    ].join('\n');
    const result = await applyPatchTool.execute({ patch }, ctx);
    assert.match(result, /Patch applied/);
    assert.equal(await fs.readFile(path.join(workspaceDir, 'app.ts'), 'utf-8'), 'const newName = 1;\nconsole.log(newName);\n');
    assert.equal(await fs.readFile(path.join(workspaceDir, 'added.ts'), 'utf-8'), 'export const added = true;');
    await assert.rejects(fs.stat(path.join(workspaceDir, 'dead.ts')), /ENOENT/);
  }

  {
    await fs.writeFile(path.join(workspaceDir, 'safe.ts'), 'alpha\nbeta\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: safe.ts',
      '@@',
      '-alpha',
      '+ALPHA',
      '*** Update File: missing.ts',
      '@@',
      '-x',
      '+y',
      '*** End Patch',
    ].join('\n');
    const result = await applyPatchTool.execute({ patch }, ctx);
    assert.match(result, /Patch failed|Patch rejected/);
    assert.equal(await fs.readFile(path.join(workspaceDir, 'safe.ts'), 'utf-8'), 'alpha\nbeta\n');
  }

  {
    await fs.writeFile(path.join(workspaceDir, 'crlf.txt'), 'one\r\ntwo\r\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: crlf.txt',
      '@@',
      '-two',
      '+TWO',
      '*** End Patch',
    ].join('\n');
    const result = await applyPatchTool.execute({ patch }, ctx);
    assert.match(result, /Patch applied/);
    assert.equal(await fs.readFile(path.join(workspaceDir, 'crlf.txt'), 'utf-8'), 'one\r\nTWO\r\n');
  }

  {
    await fs.writeFile(path.join(workspaceDir, 'mixed.txt'), 'one\r\ntwo\nthree\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: mixed.txt',
      '@@',
      '-two',
      '+TWO',
      '*** End Patch',
    ].join('\n');
    const result = await applyPatchTool.execute({ patch }, ctx);
    assert.match(result, /Patch applied/);
    assert.doesNotMatch(await fs.readFile(path.join(workspaceDir, 'mixed.txt'), 'utf-8'), /\r\nTWO\r\nthree/);
  }

  {
    const patch = [
      '*** Begin Patch',
      '*** Add File: transient.txt',
      '+temporary',
      '*** Delete File: transient.txt',
      '*** End Patch',
    ].join('\n');
    const result = await applyPatchTool.execute({ patch }, ctx);
    assert.match(result, /cannot delete file added in same patch/);
    await assert.rejects(fs.stat(path.join(workspaceDir, 'transient.txt')), /ENOENT/);
  }

  {
    await fs.writeFile(path.join(workspaceDir, 'chain.txt'), 'a\nb\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: chain.txt',
      '@@',
      '-a',
      '+A',
      '*** Update File: chain.txt',
      '@@',
      '-b',
      '+B',
      '*** End Patch',
    ].join('\n');
    const result = await applyPatchTool.execute({ patch }, ctx);
    assert.match(result, /Patch applied/);
    assert.equal(await fs.readFile(path.join(workspaceDir, 'chain.txt'), 'utf-8'), 'A\nB\n');
  }

  {
    await fs.writeFile(path.join(workspaceDir, 'nul.bin'), Buffer.from([0x61, 0x00, 0x62]));
    const patch = [
      '*** Begin Patch',
      '*** Update File: nul.bin',
      '@@',
      '-a',
      '+A',
      '*** End Patch',
    ].join('\n');
    const result = await applyPatchTool.execute({ patch }, ctx);
    assert.match(result, /binary-looking/);
  }

  {
    await fs.writeFile(path.join(workspaceDir, 'invalid.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const patch = [
      '*** Begin Patch',
      '*** Update File: invalid.bin',
      '@@',
      '-PNG',
      '+png',
      '*** End Patch',
    ].join('\n');
    const result = await applyPatchTool.execute({ patch }, ctx);
    assert.match(result, /non-UTF-8/);
  }

  {
    const patch = [
      '*** Begin Patch',
      '*** Add File: ../escape.txt',
      '+nope',
      '*** End Patch',
    ].join('\n');
    const result = await applyPatchTool.execute({ patch }, ctx);
    assert.match(result, /Patch failed|Patch rejected|sandbox|outside/i);
    await assert.rejects(fs.stat(path.join(tmpRoot, 'escape.txt')), /ENOENT/);
  }

  console.log('[PASS] apply_patch builtin tool validates, applies, preserves CRLF, and respects sandbox');
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
