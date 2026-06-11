#!/usr/bin/env node
/**
 * Fresh-install regressions behind "moss asks me to configure a model":
 *  1. prepack must write zero-config-default.json world-READABLE (0644).
 *     0600 + `sudo npm i -g` made the file root-only; every non-root run
 *     silently lost the built-in gateway on Linux/macOS.
 *  2. An unreadable bundled file must WARN (EACCES), not vanish silently.
 *  3. When user env shadows the bundled gateway, resolveCliConfig must say
 *     which setting did (bundledDefaultSuppressedBy).
 *  4. Old Node must fail fast with one actionable line (nodeVersionProblem).
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-zero-config-install.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveCliConfig } from '../dist/cli/config.js';
import { nodeVersionProblem } from '../dist/cli/node-version-check.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

// ── 1. prepack writes a world-readable bundled file ───────────────
if (process.platform !== 'win32') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-zero-config-pack-'));
  execFileSync(process.execPath, [path.join(pkgRoot, 'scripts', 'prepare-zero-config-default.mjs'), '--package-dir', tmp], {
    env: {
      ...process.env,
      DMOSS_ZERO_CONFIG_PROVIDER: 'openai-compatible',
      DMOSS_ZERO_CONFIG_MODEL: 'Moss',
      DMOSS_ZERO_CONFIG_BASE_URL: 'https://gateway.test/v1',
      DMOSS_ZERO_CONFIG_API_KEY: 'public-token',
    },
    stdio: 'pipe',
  });
  const mode = fs.statSync(path.join(tmp, 'zero-config-default.json')).mode & 0o777;
  assert.equal(mode, 0o644, `bundled gateway file must be 0644 (world-readable), got ${mode.toString(8)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('  [PASS] prepack writes zero-config-default.json as 0644');
} else {
  console.log('  [SKIP] file-mode check not applicable on Windows');
}

// ── 2. EACCES on the bundled file warns instead of silently vanishing ──
if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-zero-config-eacces-'));
  const file = path.join(tmp, 'zero-config-default.json');
  fs.writeFileSync(file, JSON.stringify({ provider: 'openai-compatible', model: 'M', baseUrl: 'https://g.test/v1', apiKey: 'k' }));
  fs.chmodSync(file, 0o000);
  // Some sandboxed/overlay filesystems do not enforce mode bits even for
  // non-root users; probe first so the EACCES branch is only asserted where
  // chmod 000 actually blocks reads.
  let modeBitsEnforced = true;
  try {
    fs.readFileSync(file);
    modeBitsEnforced = false;
  } catch {
    // expected on a POSIX fs that enforces permissions
  }
  if (modeBitsEnforced) {
    const warnings = [];
    const original = console.error;
    console.error = (...args) => warnings.push(args.join(' '));
    let resolved;
    try {
      resolved = resolveCliConfig({ DMOSS_BUNDLED_DEFAULT_FILE: file }, {});
    } finally {
      console.error = original;
    }
    assert.equal(resolved.usingBundledDefault, false, 'unreadable file cannot activate the bundled default');
    assert.ok(
      warnings.some((w) => /not readable \(EACCES\)/.test(w) && /chmod 644/.test(w)),
      `EACCES must produce an actionable warning, got: ${JSON.stringify(warnings)}`,
    );
    console.log('  [PASS] unreadable bundled file warns with a fix command');
  } else {
    console.log('  [SKIP] EACCES check needs a filesystem that enforces mode bits');
  }
  fs.chmodSync(file, 0o644);
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  console.log('  [SKIP] EACCES check needs a non-root POSIX user');
}

// ── 3. config shadowing is named; env vars never shadow ───────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-zero-config-shadow-'));
  const file = path.join(tmp, 'zero-config-default.json');
  fs.writeFileSync(file, JSON.stringify({ provider: 'openai-compatible', model: 'M', baseUrl: 'https://g.test/v1', apiKey: 'k' }));
  // A half-filled config file (baseUrl, no key) shadows — and says so.
  const resolved = resolveCliConfig({ DMOSS_BUNDLED_DEFAULT_FILE: file }, { baseUrl: 'https://corp.llm/v1' });
  assert.equal(resolved.usingBundledDefault, false);
  assert.equal(resolved.bundledDefaultSuppressedBy, 'moss config file', 'must name the shadowing source');
  // A leftover env var must NOT shadow (it used to look like a broken fresh install).
  const envLeftover = resolveCliConfig({ DMOSS_BUNDLED_DEFAULT_FILE: file, OPENAI_BASE_URL: 'https://corp.llm/v1' }, {});
  assert.equal(envLeftover.usingBundledDefault, true, 'env vars must not shadow the bundled default');
  assert.deepEqual(envLeftover.ignoredModelEnvVars, ['OPENAI_BASE_URL']);
  const active = resolveCliConfig({ DMOSS_BUNDLED_DEFAULT_FILE: file }, {});
  assert.equal(active.usingBundledDefault, true, 'without user config the bundled default applies');
  assert.equal(active.bundledDefaultSuppressedBy, undefined);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('  [PASS] config shadowing is named; env vars never shadow');
}

// ── 4. old Node fails fast with one clear line ────────────────────
{
  assert.match(String(nodeVersionProblem('v22.15.1')), /Node >= 22\.16/, 'Node 22 before the required minor must fail');
  assert.equal(nodeVersionProblem('v22.16.0'), null);
  assert.equal(nodeVersionProblem('v23.1.0'), null);
  const msg = nodeVersionProblem('v20.11.1');
  assert.ok(msg && /Node >= 22\.16/.test(msg) && /20\.11\.1/.test(msg), `must name required and current versions: ${msg}`);
  assert.match(String(nodeVersionProblem('v18.19.0')), /EBADENGINE/, 'should connect the dots to the npm install warnings');
  console.log('  [PASS] node version gate messages are actionable');
}

console.log('[PASS] zero-config install regressions');
