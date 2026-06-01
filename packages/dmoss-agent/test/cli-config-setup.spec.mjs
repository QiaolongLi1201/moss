#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-config-setup.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadConfigFile,
  resolveCliConfig,
  saveConfigFile,
} from '../dist/cli/config.js';
import {
  renderAuthStatus,
  runConfigSet,
} from '../dist/cli/setup.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-config-'));
const oldConfigDir = process.env.DMOSS_CONFIG_DIR;
process.env.DMOSS_CONFIG_DIR = tmp;

try {
  saveConfigFile({
    provider: 'qwen',
    apiKey: 'stored-secret',
    model: 'qwen3.7-max',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode',
  }, tmp);

  const stat = fs.statSync(path.join(tmp, 'config.json'));
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, 0o600);
  }

  const resolved = resolveCliConfig({}, loadConfigFile());
  assert.equal(resolved.provider, 'qwen');
  assert.equal(resolved.model, 'qwen3.7-max');
  assert.equal(resolved.apiKey, 'stored-secret');
  assert.equal(resolved.apiKeySource, 'config');

  const envResolved = resolveCliConfig({
    DMOSS_PROVIDER: 'openai',
    OPENAI_API_KEY: 'env-secret',
    DMOSS_MODEL: 'gpt-4o-mini',
    DMOSS_BASE_URL: 'https://api.openai.com',
  }, loadConfigFile());
  assert.equal(envResolved.provider, 'openai');
  assert.equal(envResolved.apiKey, 'env-secret');
  assert.equal(envResolved.apiKeySource, 'OPENAI_API_KEY');
  assert.equal(envResolved.modelSource, 'DMOSS_MODEL');

  const cliResolved = resolveCliConfig({
    DMOSS_MODEL: 'gpt-4o-mini',
    DMOSS_BASE_URL: 'https://api.openai.com',
  }, loadConfigFile(), {
    model: 'deepseek-v4-pro',
    baseUrl: 'https://api.deepseek.com',
    workspace: '/tmp/dmoss-workspace',
  });
  assert.equal(cliResolved.model, 'deepseek-v4-pro');
  assert.equal(cliResolved.modelSource, 'cli');
  assert.equal(cliResolved.baseUrl, 'https://api.deepseek.com');
  assert.equal(cliResolved.baseUrlSource, 'cli');
  assert.equal(cliResolved.workspaceSource, 'cli');

  const status = renderAuthStatus(loadConfigFile(), {});
  assert.match(status, /apiKey: configured via config/);
  assert.match(status, /baseUrl: https:\/\/token-plan\.cn-beijing\.maas\.aliyuncs\.com\/compatible-mode/);
  assert.doesNotMatch(status, /stored-secret/);

  const envStatus = renderAuthStatus(loadConfigFile(), { DASHSCOPE_API_KEY: 'env-secret' });
  assert.match(envStatus, /apiKey: configured via DASHSCOPE_API_KEY/);
  assert.doesNotMatch(envStatus, /env-secret/);

  const redactedStatus = renderAuthStatus({
    baseUrl: 'https://user:pass@example.com/compatible-mode/v1?api_key=secret',
    apiKey: 'stored-secret',
  }, {});
  assert.match(redactedStatus, /baseUrl: https:\/\/example\.com\/compatible-mode\/v1/);
  assert.doesNotMatch(redactedStatus, /user|pass|api_key|secret/);

  runConfigSet(['model', 'qwen-plus']);
  assert.equal(loadConfigFile().model, 'qwen-plus');
  runConfigSet(['baseUrl', 'https://example.com/v1/']);
  assert.equal(loadConfigFile().baseUrl, 'https://example.com');
  runConfigSet(['baseUrl', 'https://user:pass@example.com/compatible-mode/v1?api_key=secret#frag']);
  assert.equal(loadConfigFile().baseUrl, 'https://example.com/compatible-mode');

  console.log('[PASS] CLI setup config resolves safely');
} finally {
  if (oldConfigDir === undefined) delete process.env.DMOSS_CONFIG_DIR;
  else process.env.DMOSS_CONFIG_DIR = oldConfigDir;
  fs.rmSync(tmp, { recursive: true, force: true });
}
