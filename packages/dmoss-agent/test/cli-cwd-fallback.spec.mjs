#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoPackageDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const distCli = path.join(repoPackageDir, 'dist', 'cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cwd-fallback-'));
const wrapper = path.join(tmp, 'run-cli-with-throwing-cwd.mjs');
const badCwd = path.join(tmp, 'bad-cwd');
const configDir = path.join(tmp, 'config');
const fallbackHome = path.join(tmp, 'home');
fs.mkdirSync(badCwd);

fs.writeFileSync(wrapper, `
import { fileURLToPath } from 'node:url';

const badCwd = process.argv[2];
const cliUrl = process.argv[3];
const cliPath = fileURLToPath(cliUrl);
process.chdir(badCwd);
const err = new Error('operation not permitted, uv_cwd');
err.code = 'EPERM';
err.syscall = 'uv_cwd';
Object.defineProperty(process, 'cwd', {
  configurable: true,
  value: () => { throw err; },
});
process.argv = [process.execPath, cliPath, ...process.argv.slice(4)];
await import(cliUrl);
`);

try {
  const result = spawnSync(process.execPath, [
    wrapper,
    badCwd,
    pathToFileURL(distCli).href,
    'config',
    'show',
    '--json',
  ], {
    cwd: repoPackageDir,
    env: {
      PATH: process.env.PATH,
      HOME: fallbackHome,
      XDG_CONFIG_HOME: path.join(fallbackHome, '.config'),
      DMOSS_CONFIG_DIR: configDir,
      DMOSS_NO_BUNDLED_DEFAULT: '1',
      DMOSS_NO_UPDATE_CHECK: '1',
      DMOSS_NO_COLOR: '1',
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.workspace, fallbackHome);
  assert.equal(parsed.workspaceSource, 'cwd-fallback');
  console.log('[PASS] CLI config tolerates inaccessible process.cwd at startup');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const { resolveCliConfig } = await import('../dist/cli/config.js');
  const originalCwd = process.cwd;
  const err = new Error('operation not permitted, uv_cwd');
  err.code = 'EPERM';
  err.syscall = 'uv_cwd';
  process.cwd = () => { throw err; };
  try {
    const resolved = resolveCliConfig({ DMOSS_NO_BUNDLED_DEFAULT: '1' }, {});
    assert.equal(resolved.workspace, os.homedir());
    assert.equal(resolved.workspaceSource, 'cwd-fallback');
    console.log('[PASS] resolveCliConfig falls back when process.cwd throws');
  } finally {
    process.cwd = originalCwd;
  }
}
