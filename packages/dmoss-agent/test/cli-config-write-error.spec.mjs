#!/usr/bin/env node
/**
 * Config-write failures must surface a clean, one-line message — never a raw
 * Node `writeFileSync` stack trace through the top-level `Fatal:` handler.
 *
 * Regression: `moss config set model x` against a read-only / unwritable config
 * dir printed `Fatal: Error: EACCES … at Object.writeFileSync (...)` with all
 * internal frames. saveConfigFileAtPath now wraps the failure in a typed
 * CliConfigWriteError ("cannot write config to <path>: <reason>") and cli-main
 * prints that line alone.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-config-write-error.spec.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliConfigWriteError, saveConfigFileAtPath } from '../dist/cli/config.js';

const repoPackageDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const distCli = path.join(repoPackageDir, 'dist', 'cli.js');

// 1) Unit: saveConfigFileAtPath wraps a write failure in CliConfigWriteError
//    with a stack-free, actionable message. Parenting the target dir under a
//    regular file forces mkdir to fail deterministically on every platform
//    (ENOTDIR on POSIX, EEXIST on Windows) — no chmod/root assumptions.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cfg-write-'));
  try {
    const fileAsParent = path.join(tmp, 'not-a-dir');
    fs.writeFileSync(fileAsParent, 'x');
    const badPath = path.join(fileAsParent, 'config.json');
    let caught;
    try {
      saveConfigFileAtPath({ model: 'x' }, badPath);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'saveConfigFileAtPath must throw when the path is unwritable');
    assert.ok(caught instanceof CliConfigWriteError, `expected CliConfigWriteError, got ${caught?.name}`);
    assert.equal(caught.configPath, badPath);
    assert.match(caught.message, /^cannot write config to .+: /);
    assert.doesNotMatch(caught.message, /writeFileSync|mkdirSync|\bat /, 'message must not embed a stack');
    console.log('  [PASS] saveConfigFileAtPath wraps write failures in CliConfigWriteError');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 2) End-to-end: `moss config set` against an unwritable config dir prints the
//    clean one-liner and exits 1 — no raw stack, no `Fatal:` dump.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cfg-write-cli-'));
  try {
    const fileAsParent = path.join(tmp, 'not-a-dir');
    fs.writeFileSync(fileAsParent, 'x');
    const result = spawnSync(process.execPath, [distCli, 'config', 'set', 'model', 'test-model'], {
      cwd: repoPackageDir,
      env: {
        PATH: process.env.PATH,
        HOME: path.join(tmp, 'home'),
        DMOSS_CONFIG_DIR: path.join(fileAsParent, 'sub'),
        DMOSS_NO_BUNDLED_DEFAULT: '1',
        DMOSS_NO_UPDATE_CHECK: '1',
        DMOSS_NO_COLOR: '1',
        LANG: 'C.UTF-8',
      },
      encoding: 'utf8',
    });
    const out = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}\n${out}`);
    assert.match(out, /moss: cannot write config to .+: /, `expected clean error line, got:\n${out}`);
    assert.doesNotMatch(out, /at Object\.writeFileSync|at saveConfigFileAtPath|^Fatal:/m, `stack leaked:\n${out}`);
    console.log('  [PASS] `moss config set` surfaces a clean config-write error, not a stack');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('cli-config-write-error: all checks passed');
