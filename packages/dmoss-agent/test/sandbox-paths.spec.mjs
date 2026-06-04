#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assertSandboxPath } from '../dist/safety/index.js';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-sandbox-paths-'));

try {
  const workspaceDir = path.join(tmpRoot, 'workspace');
  const outsideDir = path.join(tmpRoot, 'outside');
  const symlinkRoot = path.join(tmpRoot, 'linked-root');
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'secret');
  await fs.symlink(outsideDir, symlinkRoot);

  await assert.rejects(
    assertSandboxPath({
      filePath: 'secret.txt',
      cwd: symlinkRoot,
      root: workspaceDir,
      extraRoots: [symlinkRoot],
    }),
    /symlink/i,
    'extra root itself must not be a symlink to another directory',
  );

  await assert.rejects(
    assertSandboxPath({
      filePath: 'new.txt',
      cwd: symlinkRoot,
      root: workspaceDir,
      extraRoots: [symlinkRoot],
    }),
    /symlink/i,
    'creating a new file under a symlink extra root must still be rejected',
  );

  const safeExtraRoot = path.join(tmpRoot, 'safe-extra');
  await fs.mkdir(safeExtraRoot, { recursive: true });
  const safe = await assertSandboxPath({
    filePath: 'ok.txt',
    cwd: safeExtraRoot,
    root: workspaceDir,
    extraRoots: [safeExtraRoot],
  });
  assert.equal(safe.resolved, path.join(safeExtraRoot, 'ok.txt'));

  console.log('[PASS] sandbox paths reject symlink roots');
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
