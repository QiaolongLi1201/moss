#!/usr/bin/env node
/**
 * Zero-config package preparation tests.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/zero-config-pack.spec.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const prepareScript = path.join(packageDir, 'scripts/prepare-zero-config-default.mjs');
const cleanupScript = path.join(packageDir, 'scripts/cleanup-zero-config-default.mjs');
const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));

assert.match(pkg.scripts?.prepack ?? '', /prepare-zero-config-default/);
assert.match(pkg.scripts?.postpack ?? '', /cleanup-zero-config-default/);
assert.equal(fs.existsSync(prepareScript), true, 'prepack prepare script should exist');
assert.equal(fs.existsSync(cleanupScript), true, 'postpack cleanup script should exist');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-zero-config-pack-'));
try {
  const zeroConfigPath = path.join(tmp, 'zero-config-default.json');
  const markerPath = path.join(tmp, '.zero-config-default.generated');
  const packConfig = {
    provider: 'openai-compatible',
    model: 'Moss',
    baseUrl: 'https://gateway.test/v1',
    apiKey: 'gateway-token-for-test',
  };

  const generated = spawnSync(process.execPath, [prepareScript, '--package-dir', tmp], {
    env: {
      ...process.env,
      DMOSS_ZERO_CONFIG_DEFAULT_JSON: JSON.stringify(packConfig),
    },
    encoding: 'utf8',
  });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  assert.equal(fs.existsSync(zeroConfigPath), true, 'prepare should create zero-config-default.json');
  assert.equal(fs.existsSync(markerPath), true, 'generated file should be marked for postpack cleanup');
  assert.deepEqual(JSON.parse(fs.readFileSync(zeroConfigPath, 'utf8')), packConfig);

  const cleaned = spawnSync(process.execPath, [cleanupScript, '--package-dir', tmp], {
    encoding: 'utf8',
  });
  assert.equal(cleaned.status, 0, cleaned.stderr || cleaned.stdout);
  assert.equal(fs.existsSync(zeroConfigPath), false, 'postpack cleanup should remove generated file');
  assert.equal(fs.existsSync(markerPath), false, 'postpack cleanup should remove marker');

  const missing = spawnSync(process.execPath, [prepareScript, '--package-dir', tmp], {
    env: {
      ...process.env,
      DMOSS_ZERO_CONFIG_DEFAULT_JSON: '',
      DMOSS_ZERO_CONFIG_PROVIDER: '',
      DMOSS_ZERO_CONFIG_MODEL: '',
      DMOSS_ZERO_CONFIG_BASE_URL: '',
      DMOSS_ZERO_CONFIG_API_KEY: '',
    },
    encoding: 'utf8',
  });
  assert.notEqual(missing.status, 0, 'prepare should fail when no package file or secret-backed config exists');
  assert.match(missing.stderr, /zero-config-default\.json|zero-config/i);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('[PASS] zero-config prepack scripts generate and clean package default');
