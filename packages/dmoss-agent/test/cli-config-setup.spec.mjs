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
  CliConfigFileError,
  auditResolvedCliConfig,
  loadCliConfigFile,
  loadConfigFile,
  resolveCliConfig,
  resolveConfigPath,
  resolveProjectConfigPath,
  saveConfigFile,
} from '../dist/cli/config.js';
import { resolveCliAgentRuntimeOptions } from '../dist/cli/agent-runtime.js';
import { auditResolvedCliConfig as auditResolvedCliConfigFromRoot } from '../dist/index.js';
import {
  renderAuthStatus,
  renderConfigJson,
  renderConfigUsage,
  runConfigInit,
  runConfigSet,
  runConfigUnset,
  runConfigValidate,
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
  assert.deepEqual(resolved.deniedTools, []);
  assert.equal(resolved.deniedToolsSource, 'default');
  assert.equal(resolved.promptCacheEnabled, true);
  assert.equal(resolved.promptCacheDebug, false);
  assert.deepEqual(resolved.guardrails, {
    input: { blockPatterns: [], redactPatterns: [] },
    output: { blockPatterns: [], redactPatterns: [] },
  });
  assert.equal(resolved.guardrailsSource, 'default');
  assert.equal(resolved.maxAgentTurns, 64);
  assert.equal(resolved.maxAgentTurnsSource, 'default');
  assert.equal(resolved.contextTokens, 200000);
  assert.equal(resolved.contextTokensSource, 'default');
  assert.deepEqual(resolved.compactionSettings, { reserveTokens: 20000, keepRecentTokens: 20000 });
  assert.equal(resolved.compactionSettingsSource, 'default');

  const envResolved = resolveCliConfig({
    DMOSS_PROFILE: 'autonomous',
    DMOSS_PROVIDER: 'openai',
    OPENAI_API_KEY: 'env-secret',
    DMOSS_MODEL: 'gpt-4o-mini',
    DMOSS_BASE_URL: 'https://api.openai.com',
    DMOSS_SAFETY_MODE: 'read-only',
    DMOSS_APPROVAL_POLICY: 'never',
    DMOSS_TRUSTED_TOOLS: 'exec,filesystem__*',
    DMOSS_DENIED_TOOLS: 'device_*',
    DMOSS_PROMPT_CACHE: 'false',
    DMOSS_PROMPT_CACHE_DEBUG: 'true',
    DMOSS_MCP_ENABLED: 'true',
    DMOSS_MCP_CONFIG: '/tmp/dmoss-mcp-env.json',
    DMOSS_MAX_AGENT_TURNS: '12',
    DMOSS_CONTEXT_TOKENS: '64000',
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
  assert.deepEqual(envResolved.trustedTools, ['exec', 'filesystem__*']);
  assert.equal(envResolved.trustedToolsSource, 'DMOSS_TRUSTED_TOOLS');
  assert.deepEqual(envResolved.deniedTools, ['device_*']);
  assert.equal(envResolved.deniedToolsSource, 'DMOSS_DENIED_TOOLS');
  assert.equal(envResolved.promptCacheEnabled, false);
  assert.equal(envResolved.promptCacheSource, 'DMOSS_PROMPT_CACHE');
  assert.equal(envResolved.promptCacheDebug, true);
  assert.equal(envResolved.promptCacheDebugSource, 'DMOSS_PROMPT_CACHE_DEBUG');
  assert.equal(envResolved.mcpEnabled, true);
  assert.equal(envResolved.mcpEnabledSource, 'DMOSS_MCP_ENABLED');
  assert.equal(envResolved.mcpConfigPath, '/tmp/dmoss-mcp-env.json');
  assert.equal(envResolved.mcpConfigPathSource, 'DMOSS_MCP_CONFIG');
  assert.equal(envResolved.maxAgentTurns, 12);
  assert.equal(envResolved.maxAgentTurnsSource, 'DMOSS_MAX_AGENT_TURNS');
  assert.equal(envResolved.contextTokens, 64000);
  assert.equal(envResolved.contextTokensSource, 'DMOSS_CONTEXT_TOKENS');

  const invalidEnvResolved = resolveCliConfig({
    DMOSS_MAX_AGENT_TURNS: '1.5',
    DMOSS_CONTEXT_TOKENS: '64000x',
  }, loadConfigFile());
  assert.equal(invalidEnvResolved.maxAgentTurns, 64);
  assert.equal(invalidEnvResolved.maxAgentTurnsSource, 'default');
  assert.equal(invalidEnvResolved.contextTokens, 200000);
  assert.equal(invalidEnvResolved.contextTokensSource, 'default');

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
    trustedTools: ['exec', 'filesystem__*'],
    deniedTools: ['device_*'],
    promptCacheEnabled: false,
    promptCacheDebug: true,
    maxAgentTurns: 9,
    contextTokens: 32000,
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
  assert.deepEqual(cliResolved.trustedTools, ['exec', 'filesystem__*']);
  assert.equal(cliResolved.trustedToolsSource, 'cli');
  assert.deepEqual(cliResolved.deniedTools, ['device_*']);
  assert.equal(cliResolved.deniedToolsSource, 'cli');
  assert.equal(cliResolved.promptCacheEnabled, false);
  assert.equal(cliResolved.promptCacheSource, 'cli');
  assert.equal(cliResolved.promptCacheDebug, true);
  assert.equal(cliResolved.promptCacheDebugSource, 'cli');
  assert.equal(cliResolved.maxAgentTurns, 9);
  assert.equal(cliResolved.maxAgentTurnsSource, 'cli');
  assert.equal(cliResolved.contextTokens, 32000);
  assert.equal(cliResolved.contextTokensSource, 'cli');

  const status = renderAuthStatus(loadConfigFile(), {});
  assert.match(status, /apiKey: configured via config/);
  assert.match(status, /profile: balanced \(default\)/);
  assert.match(status, /baseUrl: https:\/\/token-plan\.cn-beijing\.maas\.aliyuncs\.com\/compatible-mode/);
  assert.match(status, /safetyMode: workspace-write/);
  assert.match(status, /approvalPolicy: prompt/);
  assert.match(status, /trustedTools: none/);
  assert.match(status, /deniedTools: none/);
  assert.match(status, /promptCache: enabled/);
  assert.match(status, /promptCacheDebug: disabled/);
  assert.match(status, /mcp: disabled \(default\)/);
  assert.match(status, /mcpConfig: .*mcp\.json \(default\)/);
  assert.match(status, /guardrails: none \(default\)/);
  assert.match(status, /maxAgentTurns: 64 \(default\)/);
  assert.match(status, /contextTokens: 200000 \(default\)/);
  assert.match(status, /compaction: reserve 20000, keepRecent 20000 \(default\)/);
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

  const redactedJson = JSON.parse(renderConfigJson({
    provider: 'openai-compatible',
    baseUrl: 'https://user:pass@example.com/compatible-mode/v1?api_key=secret',
    apiKey: 'stored-secret',
    trustedTools: ['exec'],
    deniedTools: ['device_exec'],
    agent: { maxTurns: 42 },
  }, {}));
  assert.equal(redactedJson.schema, 'dmoss_cli_config.v1');
  assert.equal(redactedJson.apiKeyConfigured, true);
  assert.equal(redactedJson.apiKeySource, 'config');
  assert.equal(Object.hasOwn(redactedJson, 'apiKey'), false);
  assert.equal(redactedJson.baseUrl, 'https://example.com/compatible-mode/v1');
  assert.equal(redactedJson.maxAgentTurns, 42);
  assert.deepEqual(redactedJson.trustedTools, ['exec']);
  assert.deepEqual(redactedJson.deniedTools, ['device_exec']);
  assert.deepEqual(redactedJson.configWarnings, []);
  assert.doesNotMatch(JSON.stringify(redactedJson), /stored-secret|user|pass|api_key|secret/);

  const riskyConfigJson = JSON.parse(renderConfigJson({
    provider: 'openai-compatible',
    apiKey: 'stored-secret',
    safetyMode: 'full-access',
    approvalPolicy: 'never',
    trustedTools: ['device_*', 'filesystem__*'],
  }, {}));
  assert.deepEqual(
    riskyConfigJson.configWarnings.map((warning) => warning.code),
    ['approval.auto_approval', 'approval.no_denied_tools', 'approval.full_access_auto_approval', 'trustedTools.broad_patterns'],
  );
  assert.equal(riskyConfigJson.configWarnings[0].severity, 'warn');
  assert.match(JSON.stringify(riskyConfigJson.configWarnings), /device_\*/);
  assert.doesNotMatch(JSON.stringify(riskyConfigJson), /stored-secret/);

  const conflictingPolicyJson = JSON.parse(renderConfigJson({
    provider: 'openai-compatible',
    trustedTools: ['exec', 'read_file'],
    deniedTools: ['exec', 'device_exec'],
  }, {}));
  assert.deepEqual(
    conflictingPolicyJson.configWarnings.map((warning) => warning.code),
    ['approval.conflicting_tool_patterns'],
  );
  assert.match(conflictingPolicyJson.configWarnings[0].message, /exec/);
  assert.match(conflictingPolicyJson.configWarnings[0].message, /deniedTools takes precedence/);

  const usage = renderConfigUsage();
  assert.match(usage, /dmoss config init \[--project\] \[--force\]/);
  assert.match(usage, /dmoss config show/);
  assert.match(usage, /dmoss config show --json/);
  assert.match(usage, /dmoss config validate \[--strict\] \[--json\]/);
  assert.match(usage, /dmoss config validate --strict/);
  assert.match(usage, /dmoss config init --project/);
  assert.match(usage, /dmoss config set profile autonomous/);
  assert.match(usage, /dmoss config set --project safetyMode workspace-write/);
  assert.match(usage, /dmoss config set deniedTools device_\*,write_file/);
  assert.match(usage, /dmoss config set guardrails\.input\.redactPatterns/);
  assert.match(usage, /dmoss config unset <key>/);
  assert.match(usage, /dmoss config unset --project <key>/);
  assert.match(usage, /\.dmoss\/config\.json/);
  assert.match(usage, /DMOSS_CONFIG_FILE/);
  assert.match(usage, /promptCacheDebug/);

  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
  const cleanCliEnv = {
    ...process.env,
    DMOSS_CONFIG_DIR: tmp,
    DMOSS_PROFILE: '',
    DMOSS_CONFIG_PROFILE: '',
    DMOSS_PROVIDER: '',
    DMOSS_API_KEY: '',
    DASHSCOPE_API_KEY: '',
    ALIYUN_API_KEY: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    DMOSS_DENIED_TOOLS: '',
    DMOSS_MODEL: '',
    DMOSS_BASE_URL: '',
    OPENAI_BASE_URL: '',
    ANTHROPIC_BASE_URL: '',
    DASHSCOPE_BASE_URL: '',
    DMOSS_MCP_ENABLED: '',
    DMOSS_MCP_CONFIG: '',
    DMOSS_MCP_CONFIG_FILE: '',
    NO_COLOR: '1',
  };
  for (const args of [['config'], ['config', 'show']]) {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      env: cleanCliEnv,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${args.join(' ')} should exit cleanly: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, /\[auth\]/);
    assert.match(result.stderr, /profile: balanced \(default\)/);
    assert.match(result.stderr, /config: /);
    assert.doesNotMatch(result.stderr, /stored-secret/);
  }

  for (const args of [['config', '--json'], ['config', 'show', '--json']]) {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      env: cleanCliEnv,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${args.join(' ')} should exit cleanly: ${result.stderr || result.stdout}`);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.schema, 'dmoss_cli_config.v1');
    assert.equal(parsed.profile, 'balanced');
    assert.equal(parsed.profileSource, 'default');
    assert.equal(parsed.provider, 'qwen');
    assert.equal(parsed.apiKeyConfigured, true);
    assert.equal(parsed.apiKeySource, 'config');
    assert.equal(Object.hasOwn(parsed, 'apiKey'), false);
    assert.deepEqual(parsed.deniedTools, []);
    assert.equal(parsed.deniedToolsSource, 'default');
    assert.deepEqual(parsed.configWarnings, []);
    assert.equal(parsed.promptCacheEnabled, true);
    assert.equal(parsed.maxAgentTurns, 64);
    assert.deepEqual(parsed.compactionSettings, { reserveTokens: 20000, keepRecentTokens: 20000 });
    assert.match(parsed.configPath, /config\.json$/);
    assert.equal(parsed.projectConfigPath, null);
    assert.doesNotMatch(result.stdout, /stored-secret/);
  }

  const validateResult = spawnSync(process.execPath, [cliPath, 'config', 'validate'], {
    env: cleanCliEnv,
    encoding: 'utf8',
  });
  assert.equal(validateResult.status, 0, `config validate should exit cleanly: ${validateResult.stderr || validateResult.stdout}`);
  assert.match(validateResult.stderr, /\[config\] valid: /);
  assert.match(validateResult.stderr, /\[config\] warnings: none/);

  const validateJsonResult = spawnSync(process.execPath, [cliPath, 'config', 'validate', '--json'], {
    env: cleanCliEnv,
    encoding: 'utf8',
  });
  assert.equal(validateJsonResult.status, 0, `config validate --json should exit cleanly: ${validateJsonResult.stderr || validateJsonResult.stdout}`);
  assert.equal(validateJsonResult.stderr, '');
  const validateJson = JSON.parse(validateJsonResult.stdout);
  assert.equal(validateJson.schema, 'dmoss_cli_config_validation.v1');
  assert.equal(validateJson.ok, true);
  assert.equal(validateJson.strict, false);
  assert.equal(validateJson.warningCount, 0);
  assert.deepEqual(validateJson.configWarnings, []);
  assert.match(validateJson.configPath, /config\.json$/);
  assert.equal(validateJson.projectConfigPath, null);

  const oldExitCodeForValidate = process.exitCode;
  try {
    process.exitCode = undefined;
    runConfigValidate(['--unknown']);
    assert.equal(process.exitCode, 1, 'config validate should reject unknown args');
  } finally {
    process.exitCode = oldExitCodeForValidate;
  }

  const initConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-init-config-'));
  const oldInitConfigDir = process.env.DMOSS_CONFIG_DIR;
  const oldInitConfigFile = process.env.DMOSS_CONFIG_FILE;
  const initEnvNames = [
    'DMOSS_PROFILE',
    'DMOSS_PROVIDER',
    'DMOSS_MODEL',
    'DMOSS_BASE_URL',
    'OPENAI_BASE_URL',
    'ANTHROPIC_BASE_URL',
    'DASHSCOPE_BASE_URL',
    'DMOSS_SAFETY_MODE',
    'DMOSS_APPROVAL_POLICY',
    'DMOSS_TRUSTED_TOOLS',
    'DMOSS_DENIED_TOOLS',
    'DMOSS_PROMPT_CACHE',
    'DMOSS_PROMPT_CACHE_DEBUG',
    'DMOSS_MCP_ENABLED',
    'DMOSS_MCP_CONFIG',
    'DMOSS_MCP_CONFIG_FILE',
    'DMOSS_MAX_AGENT_TURNS',
    'DMOSS_CONTEXT_TOKENS',
  ];
  const oldInitEnv = new Map(initEnvNames.map((name) => [name, process.env[name]]));
  try {
    process.env.DMOSS_CONFIG_DIR = initConfigDir;
    delete process.env.DMOSS_CONFIG_FILE;
    for (const name of initEnvNames) delete process.env[name];
    runConfigInit([]);
    const initPath = path.join(initConfigDir, 'config.json');
    const initialized = JSON.parse(fs.readFileSync(initPath, 'utf8'));
    assert.equal(initialized.profile, 'balanced');
    assert.equal(initialized.provider, 'anthropic');
    assert.equal(initialized.safetyMode, 'workspace-write');
    assert.equal(initialized.approvalPolicy, 'prompt');
    assert.deepEqual(initialized.trustedTools, []);
    assert.deepEqual(initialized.deniedTools, []);
    assert.deepEqual(initialized.promptCache, { enabled: true, debug: false });
    assert.deepEqual(initialized.mcp, { enabled: false, configPath: path.join(initConfigDir, 'mcp.json') });
    assert.equal(initialized.agent.maxTurns, 64);
    assert.equal(initialized.agent.contextTokens, 200000);
    assert.deepEqual(initialized.agent.compaction, { reserveTokens: 20000, keepRecentTokens: 20000 });
    assert.equal(Object.hasOwn(initialized, 'apiKey'), false, 'config init must not persist env or placeholder API keys');
    runConfigInit([]);
    assert.equal(process.exitCode, 1, 'config init should not overwrite by default');
    process.exitCode = 0;
    runConfigInit(['--force']);
    assert.equal(JSON.parse(fs.readFileSync(initPath, 'utf8')).profile, 'balanced');
    const initCliPath = path.join(initConfigDir, 'cli-init.json');
    const initCliResult = spawnSync(process.execPath, [
      cliPath,
      '--config-file',
      initCliPath,
      'config',
      'init',
      '--force',
    ], {
      env: cleanCliEnv,
      encoding: 'utf8',
    });
    assert.equal(initCliResult.status, 0, `config init should exit cleanly: ${initCliResult.stderr || initCliResult.stdout}`);
    assert.equal(JSON.parse(fs.readFileSync(initCliPath, 'utf8')).profile, 'balanced');
  } finally {
    if (oldInitConfigDir === undefined) delete process.env.DMOSS_CONFIG_DIR;
    else process.env.DMOSS_CONFIG_DIR = oldInitConfigDir;
    if (oldInitConfigFile === undefined) delete process.env.DMOSS_CONFIG_FILE;
    else process.env.DMOSS_CONFIG_FILE = oldInitConfigFile;
    for (const [name, value] of oldInitEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(initConfigDir, { recursive: true, force: true });
  }

  const initProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-init-project-'));
  const initProjectConfigPath = path.join(initProjectRoot, '.dmoss', 'config.json');
  const oldProjectInitEnv = new Map(initEnvNames.map((name) => [name, process.env[name]]));
  try {
    for (const name of initEnvNames) delete process.env[name];
    runConfigInit(['--project'], initProjectRoot);
    const initializedProject = JSON.parse(fs.readFileSync(initProjectConfigPath, 'utf8'));
    assert.equal(initializedProject.profile, 'balanced');
    assert.equal(initializedProject.safetyMode, 'workspace-write');
    assert.equal(initializedProject.approvalPolicy, 'prompt');
    assert.deepEqual(initializedProject.promptCache, { enabled: true, debug: false });
    assert.deepEqual(initializedProject.mcp, { enabled: false, configPath: '.dmoss/mcp.json' });
    assert.equal(Object.hasOwn(initializedProject, 'provider'), false, 'project init should not persist user provider');
    assert.equal(Object.hasOwn(initializedProject, 'model'), false, 'project init should not persist user model');
    assert.equal(Object.hasOwn(initializedProject, 'baseUrl'), false, 'project init should not persist user baseUrl');
    assert.equal(Object.hasOwn(initializedProject, 'apiKey'), false, 'project init must not persist credentials');
    runConfigInit(['--project'], initProjectRoot);
    assert.equal(process.exitCode, 1, 'project config init should not overwrite by default');
    process.exitCode = 0;
    fs.writeFileSync(initProjectConfigPath, `${JSON.stringify({ profile: 'cautious' }, null, 2)}\n`);
    runConfigInit(['--project', '--force'], initProjectRoot);
    assert.equal(JSON.parse(fs.readFileSync(initProjectConfigPath, 'utf8')).profile, 'balanced');
  } finally {
    for (const [name, value] of oldProjectInitEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(initProjectRoot, { recursive: true, force: true });
  }

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-project-config-'));
  const projectChild = path.join(projectRoot, 'src', 'feature');
  const projectConfigDir = path.join(projectRoot, '.dmoss');
  const projectConfigPath = path.join(projectConfigDir, 'config.json');
  fs.mkdirSync(projectChild, { recursive: true });
  fs.mkdirSync(projectConfigDir, { recursive: true });
  fs.writeFileSync(projectConfigPath, `${JSON.stringify({
    profile: 'autonomous',
    provider: 'openai',
    model: 'project-model',
    safetyMode: 'full-access',
    approvalPolicy: 'never',
    deniedTools: ['device_exec'],
    promptCache: { debug: true },
    mcp: {
      enabled: true,
      configPath: '.dmoss/mcp.json',
    },
    guardrails: {
      input: { redactPatterns: ['PROJECT_SECRET=[^\\s]+'] },
      output: { blockPatterns: ['project leak'] },
    },
    agent: {
      maxTurns: 24,
      contextTokens: 128000,
      compaction: { reserveTokens: 10000 },
    },
  }, null, 2)}\n`);
  try {
    assert.equal(resolveProjectConfigPath(projectChild), projectConfigPath);
    const loadedProject = loadCliConfigFile({ DMOSS_CONFIG_DIR: tmp }, [], projectChild);
    assert.equal(loadedProject.configPath, path.join(tmp, 'config.json'));
    assert.equal(loadedProject.projectConfigPath, projectConfigPath);
    assert.equal(loadedProject.config.profile, 'autonomous');
    assert.equal(loadedProject.config.safetyMode, 'full-access');
    assert.equal(loadedProject.config.approvalPolicy, 'never');
    assert.deepEqual(loadedProject.config.deniedTools, ['device_exec']);
    assert.equal(loadedProject.config.provider, 'qwen');
    assert.equal(loadedProject.config.model, 'qwen3.7-max');
    assert.deepEqual(loadedProject.config.promptCache, { debug: true });
    assert.deepEqual(loadedProject.config.mcp, { enabled: true, configPath: '.dmoss/mcp.json' });
    assert.deepEqual(loadedProject.config.guardrails, {
      input: { redactPatterns: ['PROJECT_SECRET=[^\\s]+'] },
      output: { blockPatterns: ['project leak'] },
    });
    assert.deepEqual(loadedProject.config.agent, {
      maxTurns: 24,
      contextTokens: 128000,
      compaction: { reserveTokens: 10000 },
    });

    const projectResolved = resolveCliConfig({ DMOSS_CONFIG_DIR: tmp }, loadedProject.config, {}, loadedProject);
    assert.equal(projectResolved.projectConfigPath, projectConfigPath);
    assert.equal(projectResolved.profile, 'autonomous');
    assert.equal(projectResolved.profileSource, 'config');
    assert.equal(projectResolved.provider, 'qwen');
    assert.equal(projectResolved.providerSource, 'config');
    assert.equal(projectResolved.safetyMode, 'full-access');
    assert.equal(projectResolved.safetyModeSource, 'config');
    assert.equal(projectResolved.promptCacheEnabled, true);
    assert.deepEqual(projectResolved.deniedTools, ['device_exec']);
    assert.equal(projectResolved.deniedToolsSource, 'config');
    assert.equal(projectResolved.promptCacheDebug, true);
    assert.equal(projectResolved.promptCacheDebugSource, 'config');
    assert.equal(projectResolved.mcpEnabled, true);
    assert.equal(projectResolved.mcpEnabledSource, 'config');
    assert.equal(projectResolved.mcpConfigPath, path.join(projectRoot, '.dmoss', 'mcp.json'));
    assert.equal(projectResolved.mcpConfigPathSource, 'config');
    assert.deepEqual(projectResolved.guardrails.input.redactPatterns, ['PROJECT_SECRET=[^\\s]+']);
    assert.deepEqual(projectResolved.guardrails.output.blockPatterns, ['project leak']);
    assert.equal(projectResolved.guardrailsSource, 'config');
    assert.equal(projectResolved.maxAgentTurns, 24);
    assert.equal(projectResolved.maxAgentTurnsSource, 'config');
    assert.equal(projectResolved.contextTokens, 128000);
    assert.equal(projectResolved.contextTokensSource, 'config');
    assert.deepEqual(projectResolved.compactionSettings, { reserveTokens: 10000, keepRecentTokens: 20000 });
    assert.equal(projectResolved.compactionSettingsSource, 'config');

    const projectShow = spawnSync(process.execPath, [
      cliPath,
      '-C',
      projectChild,
      'config',
      'show',
    ], {
      env: cleanCliEnv,
      encoding: 'utf8',
    });
    assert.equal(projectShow.status, 0, `config show with project config should exit cleanly: ${projectShow.stderr || projectShow.stdout}`);
    assert.match(projectShow.stderr, /profile: autonomous \(config\)/);
    assert.match(projectShow.stderr, new RegExp(`projectConfig: ${projectConfigPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(projectShow.stderr, /stored-secret/);

    const projectShowJson = spawnSync(process.execPath, [
      cliPath,
      '-C',
      projectChild,
      'config',
      'show',
      '--json',
    ], {
      env: cleanCliEnv,
      encoding: 'utf8',
    });
    assert.equal(projectShowJson.status, 0, `config show --json with project config should exit cleanly: ${projectShowJson.stderr || projectShowJson.stdout}`);
    assert.equal(projectShowJson.stderr, '');
    const projectJson = JSON.parse(projectShowJson.stdout);
    assert.equal(projectJson.profile, 'autonomous');
    assert.equal(projectJson.profileSource, 'config');
    assert.equal(projectJson.projectConfigPath, projectConfigPath);
    assert.deepEqual(projectJson.deniedTools, ['device_exec']);
    assert.equal(projectJson.mcpEnabled, true);
    assert.equal(projectJson.mcpConfigPath, path.join(projectRoot, '.dmoss', 'mcp.json'));
    assert.equal(projectJson.guardrails.input.redactPatterns[0], 'PROJECT_SECRET=[^\\s]+');
    assert.equal(projectJson.maxAgentTurns, 24);
    assert.deepEqual(projectJson.compactionSettings, { reserveTokens: 10000, keepRecentTokens: 20000 });
    assert.doesNotMatch(projectShowJson.stdout, /stored-secret/);

    runConfigSet(['--project', 'safetyMode', 'read-only'], projectChild);
    assert.equal(JSON.parse(fs.readFileSync(projectConfigPath, 'utf8')).safetyMode, 'read-only');
    runConfigUnset(['--project', 'safetyMode'], projectChild);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(projectConfigPath, 'utf8')), 'safetyMode'), false);
    const projectOnlyConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-project-only-config-'));
    try {
      const projectOnlyLoaded = loadCliConfigFile({ DMOSS_CONFIG_DIR: projectOnlyConfigDir }, [], projectChild);
      const projectOnlyResolved = resolveCliConfig({ DMOSS_CONFIG_DIR: projectOnlyConfigDir }, projectOnlyLoaded.config, {}, projectOnlyLoaded);
      assert.equal(projectOnlyResolved.safetyMode, 'workspace-write');
      assert.equal(projectOnlyResolved.safetyModeSource, 'profile:autonomous');
    } finally {
      fs.rmSync(projectOnlyConfigDir, { recursive: true, force: true });
    }

    const explicitConfigPath = path.join(projectRoot, 'explicit.json');
    fs.writeFileSync(explicitConfigPath, `${JSON.stringify({ profile: 'cautious' }, null, 2)}\n`);
    const explicitLoaded = loadCliConfigFile({ DMOSS_CONFIG_DIR: tmp, DMOSS_CONFIG_FILE: explicitConfigPath }, [], projectChild);
    assert.equal(explicitLoaded.configPath, explicitConfigPath);
    assert.equal(explicitLoaded.projectConfigPath, undefined);
    assert.equal(explicitLoaded.config.profile, 'cautious');
    assert.equal(explicitLoaded.config.provider, undefined);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }

  const newProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-new-project-config-'));
  try {
    const newProjectConfigPath = path.join(newProjectRoot, '.dmoss', 'config.json');
    runConfigSet(['--project', 'profile', 'cautious'], newProjectRoot);
    assert.deepEqual(JSON.parse(fs.readFileSync(newProjectConfigPath, 'utf8')), { profile: 'cautious' });
  } finally {
    fs.rmSync(newProjectRoot, { recursive: true, force: true });
  }

  const explicitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-explicit-config-'));
  const explicitConfigPath = path.join(explicitDir, 'named-config.json');
  const cliConfigPath = path.join(explicitDir, 'cli-config.json');
  const envIgnoredConfigPath = path.join(explicitDir, 'env-ignored-config.json');
  const invalidConfigPath = path.join(explicitDir, 'invalid.json');
  const nonObjectConfigPath = path.join(explicitDir, 'array-config.json');
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

    fs.writeFileSync(invalidConfigPath, '{bad json\n');
    assert.throws(
      () => loadConfigFile(invalidConfigPath),
      (err) => err instanceof CliConfigFileError &&
        err.configPath === invalidConfigPath &&
        /Invalid dmoss config/.test(err.message),
    );
    fs.writeFileSync(nonObjectConfigPath, '[]\n');
    assert.throws(
      () => loadConfigFile(nonObjectConfigPath),
      /expected a JSON object/,
    );

    const invalidShowResult = spawnSync(process.execPath, [cliPath, '--config-file', invalidConfigPath, 'config', 'show'], {
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
      encoding: 'utf8',
    });
    assert.notEqual(invalidShowResult.status, 0, 'config show should fail when an explicit config file is invalid');
    assert.match(invalidShowResult.stderr, /Invalid dmoss config/);
    assert.match(invalidShowResult.stderr, new RegExp(invalidConfigPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const invalidValidateResult = spawnSync(process.execPath, [cliPath, '--config-file', invalidConfigPath, 'config', 'validate'], {
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
      encoding: 'utf8',
    });
    assert.notEqual(invalidValidateResult.status, 0, 'config validate should fail when an explicit config file is invalid');
    assert.match(invalidValidateResult.stderr, /Invalid dmoss config/);
    assert.match(invalidValidateResult.stderr, new RegExp(invalidConfigPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const riskyValidatePath = path.join(explicitDir, 'risky-validate.json');
    fs.writeFileSync(riskyValidatePath, `${JSON.stringify({
      provider: 'qwen',
      apiKey: 'file-secret',
      approvalPolicy: 'never',
      trustedTools: ['device_*'],
    }, null, 2)}\n`);
    const riskyValidateResult = spawnSync(process.execPath, [cliPath, '--config-file', riskyValidatePath, 'config', 'validate'], {
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
      encoding: 'utf8',
    });
    assert.equal(riskyValidateResult.status, 0, `config validate should allow warnings by default: ${riskyValidateResult.stderr || riskyValidateResult.stdout}`);
    assert.match(riskyValidateResult.stderr, /warning approval\.auto_approval/);
    assert.match(riskyValidateResult.stderr, /warning approval\.no_denied_tools/);
    assert.match(riskyValidateResult.stderr, /warning trustedTools\.broad_patterns/);

    const strictRiskyValidateResult = spawnSync(process.execPath, [cliPath, '--config-file', riskyValidatePath, 'config', 'validate', '--strict', '--json'], {
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
      encoding: 'utf8',
    });
    assert.equal(strictRiskyValidateResult.status, 1, 'config validate --strict should fail when audit warnings are present');
    assert.equal(strictRiskyValidateResult.stderr, '');
    const strictRiskyJson = JSON.parse(strictRiskyValidateResult.stdout);
    assert.equal(strictRiskyJson.ok, false);
    assert.equal(strictRiskyJson.strict, true);
    assert.deepEqual(
      strictRiskyJson.configWarnings.map((warning) => warning.code),
      ['approval.auto_approval', 'approval.no_denied_tools', 'trustedTools.broad_patterns'],
    );

    const conflictingValidatePath = path.join(explicitDir, 'conflicting-validate.json');
    fs.writeFileSync(conflictingValidatePath, `${JSON.stringify({
      provider: 'qwen',
      apiKey: 'file-secret',
      trustedTools: ['exec', 'read_file'],
      deniedTools: ['exec', 'device_exec'],
    }, null, 2)}\n`);
    const conflictingValidateResult = spawnSync(process.execPath, [cliPath, '--config-file', conflictingValidatePath, 'config', 'validate', '--strict', '--json'], {
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
      encoding: 'utf8',
    });
    assert.equal(conflictingValidateResult.status, 1, 'config validate --strict should fail when tool policy has conflicts');
    const conflictingValidateJson = JSON.parse(conflictingValidateResult.stdout);
    assert.deepEqual(
      conflictingValidateJson.configWarnings.map((warning) => warning.code),
      ['approval.conflicting_tool_patterns'],
    );
    assert.match(JSON.stringify(conflictingValidateJson.configWarnings), /deniedTools takes precedence/);

    const repairPath = path.join(explicitDir, 'repair-invalid.json');
    fs.writeFileSync(repairPath, '{bad json\n');
    const repairResult = spawnSync(process.execPath, [
      cliPath,
      '--config-file',
      repairPath,
      'config',
      'init',
      '--force',
    ], {
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
      encoding: 'utf8',
    });
    assert.equal(repairResult.status, 0, `config init --force should repair invalid config: ${repairResult.stderr || repairResult.stdout}`);
    assert.equal(JSON.parse(fs.readFileSync(repairPath, 'utf8')).profile, 'balanced');
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
    deniedTools: ['device_exec'],
    promptCache: { enabled: false, debug: true },
    mcp: { enabled: true, configPath: '/tmp/dmoss-mcp.json' },
    guardrails: {
      input: {
        redactPatterns: ['SECRET=[^\\s]+', 'SECRET=[^\\s]+'],
      },
      output: {
        blockPatterns: ['private token'],
      },
    },
    agent: {
      maxTurns: 18,
      contextTokens: 96000,
      compaction: { reserveTokens: 8000, keepRecentTokens: 9000 },
    },
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
  assert.deepEqual(filePolicyResolved.deniedTools, ['device_exec']);
  assert.equal(filePolicyResolved.deniedToolsSource, 'config');
  assert.equal(filePolicyResolved.promptCacheEnabled, false);
  assert.equal(filePolicyResolved.promptCacheSource, 'config');
  assert.equal(filePolicyResolved.promptCacheDebug, true);
  assert.equal(filePolicyResolved.promptCacheDebugSource, 'config');
  assert.equal(filePolicyResolved.mcpEnabled, true);
  assert.equal(filePolicyResolved.mcpEnabledSource, 'config');
  assert.equal(filePolicyResolved.mcpConfigPath, '/tmp/dmoss-mcp.json');
  assert.equal(filePolicyResolved.mcpConfigPathSource, 'config');
  assert.deepEqual(filePolicyResolved.guardrails.input.redactPatterns, ['SECRET=[^\\s]+']);
  assert.deepEqual(filePolicyResolved.guardrails.output.blockPatterns, ['private token']);
  assert.equal(filePolicyResolved.guardrailsSource, 'config');
  filePolicyResolved.guardrails.input.redactPatterns.push('MUTATED');
  assert.deepEqual(resolveCliConfig({}, loadConfigFile()).guardrails.input.redactPatterns, ['SECRET=[^\\s]+']);
  assert.equal(filePolicyResolved.maxAgentTurns, 18);
  assert.equal(filePolicyResolved.maxAgentTurnsSource, 'config');
  assert.equal(filePolicyResolved.contextTokens, 96000);
  assert.equal(filePolicyResolved.contextTokensSource, 'config');
  assert.deepEqual(filePolicyResolved.compactionSettings, { reserveTokens: 8000, keepRecentTokens: 9000 });
  assert.equal(filePolicyResolved.compactionSettingsSource, 'config');
  assert.deepEqual(resolveCliAgentRuntimeOptions(filePolicyResolved), {
    maxAgentTurns: 18,
    contextTokens: 96000,
    compactionSettings: { reserveTokens: 8000, keepRecentTokens: 9000 },
    promptCache: { enabled: false, debug: true },
  });

  const autonomousResolved = resolveCliConfig({}, {
    profile: 'autonomous',
    provider: 'qwen',
    apiKey: 'stored-secret',
  });
  assert.deepEqual(
    auditResolvedCliConfig(autonomousResolved).map((warning) => warning.code),
    ['approval.auto_approval', 'approval.no_denied_tools'],
  );
  assert.deepEqual(
    auditResolvedCliConfigFromRoot(autonomousResolved).map((warning) => warning.code),
    ['approval.auto_approval', 'approval.no_denied_tools'],
  );
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
  assert.throws(
    () => resolveCliConfig({}, { agent: { maxTurns: 0 } }),
    /Unsupported agent\.maxTurns/,
  );
  assert.throws(
    () => resolveCliConfig({}, { agent: { compaction: { reserveTokens: -1 } } }),
    /Unsupported agent\.compaction\.reserveTokens/,
  );

  runConfigSet(['profile', 'autonomous']);
  assert.equal(loadConfigFile().profile, 'autonomous');
  runConfigSet(['model', 'qwen-plus']);
  assert.equal(loadConfigFile().model, 'qwen-plus');
  runConfigSet(['baseUrl', 'https://example.com/v1/']);
  assert.equal(loadConfigFile().baseUrl, 'https://example.com');
  runConfigSet(['baseUrl', 'https://user:pass@example.com/compatible-mode/v1?api_key=secret#frag']);
  assert.equal(loadConfigFile().baseUrl, 'https://example.com/compatible-mode');
  runConfigSet(['workspace', '/tmp/dmoss-config-workspace']);
  assert.equal(loadConfigFile().workspace, '/tmp/dmoss-config-workspace');
  runConfigSet(['safetyMode', 'read-only']);
  assert.equal(loadConfigFile().safetyMode, 'read-only');
  runConfigSet(['approvalPolicy', 'never']);
  assert.equal(loadConfigFile().approvalPolicy, 'never');
  runConfigSet(['trustedTools', 'exec,filesystem__*']);
  assert.deepEqual(loadConfigFile().trustedTools, ['exec', 'filesystem__*']);
  runConfigSet(['deniedTools', 'device_*,write_file']);
  assert.deepEqual(loadConfigFile().deniedTools, ['device_*', 'write_file']);
  runConfigSet(['promptCache', 'false']);
  assert.deepEqual(loadConfigFile().promptCache, { enabled: false, debug: true });
  runConfigSet(['promptCacheDebug', 'true']);
  assert.deepEqual(loadConfigFile().promptCache, { enabled: false, debug: true });
  runConfigSet(['guardrails.input.blockPatterns', 'delete\\s+repo,rm\\s+-rf']);
  assert.deepEqual(loadConfigFile().guardrails.input.blockPatterns, ['delete\\s+repo', 'rm\\s+-rf']);
  runConfigSet(['guardrails.input.redactPatterns', 'TOKEN=[^\\s]+,TOKEN=[^\\s]+']);
  assert.deepEqual(loadConfigFile().guardrails.input.redactPatterns, ['TOKEN=[^\\s]+']);
  runConfigSet(['guardrails.output.blockPatterns', 'private token']);
  assert.deepEqual(loadConfigFile().guardrails.output.blockPatterns, ['private token']);
  runConfigSet(['guardrails.output.redactPatterns', 'SECRET=[^\\s]+']);
  assert.deepEqual(loadConfigFile().guardrails.output.redactPatterns, ['SECRET=[^\\s]+']);
  {
    const beforeInvalidGuardrailSet = JSON.stringify(loadConfigFile().guardrails);
    const oldExitCodeForGuardrails = process.exitCode;
    try {
      process.exitCode = undefined;
      runConfigSet(['guardrails.input.blockPatterns', '[']);
      assert.equal(process.exitCode, 1, 'invalid guardrail regex should be rejected');
      assert.equal(JSON.stringify(loadConfigFile().guardrails), beforeInvalidGuardrailSet);
    } finally {
      process.exitCode = oldExitCodeForGuardrails;
    }
  }
  runConfigSet(['mcp.enabled', 'true']);
  assert.deepEqual(loadConfigFile().mcp, { enabled: true, configPath: '/tmp/dmoss-mcp.json' });
  runConfigSet(['mcp.configPath', '.dmoss/mcp.json']);
  assert.deepEqual(loadConfigFile().mcp, { enabled: true, configPath: '.dmoss/mcp.json' });
  runConfigSet(['agent.maxTurns', '96']);
  assert.equal(loadConfigFile().agent.maxTurns, 96);
  runConfigSet(['agent.contextTokens', '160000']);
  assert.equal(loadConfigFile().agent.contextTokens, 160000);
  runConfigSet(['agent.compaction.reserveTokens', '24000']);
  assert.deepEqual(loadConfigFile().agent.compaction, { reserveTokens: 24000, keepRecentTokens: 9000 });
  runConfigSet(['agent.compaction.keepRecentTokens', '12000']);
  assert.deepEqual(loadConfigFile().agent.compaction, { reserveTokens: 24000, keepRecentTokens: 12000 });

  const configSetResolved = resolveCliConfig(
    { DMOSS_CONFIG_DIR: tmp },
    loadConfigFile(),
    {},
    { configPath: path.join(tmp, 'config.json') },
  );
  assert.equal(configSetResolved.maxAgentTurns, 96);
  assert.deepEqual(configSetResolved.deniedTools, ['device_*', 'write_file']);
  assert.equal(configSetResolved.deniedToolsSource, 'config');
  assert.equal(configSetResolved.maxAgentTurnsSource, 'config');
  assert.equal(configSetResolved.contextTokens, 160000);
  assert.equal(configSetResolved.contextTokensSource, 'config');
  assert.deepEqual(configSetResolved.compactionSettings, { reserveTokens: 24000, keepRecentTokens: 12000 });
  assert.equal(configSetResolved.compactionSettingsSource, 'config');
  assert.equal(configSetResolved.mcpEnabled, true);
  assert.equal(configSetResolved.mcpConfigPath, path.join(tmp, '.dmoss', 'mcp.json'));
  assert.deepEqual(configSetResolved.guardrails.input.blockPatterns, ['delete\\s+repo', 'rm\\s+-rf']);
  assert.deepEqual(configSetResolved.guardrails.input.redactPatterns, ['TOKEN=[^\\s]+']);
  assert.deepEqual(configSetResolved.guardrails.output.blockPatterns, ['private token']);
  assert.deepEqual(configSetResolved.guardrails.output.redactPatterns, ['SECRET=[^\\s]+']);
  assert.equal(configSetResolved.guardrailsSource, 'config');

  runConfigUnset(['approvalPolicy']);
  assert.equal(Object.hasOwn(loadConfigFile(), 'approvalPolicy'), false);
  assert.equal(resolveCliConfig({}, loadConfigFile()).approvalPolicySource, 'profile:autonomous');
  runConfigUnset(['trustedTools']);
  assert.equal(Object.hasOwn(loadConfigFile(), 'trustedTools'), false);
  assert.deepEqual(resolveCliConfig({}, loadConfigFile()).trustedTools, ['exec', 'apply_patch']);
  runConfigUnset(['deniedTools']);
  assert.equal(Object.hasOwn(loadConfigFile(), 'deniedTools'), false);
  assert.deepEqual(resolveCliConfig({}, loadConfigFile()).deniedTools, []);
  runConfigUnset(['promptCache']);
  assert.deepEqual(loadConfigFile().promptCache, { debug: true });
  assert.equal(resolveCliConfig({}, loadConfigFile()).promptCacheSource, 'profile:autonomous');
  runConfigUnset(['promptCacheDebug']);
  assert.equal(Object.hasOwn(loadConfigFile(), 'promptCache'), false);
  runConfigUnset(['guardrails.input.blockPatterns']);
  assert.equal(Object.hasOwn(loadConfigFile().guardrails.input, 'blockPatterns'), false);
  runConfigUnset(['guardrails.input.redactPatterns']);
  assert.equal(Object.hasOwn(loadConfigFile().guardrails, 'input'), false);
  runConfigUnset(['guardrails.output.blockPatterns']);
  assert.equal(Object.hasOwn(loadConfigFile().guardrails.output, 'blockPatterns'), false);
  runConfigUnset(['guardrails.output.redactPatterns']);
  assert.equal(Object.hasOwn(loadConfigFile(), 'guardrails'), false);
  runConfigUnset(['mcp.enabled']);
  assert.deepEqual(loadConfigFile().mcp, { configPath: '.dmoss/mcp.json' });
  runConfigUnset(['mcp.configPath']);
  assert.equal(Object.hasOwn(loadConfigFile(), 'mcp'), false);
  runConfigUnset(['agent.compaction.reserveTokens']);
  assert.deepEqual(loadConfigFile().agent.compaction, { keepRecentTokens: 12000 });
  runConfigUnset(['agent.compaction.keepRecentTokens']);
  assert.equal(Object.hasOwn(loadConfigFile().agent, 'compaction'), false);
  runConfigUnset(['agent.maxTurns']);
  assert.equal(Object.hasOwn(loadConfigFile().agent, 'maxTurns'), false);
  runConfigUnset(['agent.contextTokens']);
  assert.equal(Object.hasOwn(loadConfigFile(), 'agent'), false);
  runConfigUnset(['workspace']);
  assert.equal(Object.hasOwn(loadConfigFile(), 'workspace'), false);

  const unsetCliConfigPath = path.join(tmp, 'unset-cli.json');
  fs.writeFileSync(unsetCliConfigPath, `${JSON.stringify({ model: 'temporary-model' }, null, 2)}\n`);
  const unsetResult = spawnSync(process.execPath, [
    cliPath,
    '--config-file',
    unsetCliConfigPath,
    'config',
    'unset',
    'model',
  ], {
    env: cleanCliEnv,
    encoding: 'utf8',
  });
  assert.equal(unsetResult.status, 0, `config unset should exit cleanly: ${unsetResult.stderr || unsetResult.stdout}`);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(unsetCliConfigPath, 'utf8')), 'model'), false);

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
