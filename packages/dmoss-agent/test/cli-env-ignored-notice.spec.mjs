#!/usr/bin/env node
/**
 * The startup "[config] ignoring model env var(s): …" notice is informational,
 * not a warning. It must respect the resolved CLI log level: `--quiet` and
 * `DMOSS_LOG_LEVEL=warn` silence it. The doctor report keeps showing the
 * ignored vars as the structured source of truth regardless of log level.
 *
 * Regression: the notice printed on EVERY chat/one-shot/resume invocation, so
 * `moss --quiet -p "…"` could not produce clean stdout-only output.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-env-ignored-notice.spec.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoPackageDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const distCli = path.join(repoPackageDir, 'dist', 'cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-env-notice-'));

const NOTICE = /ignoring model env var\(s\)/;

function run(args, extraEnv = {}) {
  // No api key + no bundled default → a one-shot stops at the missing-config
  // gate (after the env-ignored notice, before any model call). OPENAI_API_KEY
  // is a deliberately-ignored model env var, so the notice triggers.
  const result = spawnSync(process.execPath, [distCli, ...args], {
    cwd: repoPackageDir,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(tmp, 'home'),
      DMOSS_CONFIG_DIR: path.join(tmp, 'config'),
      DMOSS_NO_BUNDLED_DEFAULT: '1',
      DMOSS_NO_UPDATE_CHECK: '1',
      DMOSS_NO_COLOR: '1',
      LANG: 'C.UTF-8',
      OPENAI_API_KEY: 'leftover-from-another-tool',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
  return `${result.stdout}\n${result.stderr}`;
}

try {
  // Default log level: the notice is shown.
  assert.match(run(['-p', 'hi']), NOTICE, 'notice must show at the default log level');

  // --quiet (resolves to log level "warn") silences the notice.
  assert.doesNotMatch(run(['--quiet', '-p', 'hi']), NOTICE, '--quiet must silence the notice');

  // DMOSS_LOG_LEVEL=warn silences the notice.
  assert.doesNotMatch(
    run(['-p', 'hi'], { DMOSS_LOG_LEVEL: 'warn' }),
    NOTICE,
    'DMOSS_LOG_LEVEL=warn must silence the notice',
  );

  // doctor keeps the ignored env var as the source of truth even under --quiet.
  assert.match(run(['--quiet', 'doctor']), /OPENAI_API_KEY/, 'doctor must still report ignored env vars');

  console.log('[PASS] env-ignored notice respects log level; doctor stays the source of truth');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
