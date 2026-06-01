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
  assert.equal(resolved.profile, 'balanced');
  assert.equal(resolved.profileSource, 'default');
  assert.equal(resolved.model, 'qwen3.7-max');
  assert.equal(resolved.apiKey, 'stored-secret');
  assert.equal(resolved.apiKeySource, 'config');
  assert.equal(resolved.safetyMode, 'workspace-write');
  assert.equal(resolved.safetyModeSource, 'profile:balanced');
  assert.equal(resolved.approvalPolicy, 'prompt');
  assert.deepEqual(resolved.trustedTools, []);
  assert.equal(resolved.trustedToolsSource, 'profile:balanced');
  assert.equal(resolved.promptCacheEnabled, true);
  assert.equal(resolved.promptCacheDebug, false);

  const envResolved = resolveCliConfig({
    DMOSS_PROFILE: 'autonomous',
    DMOSS_PROVIDER: 'openai',
    OPENAI_API_KEY: 'env-secret',
    DMOSS_MODEL: 'gpt-4o-mini',
    DMOSS_BASE_URL: 'https://api.openai.com',
    DMOSS_SAFETY_MODE: 'read-only',
    DMOSS_APPROVAL_POLICY: 'never',
    DMOSS_TRUSTED_TOOLS: 'exec,write_file',
    DMOSS_PROMPT_CACHE: 'false',
    DMOSS_PROMPT_CACHE_DEBUG: 'true',
  }, loadConfigFile());
  assert.equal(envResolved.provider, 'openai');
  assert.equal(envResolved.profile, 'autonomous');
  assert.equal(envResolved.profileSource, 'DMOSS_PROFILE');
  assert.equal(envResolved.apiKey, 'env-secret');
  assert.equal(envResolved.apiKeySource, 'OPENAI_API_KEY');
  assert.equal(envResolved.modelSource, 'DMOSS_MODEL');
  assert.equal(envResolved.safetyMode, 'read-only');
  assert.equal(envResolved.safetyModeSource, 'DMOSS_SAFETY_MODE');
  assert.equal(envResolved.approvalPolicy, 'never');
  assert.equal(envResolved.approvalPolicySource, 'DMOSS_APPROVAL_POLICY');
  assert.deepEqual(envResolved.trustedTools, ['exec', 'write_file']);
  assert.equal(envResolved.trustedToolsSource, 'DMOSS_TRUSTED_TOOLS');
  assert.equal(envResolved.promptCacheEnabled, false);
  assert.equal(envResolved.promptCacheSource, 'DMOSS_PROMPT_CACHE');
  assert.equal(envResolved.promptCacheDebug, true);
  assert.equal(envResolved.promptCacheDebugSource, 'DMOSS_PROMPT_CACHE_DEBUG');

  const cliResolved = resolveCliConfig({
    DMOSS_MODEL: 'gpt-4o-mini',
    DMOSS_BASE_URL: 'https://api.openai.com',
  }, loadConfigFile(), {
    profile: 'cautious',
    model: 'deepseek-v4-pro',
    baseUrl: 'https://api.deepseek.com',
    workspace: '/tmp/dmoss-workspace',
    safetyMode: 'full-access',
    approvalPolicy: 'never',
    trustedTools: ['exec', 'memory_write'],
    promptCacheEnabled: false,
    promptCacheDebug: true,
  });
  assert.equal(cliResolved.profile, 'cautious');
  assert.equal(cliResolved.profileSource, 'cli');
  assert.equal(cliResolved.model, 'deepseek-v4-pro');
  assert.equal(cliResolved.modelSource, 'cli');
  assert.equal(cliResolved.baseUrl, 'https://api.deepseek.com');
  assert.equal(cliResolved.baseUrlSource, 'cli');
  assert.equal(cliResolved.workspaceSource, 'cli');
  assert.equal(cliResolved.safetyMode, 'full-access');
  assert.equal(cliResolved.safetyModeSource, 'cli');
  assert.equal(cliResolved.approvalPolicy, 'never');
  assert.equal(cliResolved.approvalPolicySource, 'cli');
  assert.deepEqual(cliResolved.trustedTools, ['exec', 'memory_write']);
  assert.equal(cliResolved.trustedToolsSource, 'cli');
  assert.equal(cliResolved.promptCacheEnabled, false);
  assert.equal(cliResolved.promptCacheSource, 'cli');
  assert.equal(cliResolved.promptCacheDebug, true);
  assert.equal(cliResolved.promptCacheDebugSource, 'cli');

  const status = renderAuthStatus(loadConfigFile(), {});
  assert.match(status, /apiKey: configured via config/);
  assert.match(status, /profile: balanced \(default\)/);
  assert.match(status, /baseUrl: https:\/\/token-plan\.cn-beijing\.maas\.aliyuncs\.com\/compatible-mode/);
  assert.match(status, /safetyMode: workspace-write/);
  assert.match(status, /approvalPolicy: prompt/);
  assert.match(status, /trustedTools: none/);
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
    profile: 'autonomous',
    safetyMode: 'read-only',
    approvalPolicy: 'never',
    trustedTools: ['exec'],
    promptCache: { enabled: false, debug: true },
  }, tmp);
  const filePolicyResolved = resolveCliConfig({}, loadConfigFile());
  assert.equal(filePolicyResolved.profile, 'autonomous');
  assert.equal(filePolicyResolved.profileSource, 'config');
  assert.equal(filePolicyResolved.safetyMode, 'read-only');
  assert.equal(filePolicyResolved.safetyModeSource, 'config');
  assert.equal(filePolicyResolved.approvalPolicy, 'never');
  assert.equal(filePolicyResolved.approvalPolicySource, 'config');
  assert.deepEqual(filePolicyResolved.trustedTools, ['exec']);
  assert.equal(filePolicyResolved.trustedToolsSource, 'config');
  assert.equal(filePolicyResolved.promptCacheEnabled, false);
  assert.equal(filePolicyResolved.promptCacheSource, 'config');
  assert.equal(filePolicyResolved.promptCacheDebug, true);
  assert.equal(filePolicyResolved.promptCacheDebugSource, 'config');

  const autonomousResolved = resolveCliConfig({}, {
    profile: 'autonomous',
    provider: 'qwen',
    apiKey: 'stored-secret',
  });
  assert.equal(autonomousResolved.safetyMode, 'workspace-write');
  assert.equal(autonomousResolved.safetyModeSource, 'profile:autonomous');
  assert.equal(autonomousResolved.approvalPolicy, 'never');
  assert.equal(autonomousResolved.approvalPolicySource, 'profile:autonomous');
  assert.deepEqual(autonomousResolved.trustedTools, ['exec', 'apply_patch']);
  assert.equal(autonomousResolved.trustedToolsSource, 'profile:autonomous');
  autonomousResolved.trustedTools.push('write_file');
  assert.deepEqual(resolveCliConfig({}, {
    profile: 'autonomous',
    provider: 'qwen',
    apiKey: 'stored-secret',
  }).trustedTools, ['exec', 'apply_patch']);

  const autonomousOverrideResolved = resolveCliConfig({}, {
    profile: 'autonomous',
    provider: 'qwen',
    apiKey: 'stored-secret',
    approvalPolicy: 'prompt',
    trustedTools: ['write_file'],
    promptCache: { enabled: false },
  });
  assert.equal(autonomousOverrideResolved.approvalPolicy, 'prompt');
  assert.equal(autonomousOverrideResolved.approvalPolicySource, 'config');
  assert.deepEqual(autonomousOverrideResolved.trustedTools, ['write_file']);
  assert.equal(autonomousOverrideResolved.trustedToolsSource, 'config');
  assert.equal(autonomousOverrideResolved.promptCacheEnabled, false);
  assert.equal(autonomousOverrideResolved.promptCacheSource, 'config');

  assert.throws(
    () => resolveCliConfig({}, { profile: 'reckless' }),
    /Unsupported config profile "reckless"/,
  );

  runConfigSet(['profile', 'autonomous']);
  assert.equal(loadConfigFile().profile, 'autonomous');
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
  runConfigSet(['trustedTools', 'exec,write_file']);
  assert.deepEqual(loadConfigFile().trustedTools, ['exec', 'write_file']);
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
