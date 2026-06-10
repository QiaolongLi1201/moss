#!/usr/bin/env node
/**
 * Model configuration must come ONLY from CLI flags and moss config files —
 * never from environment variables.
 *
 * Why: generic provider keys (DEEPSEEK_API_KEY, OPENAI_API_KEY, ...) are a
 * shared namespace across tools. A user exporting one for another tool used
 * to silently flip moss onto that provider ("why is my moss using deepseek?").
 * Decision 2026-06: provider/model/baseUrl/apiKey resolve from CLI flags >
 * project config > user config > built-in default. Set-but-ignored model env
 * vars are reported via `ignoredModelEnvVars` so doctor/startup can explain.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-model-env-isolation.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCliConfig } from '../dist/cli/config.js';

// Local checkouts may carry a generated zero-config-default.json (gitignored);
// disable it so these tests are hermetic. Test 5 re-enables it explicitly.
const NO_BUNDLED = { DMOSS_NO_BUNDLED_DEFAULT: '1' };

// 1) Generic provider keys must not select the provider.
{
  const r = resolveCliConfig({ ...NO_BUNDLED, OPENAI_API_KEY: 'leftover-from-another-tool' }, {});
  assert.equal(r.provider, 'deepseek', 'provider must stay at the built-in default');
  assert.equal(r.providerSource, 'default', `provider must not be inferred from env (got source: ${r.providerSource})`);
  console.log('  [PASS] generic provider keys do not select the provider');
}

// 2) Generic provider keys must not be used as the API key.
{
  const r = resolveCliConfig({ ...NO_BUNDLED, DEEPSEEK_API_KEY: 'env-secret' }, {});
  assert.equal(r.apiKey, '', 'apiKey must not be read from env');
  assert.equal(r.apiKeySource, 'missing');
  console.log('  [PASS] generic provider keys are not used as the API key');
}

// 3) DMOSS_* model vars are ignored too: config file wins, sources say config.
{
  const r = resolveCliConfig({
    ...NO_BUNDLED,
    DMOSS_PROVIDER: 'openai',
    DMOSS_MODEL: 'env-model',
    DMOSS_BASE_URL: 'https://env.example.com',
    DMOSS_API_KEY: 'env-key',
  }, {
    provider: 'qwen',
    model: 'config-model',
    baseUrl: 'https://config.example.com',
    apiKey: 'config-key',
  });
  assert.equal(r.provider, 'qwen');
  assert.equal(r.providerSource, 'config');
  assert.equal(r.model, 'config-model');
  assert.equal(r.modelSource, 'config');
  assert.equal(r.baseUrl, 'https://config.example.com');
  assert.equal(r.baseUrlSource, 'config');
  assert.equal(r.apiKey, 'config-key');
  assert.equal(r.apiKeySource, 'config');
  console.log('  [PASS] DMOSS_* model vars never override the config file');
}

// 4) DMOSS_* model vars alone must not configure anything (no silent env-only setup).
{
  const r = resolveCliConfig({
    ...NO_BUNDLED,
    DMOSS_PROVIDER: 'openai',
    DMOSS_MODEL: 'env-model',
    DMOSS_BASE_URL: 'https://env.example.com',
    DMOSS_API_KEY: 'env-key',
  }, {});
  assert.equal(r.provider, 'deepseek');
  assert.equal(r.providerSource, 'default');
  assert.equal(r.apiKey, '');
  assert.equal(r.apiKeySource, 'missing');
  assert.notEqual(r.model, 'env-model');
  assert.notEqual(r.baseUrl, 'https://env.example.com');
  console.log('  [PASS] env-only model setup is not honored');
}

// 5) Model env vars must not suppress the bundled zero-config default.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-env-isolation-'));
  const gatewayFile = path.join(tmp, 'zero-config-default.json');
  fs.writeFileSync(gatewayFile, JSON.stringify({
    provider: 'openai-compatible',
    model: 'GatewayModel',
    baseUrl: 'https://gateway.test/v1',
    apiKey: 'gw-token-test',
  }));
  const r = resolveCliConfig({
    DMOSS_BUNDLED_DEFAULT_FILE: gatewayFile,
    OPENAI_BASE_URL: 'https://leftover.example.com',
    OPENAI_API_KEY: 'leftover-key',
  }, {});
  assert.equal(r.usingBundledDefault, true, 'leftover env vars must not shadow the built-in gateway');
  assert.equal(r.model, 'GatewayModel');
  assert.equal(r.apiKey, 'gw-token-test');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('  [PASS] leftover model env vars do not suppress the bundled default');
}

// 6) Set-but-ignored model env vars are reported for doctor/startup messaging.
{
  const r = resolveCliConfig({
    ...NO_BUNDLED,
    DEEPSEEK_API_KEY: 'x',
    DMOSS_MODEL: 'y',
    OPENAI_BASE_URL: 'z',
  }, {});
  assert.deepEqual(
    [...r.ignoredModelEnvVars].sort(),
    ['DEEPSEEK_API_KEY', 'DMOSS_MODEL', 'OPENAI_BASE_URL'],
  );
  const clean = resolveCliConfig({ ...NO_BUNDLED }, {});
  assert.deepEqual(clean.ignoredModelEnvVars, []);
  console.log('  [PASS] ignored model env vars are reported');
}

// 7) CLI overrides still win over the config file.
{
  const r = resolveCliConfig({ ...NO_BUNDLED }, { provider: 'qwen', model: 'config-model', apiKey: 'config-key' }, {
    provider: 'anthropic',
    model: 'cli-model',
    baseUrl: 'https://cli.example.com',
  });
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.providerSource, 'cli');
  assert.equal(r.model, 'cli-model');
  assert.equal(r.modelSource, 'cli');
  assert.equal(r.baseUrl, 'https://cli.example.com');
  assert.equal(r.baseUrlSource, 'cli');
  console.log('  [PASS] CLI overrides still take precedence over config');
}

console.log('cli-model-env-isolation: all checks passed');
