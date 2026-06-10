#!/usr/bin/env node
/**
 * Zero-config bundled gateway default — shipped only in the npm tarball
 * (gitignored in source), used as a fallback when nothing is configured.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-bundled-default.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCliConfig } from '../dist/cli/config.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-bundled-'));
const gatewayFile = path.join(tmp, 'zero-config-default.json');
fs.writeFileSync(
  gatewayFile,
  JSON.stringify({
    provider: 'openai-compatible',
    model: 'GatewayModel',
    baseUrl: 'https://gateway.test/v1',
    apiKey: 'gw-token-test',
  }),
);

// 1) No user config and no model env → the bundled gateway default applies.
{
  const r = resolveCliConfig({ DMOSS_BUNDLED_DEFAULT_FILE: gatewayFile }, {});
  assert.equal(r.provider, 'openai-compatible');
  assert.equal(r.providerSource, 'built-in');
  assert.equal(r.model, 'GatewayModel');
  assert.equal(r.modelSource, 'built-in');
  assert.equal(r.baseUrl, 'https://gateway.test/v1');
  assert.equal(r.baseUrlSource, 'built-in');
  assert.equal(r.apiKey, 'gw-token-test');
  assert.equal(r.apiKeySource, 'built-in');
  assert.equal(r.usingBundledDefault, true);
  console.log('  [PASS] bundled gateway default applies when nothing is configured');
}

// 2) A user-configured key wins → the bundled default must NOT be applied.
//    (Config file only: model env vars are ignored by design.)
{
  const r = resolveCliConfig({ DMOSS_BUNDLED_DEFAULT_FILE: gatewayFile }, { apiKey: 'user-key' });
  assert.equal(r.apiKey, 'user-key');
  assert.notEqual(r.baseUrl, 'https://gateway.test/v1');
  assert.equal(r.bundledDefaultSuppressedBy, 'moss config file');
  console.log('  [PASS] user config overrides the bundled default');
}

// 2b) A leftover env key must NOT shadow the bundled default (it used to
//     silently disable the built-in gateway and demand a manual setup).
{
  const r = resolveCliConfig({ DMOSS_BUNDLED_DEFAULT_FILE: gatewayFile, DMOSS_API_KEY: 'env-key' }, {});
  assert.equal(r.usingBundledDefault, true);
  assert.equal(r.apiKey, 'gw-token-test');
  assert.deepEqual(r.ignoredModelEnvVars, ['DMOSS_API_KEY']);
  console.log('  [PASS] env keys neither shadow the bundled default nor become the key');
}

// 3) DMOSS_NO_BUNDLED_DEFAULT=1 disables the bundled default.
{
  const r = resolveCliConfig({ DMOSS_BUNDLED_DEFAULT_FILE: gatewayFile, DMOSS_NO_BUNDLED_DEFAULT: '1' }, {});
  assert.notEqual(r.model, 'GatewayModel');
  assert.notEqual(r.apiKey, 'gw-token-test');
  console.log('  [PASS] DMOSS_NO_BUNDLED_DEFAULT disables the bundled default');
}

// 4) A missing bundled file falls back gracefully (no throw, provider default).
{
  const r = resolveCliConfig({ DMOSS_BUNDLED_DEFAULT_FILE: path.join(tmp, 'absent.json') }, {});
  assert.ok(r.provider, 'still resolves a provider when the bundled file is absent');
  console.log('  [PASS] missing bundled file falls back gracefully');
}

// 5) Empty stored keys are treated as missing, not as configured.
{
  const r = resolveCliConfig({}, {
    provider: 'openai-compatible',
    model: 'UserModel',
    baseUrl: 'https://gateway.test/v1',
    apiKey: '',
  });
  assert.equal(r.apiKey, '');
  assert.equal(r.apiKeySource, 'missing');
  assert.equal(r.usingBundledDefault, false);
  console.log('  [PASS] empty stored API keys are reported as missing');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[PASS] CLI bundled zero-config default');
