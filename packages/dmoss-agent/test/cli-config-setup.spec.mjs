#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-config-setup.spec.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfigFile,
  resolveCliConfig,
  resolveConfigPath,
  saveConfigFile,
} from '../dist/cli/config.js';
import {
  renderAuthStatus,
  renderConfigUsage,
  runConfigSet,
} from '../dist/cli/setup.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-config-'));
const oldConfigDir = process.env.DMOSS_CONFIG_DIR;
const oldConfigFile = process.env.DMOSS_CONFIG_FILE;
const oldConfigPath = process.env.DMOSS_CONFIG_PATH;
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

  const usage = renderConfigUsage();
  assert.match(usage, /dmoss config show/);
  assert.match(usage, /dmoss config set profile autonomous/);
  assert.match(usage, /DMOSS_CONFIG_FILE/);
  assert.match(usage, /promptCacheDebug/);

  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
  for (const args of [['config'], ['config', 'show']]) {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        DMOSS_CONFIG_DIR: tmp,
        NO_COLOR: '1',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${args.join(' ')} should exit cleanly: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, /\[auth\]/);
    assert.match(result.stderr, /profile: balanced \(default\)/);
    assert.match(result.stderr, /config: /);
    assert.doesNotMatch(result.stderr, /stored-secret/);
  }

  const explicitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-explicit-config-'));
  const explicitConfigPath = path.join(explicitDir, 'named-config.json');
  const cliConfigPath = path.join(explicitDir, 'cli-config.json');
  const envIgnoredConfigPath = path.join(explicitDir, 'env-ignored-config.json');
  process.env.DMOSS_CONFIG_FILE = explicitConfigPath;
  try {
    assert.equal(resolveConfigPath(), explicitConfigPath);
    assert.equal(resolveConfigPath(undefined, {}, ['--config-file', cliConfigPath]), cliConfigPath);
    assert.equal(resolveConfigPath(undefined, { DMOSS_CONFIG_FILE: envIgnoredConfigPath }, ['--config-file', cliConfigPath]), cliConfigPath);
    saveConfigFile({
      profile: 'cautious',
      provider: 'openai',
      apiKey: 'file-secret',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com',
      approvalPolicy: 'prompt',
    });
    assert.equal(fs.existsSync(explicitConfigPath), true);
    assert.equal(loadConfigFile().profile, 'cautious');
    const explicitResolved = resolveCliConfig({ DMOSS_CONFIG_FILE: explicitConfigPath }, loadConfigFile());
    assert.equal(explicitResolved.configPath, explicitConfigPath);
    assert.equal(explicitResolved.profile, 'cautious');
    assert.equal(explicitResolved.profileSource, 'config');

    const result = spawnSync(process.execPath, [cliPath, 'config', 'show'], {
      env: {
        ...process.env,
        DMOSS_CONFIG_FILE: explicitConfigPath,
        NO_COLOR: '1',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `config show with explicit file should exit cleanly: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, /profile: cautious \(config\)/);
    assert.match(result.stderr, new RegExp(`config: ${explicitConfigPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(result.stderr, /file-secret/);

    const setResult = spawnSync(process.execPath, [
      cliPath,
      '--config-file',
      cliConfigPath,
      'config',
      'set',
      'profile',
      'autonomous',
    ], {
      env: {
        ...process.env,
        DMOSS_CONFIG_FILE: envIgnoredConfigPath,
        NO_COLOR: '1',
      },
      encoding: 'utf8',
    });
    assert.equal(setResult.status, 0, `config set with explicit file should exit cleanly: ${setResult.stderr || setResult.stdout}`);
    assert.equal(JSON.parse(fs.readFileSync(cliConfigPath, 'utf8')).profile, 'autonomous');
    assert.equal(fs.existsSync(envIgnoredConfigPath), false);

    const showResult = spawnSync(process.execPath, [cliPath, `--config-file=${cliConfigPath}`, 'config', 'show'], {
      env: {
        ...process.env,
        DMOSS_CONFIG_FILE: envIgnoredConfigPath,
        NO_COLOR: '1',
      },
      encoding: 'utf8',
    });
    assert.equal(showResult.status, 0, `config show with CLI file should exit cleanly: ${showResult.stderr || showResult.stdout}`);
    assert.match(showResult.stderr, /profile: autonomous \(config\)/);
    assert.match(showResult.stderr, new RegExp(`config: ${cliConfigPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    if (oldConfigFile === undefined) delete process.env.DMOSS_CONFIG_FILE;
    else process.env.DMOSS_CONFIG_FILE = oldConfigFile;
    fs.rmSync(explicitDir, { recursive: true, force: true });
  }

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
  if (oldConfigFile === undefined) delete process.env.DMOSS_CONFIG_FILE;
  else process.env.DMOSS_CONFIG_FILE = oldConfigFile;
  if (oldConfigPath === undefined) delete process.env.DMOSS_CONFIG_PATH;
  else process.env.DMOSS_CONFIG_PATH = oldConfigPath;
  fs.rmSync(tmp, { recursive: true, force: true });
}
