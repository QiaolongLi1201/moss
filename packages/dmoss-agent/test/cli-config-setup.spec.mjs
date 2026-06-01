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
  assert.equal(resolved.safetyMode, 'workspace-write');
  assert.equal(resolved.safetyModeSource, 'default');
  assert.equal(resolved.approvalPolicy, 'prompt');
  assert.equal(resolved.promptCacheEnabled, true);
  assert.equal(resolved.promptCacheDebug, false);

  const envResolved = resolveCliConfig({
    DMOSS_PROVIDER: 'openai',
    OPENAI_API_KEY: 'env-secret',
    DMOSS_MODEL: 'gpt-4o-mini',
    DMOSS_BASE_URL: 'https://api.openai.com',
    DMOSS_SAFETY_MODE: 'read-only',
    DMOSS_APPROVAL_POLICY: 'never',
    DMOSS_PROMPT_CACHE: 'false',
    DMOSS_PROMPT_CACHE_DEBUG: 'true',
  }, loadConfigFile());
  assert.equal(envResolved.provider, 'openai');
  assert.equal(envResolved.apiKey, 'env-secret');
  assert.equal(envResolved.apiKeySource, 'OPENAI_API_KEY');
  assert.equal(envResolved.modelSource, 'DMOSS_MODEL');
  assert.equal(envResolved.safetyMode, 'read-only');
  assert.equal(envResolved.safetyModeSource, 'DMOSS_SAFETY_MODE');
  assert.equal(envResolved.approvalPolicy, 'never');
  assert.equal(envResolved.approvalPolicySource, 'DMOSS_APPROVAL_POLICY');
  assert.equal(envResolved.promptCacheEnabled, false);
  assert.equal(envResolved.promptCacheSource, 'DMOSS_PROMPT_CACHE');
  assert.equal(envResolved.promptCacheDebug, true);
  assert.equal(envResolved.promptCacheDebugSource, 'DMOSS_PROMPT_CACHE_DEBUG');

  const cliResolved = resolveCliConfig({
    DMOSS_MODEL: 'gpt-4o-mini',
    DMOSS_BASE_URL: 'https://api.openai.com',
  }, loadConfigFile(), {
    model: 'deepseek-v4-pro',
    baseUrl: 'https://api.deepseek.com',
    workspace: '/tmp/dmoss-workspace',
    safetyMode: 'full-access',
    approvalPolicy: 'never',
    promptCacheEnabled: false,
    promptCacheDebug: true,
  });
  assert.equal(cliResolved.model, 'deepseek-v4-pro');
  assert.equal(cliResolved.modelSource, 'cli');
  assert.equal(cliResolved.baseUrl, 'https://api.deepseek.com');
  assert.equal(cliResolved.baseUrlSource, 'cli');
  assert.equal(cliResolved.workspaceSource, 'cli');
  assert.equal(cliResolved.safetyMode, 'full-access');
  assert.equal(cliResolved.safetyModeSource, 'cli');
  assert.equal(cliResolved.approvalPolicy, 'never');
  assert.equal(cliResolved.approvalPolicySource, 'cli');
  assert.equal(cliResolved.promptCacheEnabled, false);
  assert.equal(cliResolved.promptCacheSource, 'cli');
  assert.equal(cliResolved.promptCacheDebug, true);
  assert.equal(cliResolved.promptCacheDebugSource, 'cli');

  const status = renderAuthStatus(loadConfigFile(), {});
  assert.match(status, /apiKey: configured via config/);
  assert.match(status, /baseUrl: https:\/\/token-plan\.cn-beijing\.maas\.aliyuncs\.com\/compatible-mode/);
  assert.match(status, /safetyMode: workspace-write/);
  assert.match(status, /approvalPolicy: prompt/);
  assert.match(status, /promptCache: enabled/);
  assert.match(status, /promptCacheDebug: disabled/);
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

  saveConfigFile({
    ...loadConfigFile(),
    safetyMode: 'read-only',
    approvalPolicy: 'never',
    promptCache: { enabled: false, debug: true },
  }, tmp);
  const filePolicyResolved = resolveCliConfig({}, loadConfigFile());
  assert.equal(filePolicyResolved.safetyMode, 'read-only');
  assert.equal(filePolicyResolved.safetyModeSource, 'config');
  assert.equal(filePolicyResolved.approvalPolicy, 'never');
  assert.equal(filePolicyResolved.approvalPolicySource, 'config');
  assert.equal(filePolicyResolved.promptCacheEnabled, false);
  assert.equal(filePolicyResolved.promptCacheSource, 'config');
  assert.equal(filePolicyResolved.promptCacheDebug, true);
  assert.equal(filePolicyResolved.promptCacheDebugSource, 'config');

  runConfigSet(['model', 'qwen-plus']);
  assert.equal(loadConfigFile().model, 'qwen-plus');
  runConfigSet(['baseUrl', 'https://example.com/v1/']);
  assert.equal(loadConfigFile().baseUrl, 'https://example.com');
  runConfigSet(['baseUrl', 'https://user:pass@example.com/compatible-mode/v1?api_key=secret#frag']);
  assert.equal(loadConfigFile().baseUrl, 'https://example.com/compatible-mode');
  runConfigSet(['safetyMode', 'read-only']);
  assert.equal(loadConfigFile().safetyMode, 'read-only');
  runConfigSet(['approvalPolicy', 'never']);
  assert.equal(loadConfigFile().approvalPolicy, 'never');
  runConfigSet(['promptCache', 'false']);
  assert.deepEqual(loadConfigFile().promptCache, { enabled: false, debug: true });
  runConfigSet(['promptCacheDebug', 'true']);
  assert.deepEqual(loadConfigFile().promptCache, { enabled: false, debug: true });

  console.log('[PASS] CLI setup config resolves safely');
} finally {
  if (oldConfigDir === undefined) delete process.env.DMOSS_CONFIG_DIR;
  else process.env.DMOSS_CONFIG_DIR = oldConfigDir;
  fs.rmSync(tmp, { recursive: true, force: true });
}
