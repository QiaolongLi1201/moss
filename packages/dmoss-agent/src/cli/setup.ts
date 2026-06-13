import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';
import { stdin as input, stderr as output, stdout as standardOutput } from 'node:process';
import { isHttpUrl, stripEndpointSuffix } from '../provider/api-v1-url.js';
import {
  auditResolvedCliConfig,
  isBroadTrustedToolPattern,
  loadCliConfigFile,
  loadConfigFile,
  normalizeApprovalPolicyConfig,
  normalizeConfigProfile,
  normalizeSafetyModeConfig,
  parseConfigBoolean,
  parseProviderPreset,
  parseTrustedTools,
  PROVIDER_PRESETS,
  resolveCliConfig,
  resolveConfigPath,
  resolveProjectConfigPath,
  saveConfigFile,
  saveConfigFileAtPath,
  type CliProviderPreset,
  type ConfigFile,
} from './config.js';
import {
  clearDmossCommunityAuthSession,
  formatCommunityAuthStatus,
  getDmossCommunityAuthStatus,
} from './community-auth.js';

function print(line = ''): void {
  output.write(`${line}\n`);
}

function question(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function questionWith(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

function hiddenQuestion(prompt: string): Promise<string> {
  if (!input.isTTY) return question(prompt);

  return new Promise((resolve) => {
    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    output.write(prompt);
    let value = '';

    function cleanup() {
      input.off('keypress', onKeypress);
      input.setRawMode(wasRaw);
      output.write('\n');
      resolve(value.trim());
    }

    function onKeypress(str: string, key: readline.Key) {
      if (key.ctrl && key.name === 'c') {
        output.write('\n');
        process.exit(130);
      }
      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        return;
      }
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        return;
      }
      if (!key.ctrl && !key.meta && str) {
        value += str;
      }
    }

    input.on('keypress', onKeypress);
  });
}

function providerFromChoice(choice: string): CliProviderPreset {
  const normalized = choice.trim().toLowerCase();
  if (normalized === '1' || normalized === 'deepseek' || normalized === 'ds') return 'deepseek';
  if (normalized === '2' || normalized === 'qwen' || normalized === 'aliyun') return 'qwen';
  if (normalized === '3' || normalized === 'openai') return 'openai';
  if (normalized === '4' || normalized === 'anthropic' || normalized === 'claude') return 'anthropic';
  if (normalized === '5' || normalized === 'compatible' || normalized === 'openai-compatible') return 'openai-compatible';
  return 'deepseek';
}

function sanitizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return stripEndpointSuffix(url.toString());
  } catch {
    return stripEndpointSuffix(trimmed);
  }
}

function withoutSecret(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value || '(not configured)';
  }
}

function guardrailSummary(resolved: ReturnType<typeof resolveCliConfig>): string {
  const inputCount = resolved.guardrails.input.blockPatterns.length + resolved.guardrails.input.redactPatterns.length;
  const outputCount = resolved.guardrails.output.blockPatterns.length + resolved.guardrails.output.redactPatterns.length;
  if (inputCount === 0 && outputCount === 0) return `none (${resolved.guardrailsSource})`;
  return `input ${inputCount}, output ${outputCount} (${resolved.guardrailsSource})`;
}

function configAuditSummary(resolved: ReturnType<typeof resolveCliConfig>): string {
  const warnings = auditResolvedCliConfig(resolved);
  if (warnings.length === 0) return 'none';
  return warnings.map((warning) => `${warning.code}: ${warning.message}`).join('; ');
}

function serializeResolvedConfig(resolved: ReturnType<typeof resolveCliConfig>): Record<string, unknown> {
  return {
    schema: 'dmoss_cli_config.v1',
    profile: resolved.profile,
    profileSource: resolved.profileSource,
    provider: resolved.provider,
    providerSource: resolved.providerSource,
    model: resolved.model,
    modelSource: resolved.modelSource,
    baseUrl: withoutSecret(resolved.baseUrl),
    baseUrlSource: resolved.baseUrlSource,
    imageInput: resolved.imageInput,
    imageInputSource: resolved.imageInputSource,
    apiKeyConfigured: Boolean(resolved.apiKey),
    apiKeySource: resolved.apiKeySource,
    ignoredModelEnvVars: [...resolved.ignoredModelEnvVars],
    workspace: resolved.workspace,
    workspaceSource: resolved.workspaceSource,
    safetyMode: resolved.safetyMode,
    safetyModeSource: resolved.safetyModeSource,
    approvalPolicy: resolved.approvalPolicy,
    approvalPolicySource: resolved.approvalPolicySource,
    trustedTools: [...resolved.trustedTools],
    trustedToolsSource: resolved.trustedToolsSource,
    deniedTools: [...resolved.deniedTools],
    deniedToolsSource: resolved.deniedToolsSource,
    promptCacheEnabled: resolved.promptCacheEnabled,
    promptCacheSource: resolved.promptCacheSource,
    promptCacheDebug: resolved.promptCacheDebug,
    promptCacheDebugSource: resolved.promptCacheDebugSource,
    guardrails: {
      input: {
        blockPatterns: [...resolved.guardrails.input.blockPatterns],
        redactPatterns: [...resolved.guardrails.input.redactPatterns],
      },
      output: {
        blockPatterns: [...resolved.guardrails.output.blockPatterns],
        redactPatterns: [...resolved.guardrails.output.redactPatterns],
      },
    },
    guardrailsSource: resolved.guardrailsSource,
    maxAgentTurns: resolved.maxAgentTurns,
    maxAgentTurnsSource: resolved.maxAgentTurnsSource,
    contextTokens: resolved.contextTokens,
    contextTokensSource: resolved.contextTokensSource,
    compactionSettings: { ...resolved.compactionSettings },
    compactionSettingsSource: resolved.compactionSettingsSource,
    mcpEnabled: resolved.mcpEnabled,
    mcpEnabledSource: resolved.mcpEnabledSource,
    mcpConfigPath: resolved.mcpConfigPath,
    mcpConfigPathSource: resolved.mcpConfigPathSource,
    configWarnings: auditResolvedCliConfig(resolved),
    configPath: resolved.configPath,
    projectConfigPath: resolved.projectConfigPath ?? null,
  };
}

function serializeConfigValidation(
  resolved: ReturnType<typeof resolveCliConfig>,
  options: { strict: boolean },
): Record<string, unknown> {
  const warnings = auditResolvedCliConfig(resolved);
  return {
    schema: 'dmoss_cli_config_validation.v1',
    ok: !options.strict || warnings.length === 0,
    strict: options.strict,
    warningCount: warnings.length,
    configWarnings: warnings,
    configPath: resolved.configPath,
    projectConfigPath: resolved.projectConfigPath ?? null,
  };
}

function parseConfigPositiveInteger(value: string, key: string): number | null {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    print(`Supported ${key} value: positive integer`);
    process.exitCode = 1;
    return null;
  }
  return parsed;
}

function parseConfigPatternList(value: string, key: string): string[] {
  const patterns = value
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  const unique = [...new Set(patterns)];
  for (const pattern of unique) {
    if (pattern.length > 500) {
      throw new Error(`Unsupported ${key} pattern: values must be 500 characters or less`);
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'g');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid ${key} pattern "${pattern}": ${message}`);
    }
    if (regex.test('')) {
      throw new Error(`Invalid ${key} pattern "${pattern}": pattern must not match empty text`);
    }
  }
  return unique;
}

function setGuardrailPatternList(config: ConfigFile, key: string, value: string): boolean {
  if (
    key !== 'guardrails.input.blockPatterns' &&
    key !== 'guardrails.input.redactPatterns' &&
    key !== 'guardrails.output.blockPatterns' &&
    key !== 'guardrails.output.redactPatterns'
  ) {
    return false;
  }
  const [, direction, listKey] = key.split('.') as ['guardrails', 'input' | 'output', 'blockPatterns' | 'redactPatterns'];
  config.guardrails = {
    ...config.guardrails,
    [direction]: {
      ...config.guardrails?.[direction],
      [listKey]: parseConfigPatternList(value, key),
    },
  };
  return true;
}

export function renderAuthStatus(
  config?: ConfigFile,
  env: NodeJS.ProcessEnv = process.env,
  startDir = process.cwd(),
): string {
  const loaded = config === undefined ? loadCliConfigFile(env, process.argv.slice(2), startDir) : undefined;
  const resolved = resolveCliConfig(env, config ?? loaded?.config, {}, loaded);
  const communityStatus = getDmossCommunityAuthStatus({ env });
  return [
    '[auth]',
    `  community: ${formatCommunityAuthStatus(communityStatus)}`,
    `  provider: ${resolved.provider} (${resolved.providerSource})`,
    `  profile: ${resolved.profile} (${resolved.profileSource})`,
    `  model: ${resolved.model} (${resolved.modelSource})`,
    `  baseUrl: ${withoutSecret(resolved.baseUrl)} (${resolved.baseUrlSource})`,
    `  imageInput: ${resolved.imageInput ? 'enabled' : 'disabled'} (${resolved.imageInputSource})`,
    `  apiKey: ${resolved.apiKey ? `configured via ${resolved.apiKeySource}` : 'missing'}`,
    `  safetyMode: ${resolved.safetyMode} (${resolved.safetyModeSource})`,
    `  approvalPolicy: ${resolved.approvalPolicy} (${resolved.approvalPolicySource})`,
    `  trustedTools: ${resolved.trustedTools.length ? resolved.trustedTools.join(', ') : 'none'} (${resolved.trustedToolsSource})`,
    `  deniedTools: ${resolved.deniedTools.length ? resolved.deniedTools.join(', ') : 'none'} (${resolved.deniedToolsSource})`,
    `  promptCache: ${resolved.promptCacheEnabled ? 'enabled' : 'disabled'} (${resolved.promptCacheSource})`,
    `  promptCacheDebug: ${resolved.promptCacheDebug ? 'enabled' : 'disabled'} (${resolved.promptCacheDebugSource})`,
    `  guardrails: ${guardrailSummary(resolved)}`,
    `  maxAgentTurns: ${resolved.maxAgentTurns} (${resolved.maxAgentTurnsSource})`,
    `  contextTokens: ${resolved.contextTokens} (${resolved.contextTokensSource})`,
    `  compaction: reserve ${resolved.compactionSettings.reserveTokens}, keepRecent ${resolved.compactionSettings.keepRecentTokens} (${resolved.compactionSettingsSource})`,
    `  mcp: ${resolved.mcpEnabled ? 'enabled' : 'disabled'} (${resolved.mcpEnabledSource})`,
    `  mcpConfig: ${resolved.mcpConfigPath} (${resolved.mcpConfigPathSource})`,
    `  configWarnings: ${configAuditSummary(resolved)}`,
    `  config: ${resolved.configPath}`,
    `  projectConfig: ${resolved.projectConfigPath || 'none'}`,
  ].join('\n');
}

export function renderConfigJson(
  config?: ConfigFile,
  env: NodeJS.ProcessEnv = process.env,
  startDir = process.cwd(),
): string {
  const loaded = config === undefined ? loadCliConfigFile(env, process.argv.slice(2), startDir) : undefined;
  const resolved = resolveCliConfig(env, config ?? loaded?.config, {}, loaded);
  return JSON.stringify(serializeResolvedConfig(resolved), null, 2);
}

export function renderConfigUsage(): string {
  return [
    'Usage:',
    '  moss config',
    '  moss config init [--project] [--force]',
    '  moss config show',
    '  moss config show --json',
    '  moss config validate [--strict] [--json]',
    '  moss config set <profile|provider|model|baseUrl|imageInput|workspace|safetyMode|approvalPolicy|trustedTools|deniedTools|promptCache|promptCacheDebug|guardrails.*|mcp.enabled|mcp.configPath|agent.*> <value>',
    '  moss config set --project <key> <value>',
    '  moss config unset <key>',
    '  moss config unset --project <key>',
    '',
    'Config file:',
    '  Moss reads .moss/config.json from the current workspace as project defaults',
    '  moss --config-file /path/to/config.json config show',
    '  set DMOSS_CONFIG_FILE=/path/to/config.json to use an explicit config file',
    '',
    'Examples:',
    '  moss config init --project',
    '  moss config validate --strict',
    '  moss config set profile autonomous',
    '  moss config set provider openai-compatible',
    '  moss config set model <your-model>',
    '  moss config set baseUrl https://your-gateway.example/v1',
    '  moss config set imageInput true',
    '  moss config set --project safetyMode workspace-write',
    '  moss config set approvalPolicy prompt',
    '  moss config set trustedTools exec,filesystem__*',
    '  moss config set deniedTools device_*,write_file',
    '  moss config set mcp.enabled true',
    '  moss config set mcp.configPath .moss/mcp.json',
    '  moss config set guardrails.input.redactPatterns SECRET=[^\\\\s]+',
    '  moss config set agent.maxTurns 96',
    '  moss config set agent.contextTokens 200000',
    '  moss config set agent.compaction.reserveTokens 20000',
  ].join('\n');
}

export function runConfigShow(startDir = process.cwd(), options: { json?: boolean } = {}): void {
  if (options.json) {
    standardOutput.write(`${renderConfigJson(undefined, process.env, startDir)}\n`);
    return;
  }
  print(renderAuthStatus(undefined, process.env, startDir));
}

export function runConfigValidate(
  args: string[] = [],
  startDir = process.cwd(),
): void {
  let json = false;
  let strict = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '--strict') strict = true;
    else {
      print(renderConfigUsage());
      process.exitCode = 1;
      return;
    }
  }

  const loaded = loadCliConfigFile(process.env, process.argv.slice(2), startDir);
  const resolved = resolveCliConfig(process.env, loaded.config, {}, loaded);
  const warnings = auditResolvedCliConfig(resolved);
  if (strict && warnings.length > 0) process.exitCode = 1;

  if (json) {
    standardOutput.write(`${JSON.stringify(serializeConfigValidation(resolved, { strict }), null, 2)}\n`);
    return;
  }

  print(`[config] valid: ${resolved.configPath}`);
  if (resolved.projectConfigPath) print(`[config] project config: ${resolved.projectConfigPath}`);
  if (warnings.length === 0) {
    print('[config] warnings: none');
    return;
  }
  for (const warning of warnings) {
    print(`[config] warning ${warning.code}: ${warning.message}`);
  }
  if (strict) print('[config] strict validation failed because warnings are present.');
}

export async function runSetupWizard(): Promise<void> {
  const current = loadConfigFile();
  print('Moss model setup');
  print('');
  print('Choose provider:');
  print('  1. DeepSeek (recommended)');
  print('  2. Aliyun / Qwen');
  print('  3. OpenAI');
  print('  4. Anthropic');
  print('  5. OpenAI-compatible');

  const pipedAnswers = input.isTTY ? null : fs.readFileSync(0, 'utf-8').split(/\r?\n/);
  let answerIndex = 0;
  const nextPipedAnswer = () => (pipedAnswers ? (pipedAnswers[answerIndex++] ?? '').trim() : '');

  const rl = input.isTTY ? readline.createInterface({ input, output }) : null;
  const providerAnswer = rl ? await questionWith(rl, 'Provider [1]: ') : nextPipedAnswer();
  const provider = providerFromChoice(providerAnswer || '1');
  const preset = PROVIDER_PRESETS[provider];

  const defaultModel = current.model || preset.defaultModel;
  const defaultBaseUrl = current.baseUrl || preset.defaultBaseUrl;
  const modelAnswer = rl ? await questionWith(rl, `Model [${defaultModel}]: `) : nextPipedAnswer();
  const model = modelAnswer || defaultModel;
  const baseUrlAnswer = rl ? await questionWith(rl, `Base URL [${defaultBaseUrl}]: `) : nextPipedAnswer();
  const baseUrlInput = baseUrlAnswer || defaultBaseUrl;
  if (!isHttpUrl(baseUrlInput)) {
    rl?.close();
    print(`Setup cancelled: base URL must be a full http(s) URL, got: ${baseUrlInput}`);
    process.exitCode = 1;
    return;
  }
  const baseUrl = sanitizeBaseUrl(baseUrlInput);
  const imageInput = current.imageInput ?? preset.defaultImageInput;
  let apiKey: string;
  if (input.isTTY) {
    rl?.close();
    apiKey = await hiddenQuestion('API key (hidden): ');
  } else {
    apiKey = nextPipedAnswer();
  }

  if (!apiKey) {
    print('Setup cancelled: API key is required.');
    process.exitCode = 1;
    return;
  }

  const next: ConfigFile = {
    ...current,
    provider,
    model,
    baseUrl,
    imageInput,
    apiKey,
    promptCache: current.promptCache ?? { enabled: true, debug: false },
  };
  saveConfigFile(next);
  print('');
  print(`Saved configuration to ${resolveConfigPath()}`);
  print(`Provider: ${preset.displayName}`);
  print(`Model: ${model}`);
  print(`Base URL: ${withoutSecret(baseUrl)}`);
  print(`Image input: ${imageInput ? 'enabled' : 'disabled'}${imageInput ? '' : ' (enable with `moss config set imageInput true` for a vision-capable gateway)'}`);
  print('');
  print('Try `dmoss "explain this project and how to run it"` or run `dmoss` for interactive mode.');
}

export async function runAuthLogout(): Promise<void> {
  const removedCommunitySession = clearDmossCommunityAuthSession();
  if (removedCommunitySession) {
    print('[auth] D-Robotics community session removed.');
  }
  const current = loadConfigFile();
  if (!current.apiKey) {
    if (!removedCommunitySession) print('[auth] No API key or D-Robotics community session is stored.');
    return;
  }
  const answer = await question('Remove stored API key from Moss config? [y/N] ');
  if (!/^y(es)?$/i.test(answer)) {
    print('[auth] Cancelled.');
    return;
  }
  const next = { ...current };
  delete next.apiKey;
  saveConfigFile(next);
  print('[auth] Stored API key removed. Model and baseUrl were preserved.');
}

function resolveConfigEditTarget(args: string[], startDir: string): { args: string[]; configPath: string; scope: 'user' | 'project' } {
  if (args[0] !== '--project') {
    return { args, configPath: resolveConfigPath(), scope: 'user' };
  }
  const root = path.resolve(startDir);
  return {
    args: args.slice(1),
    configPath: resolveProjectConfigPath(root) ?? path.join(root, '.moss', 'config.json'),
    scope: 'project',
  };
}

function resolveConfigInitTarget(args: string[], startDir: string): { configPath: string; scope: 'user' | 'project'; force: boolean } | null {
  let scope: 'user' | 'project' = 'user';
  let force = false;
  for (const arg of args) {
    if (arg === '--project') {
      scope = 'project';
    } else if (arg === '--force') {
      force = true;
    } else {
      print(renderConfigUsage());
      process.exitCode = 1;
      return null;
    }
  }
  const root = path.resolve(startDir);
  return {
    scope,
    force,
    configPath: scope === 'project'
      ? (resolveProjectConfigPath(root) ?? path.join(root, '.moss', 'config.json'))
      : resolveConfigPath(),
  };
}

function buildUserConfigTemplate(): ConfigFile {
  const resolved = resolveCliConfig(process.env, {});
  return removeEmptyNestedConfig({
    profile: resolved.profile,
    provider: resolved.provider,
    model: resolved.model,
    baseUrl: resolved.baseUrl,
    imageInput: resolved.imageInput,
    workspace: resolved.workspaceSource === 'cwd' ? undefined : resolved.workspace,
    safetyMode: resolved.safetyMode,
    approvalPolicy: resolved.approvalPolicy,
    trustedTools: [...resolved.trustedTools],
    deniedTools: [...resolved.deniedTools],
    promptCache: {
      enabled: resolved.promptCacheEnabled,
      debug: resolved.promptCacheDebug,
    },
    mcp: {
      enabled: resolved.mcpEnabled,
      configPath: resolved.mcpConfigPath,
    },
    agent: {
      maxTurns: resolved.maxAgentTurns,
      contextTokens: resolved.contextTokens,
      compaction: { ...resolved.compactionSettings },
    },
    _examples: {
      customModel: {
        provider: 'openai-compatible',
        baseUrl: 'https://your-gateway.example/v1',
        model: 'your-model-name',
        apiKey: 'paste-your-api-key',
        imageInput: true,
      },
    },
  });
}

function buildProjectConfigTemplate(): ConfigFile {
  const resolved = resolveCliConfig(process.env, {});
  return removeEmptyNestedConfig({
    profile: resolved.profile,
    safetyMode: resolved.safetyMode,
    approvalPolicy: resolved.approvalPolicy,
    trustedTools: [...resolved.trustedTools],
    deniedTools: [...resolved.deniedTools],
    promptCache: {
      enabled: resolved.promptCacheEnabled,
      debug: resolved.promptCacheDebug,
    },
    mcp: {
      enabled: resolved.mcpEnabled,
      configPath: '.moss/mcp.json',
    },
    agent: {
      maxTurns: resolved.maxAgentTurns,
      contextTokens: resolved.contextTokens,
      compaction: { ...resolved.compactionSettings },
    },
  });
}

function supportedConfigKeys(): string {
  return 'Supported keys: profile, provider, model, baseUrl, imageInput, workspace, safetyMode, approvalPolicy, trustedTools, deniedTools, promptCache, promptCacheDebug, guardrails.input.blockPatterns, guardrails.input.redactPatterns, guardrails.output.blockPatterns, guardrails.output.redactPatterns, mcp.enabled, mcp.configPath, agent.maxTurns, agent.contextTokens, agent.compaction.reserveTokens, agent.compaction.keepRecentTokens';
}

function removeEmptyNestedConfig(config: ConfigFile): ConfigFile {
  const next = { ...config };
  if (
    next.promptCache &&
    typeof next.promptCache === 'object' &&
    Object.keys(next.promptCache).length === 0
  ) {
    delete next.promptCache;
  }
  if (next.agent?.compaction && Object.keys(next.agent.compaction).length === 0) {
    next.agent = { ...next.agent };
    delete next.agent.compaction;
  }
  if (next.agent && Object.keys(next.agent).length === 0) {
    delete next.agent;
  }
  if (next.mcp && Object.keys(next.mcp).length === 0) {
    delete next.mcp;
  }
  if (next.guardrails) {
    const guardrails = { ...next.guardrails };
    if (guardrails.input && Object.keys(guardrails.input).length === 0) delete guardrails.input;
    if (guardrails.output && Object.keys(guardrails.output).length === 0) delete guardrails.output;
    if (Object.keys(guardrails).length === 0) delete next.guardrails;
    else next.guardrails = guardrails;
  }
  return next;
}

export function runConfigInit(args: string[], startDir = process.cwd()): void {
  const target = resolveConfigInitTarget(args, startDir);
  if (!target) return;
  if (fs.existsSync(target.configPath) && !target.force) {
    print(`[config] ${target.configPath} already exists. Use --force to overwrite.`);
    process.exitCode = 1;
    return;
  }
  const template = target.scope === 'project' ? buildProjectConfigTemplate() : buildUserConfigTemplate();
  saveConfigFileAtPath(template, target.configPath);
  const scope = target.scope === 'project' ? 'project ' : '';
  print(`[config] ${scope}config initialized in ${target.configPath}`);
}

export function runConfigSet(args: string[], startDir = process.cwd()): void {
  const target = resolveConfigEditTarget(args, startDir);
  args = target.args;
  const [key, ...rest] = args;
  const value = rest.join(' ').trim();
  if (!key || !value) {
    print(renderConfigUsage());
    process.exitCode = 1;
    return;
  }
  const current = loadConfigFile(target.configPath);
  const next = { ...current };
  if (key === 'profile') {
    const profile = normalizeConfigProfile(value);
    if (!profile) {
      print('Supported profile values: cautious, balanced, autonomous');
      process.exitCode = 1;
      return;
    }
    next.profile = profile;
  }
  else if (key === 'provider') {
    const provider = parseProviderPreset(value);
    if (!provider) {
      // normalizeProvider silently coerced unknown values to a default,
      // which buried typos until the first model call failed opaquely.
      print(`Unknown provider: ${value}`);
      print('Supported provider values: deepseek, qwen, openai, anthropic, openai-compatible');
      process.exitCode = 1;
      return;
    }
    next.provider = provider;
  }
  else if (key === 'model') next.model = value;
  else if (key === 'baseUrl') {
    if (!isHttpUrl(value)) {
      print(`Invalid baseUrl: ${value.trim()}`);
      print('baseUrl must be a full http(s) URL, e.g. https://your-gateway.example/v1');
      process.exitCode = 1;
      return;
    }
    const sanitized = sanitizeBaseUrl(value);
    if (sanitized !== value.trim().replace(/\/+$/, '')) {
      print(`[config] baseUrl normalized to API root: ${sanitized}`);
      print('[config] (Moss appends /v1/chat/completions itself — do not include the endpoint path.)');
    }
    next.baseUrl = sanitized;
  }
  else if (key === 'imageInput') {
    const enabled = parseConfigBoolean(value);
    if (enabled === null) {
      print('Supported imageInput values: true, false');
      process.exitCode = 1;
      return;
    }
    next.imageInput = enabled;
  }
  else if (key === 'workspace') next.workspace = path.resolve(value);
  else if (key === 'safetyMode') {
    const mode = normalizeSafetyModeConfig(value);
    if (!mode) {
      print('Supported safetyMode values: read-only, workspace-write, full-access');
      process.exitCode = 1;
      return;
    }
    next.safetyMode = mode;
  } else if (key === 'approvalPolicy') {
    const policy = normalizeApprovalPolicyConfig(value);
    if (!policy) {
      print('Supported approvalPolicy values: prompt, never');
      process.exitCode = 1;
      return;
    }
    next.approvalPolicy = policy;
  } else if (key === 'trustedTools') {
    try {
      const parsedTrusted = parseTrustedTools(value) ?? [];
      next.trustedTools = parsedTrusted;
      const broad = parsedTrusted.filter(isBroadTrustedToolPattern);
      if (broad.length > 0) {
        print(
          `[config] WARNING: broad trusted pattern(s) ${broad.join(', ')} auto-approve every mutating tool the safety mode allows; prefer exact tool names or narrow server__tool globs.`,
        );
      }
    } catch (err) {
      print(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  } else if (key === 'deniedTools') {
    try {
      next.deniedTools = parseTrustedTools(value) ?? [];
    } catch (err) {
      print(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  } else if (key === 'promptCache') {
    const enabled = parseConfigBoolean(value);
    if (enabled === null) {
      print('Supported promptCache values: true, false');
      process.exitCode = 1;
      return;
    }
    const previous = typeof current.promptCache === 'object' && current.promptCache !== null
      ? current.promptCache
      : {};
    next.promptCache = { ...previous, enabled };
  } else if (key === 'promptCacheDebug') {
    const debug = parseConfigBoolean(value);
    if (debug === null) {
      print('Supported promptCacheDebug values: true, false');
      process.exitCode = 1;
      return;
    }
    const previous = typeof current.promptCache === 'object' && current.promptCache !== null
      ? current.promptCache
      : { enabled: typeof current.promptCache === 'boolean' ? current.promptCache : true };
    next.promptCache = { ...previous, debug };
  } else if (key.startsWith('guardrails.')) {
    try {
      if (!setGuardrailPatternList(next, key, value)) {
        print(supportedConfigKeys());
        process.exitCode = 1;
        return;
      }
    } catch (err) {
      print(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  } else if (key === 'mcp.enabled') {
    const enabled = parseConfigBoolean(value);
    if (enabled === null) {
      print('Supported mcp.enabled values: true, false');
      process.exitCode = 1;
      return;
    }
    next.mcp = { ...current.mcp, enabled };
  } else if (key === 'mcp.configPath') {
    next.mcp = { ...current.mcp, configPath: value };
  } else if (key === 'agent.maxTurns' || key === 'agent.contextTokens') {
    const parsed = parseConfigPositiveInteger(value, key);
    if (parsed === null) return;
    next.agent = { ...current.agent };
    if (key === 'agent.maxTurns') next.agent.maxTurns = parsed;
    else next.agent.contextTokens = parsed;
  } else if (key === 'agent.compaction.reserveTokens' || key === 'agent.compaction.keepRecentTokens') {
    const parsed = parseConfigPositiveInteger(value, key);
    if (parsed === null) return;
    next.agent = {
      ...current.agent,
      compaction: {
        ...current.agent?.compaction,
      },
    };
    if (key === 'agent.compaction.reserveTokens') {
      next.agent.compaction = { ...next.agent.compaction, reserveTokens: parsed };
    } else {
      next.agent.compaction = { ...next.agent.compaction, keepRecentTokens: parsed };
    }
  }
  else {
    print(supportedConfigKeys());
    process.exitCode = 1;
    return;
  }
  saveConfigFileAtPath(next, target.configPath);
  const scope = target.scope === 'project' ? 'project ' : '';
  print(`[config] ${scope}${key} updated in ${target.configPath}`);
}

export function runConfigUnset(args: string[], startDir = process.cwd()): void {
  const target = resolveConfigEditTarget(args, startDir);
  args = target.args;
  const [key, ...rest] = args;
  if (!key || rest.length > 0) {
    print(renderConfigUsage());
    process.exitCode = 1;
    return;
  }
  const current = loadConfigFile(target.configPath);
  let next: ConfigFile = { ...current };
  if (key === 'profile') delete next.profile;
  else if (key === 'provider') delete next.provider;
  else if (key === 'model') delete next.model;
  else if (key === 'baseUrl') delete next.baseUrl;
  else if (key === 'imageInput') delete next.imageInput;
  else if (key === 'workspace') delete next.workspace;
  else if (key === 'safetyMode') delete next.safetyMode;
  else if (key === 'approvalPolicy') delete next.approvalPolicy;
  else if (key === 'trustedTools') delete next.trustedTools;
  else if (key === 'deniedTools') delete next.deniedTools;
  else if (key === 'promptCache') {
    if (typeof current.promptCache === 'object' && current.promptCache !== null) {
      next.promptCache = { ...current.promptCache };
      delete next.promptCache.enabled;
    } else {
      delete next.promptCache;
    }
  } else if (key === 'promptCacheDebug') {
    if (typeof current.promptCache === 'object' && current.promptCache !== null) {
      next.promptCache = { ...current.promptCache };
      delete next.promptCache.debug;
    }
  } else if (key === 'guardrails.input.blockPatterns') {
    next.guardrails = { ...current.guardrails, input: { ...current.guardrails?.input } };
    delete next.guardrails.input?.blockPatterns;
  } else if (key === 'guardrails.input.redactPatterns') {
    next.guardrails = { ...current.guardrails, input: { ...current.guardrails?.input } };
    delete next.guardrails.input?.redactPatterns;
  } else if (key === 'guardrails.output.blockPatterns') {
    next.guardrails = { ...current.guardrails, output: { ...current.guardrails?.output } };
    delete next.guardrails.output?.blockPatterns;
  } else if (key === 'guardrails.output.redactPatterns') {
    next.guardrails = { ...current.guardrails, output: { ...current.guardrails?.output } };
    delete next.guardrails.output?.redactPatterns;
  } else if (key === 'mcp.enabled') {
    next.mcp = { ...current.mcp };
    delete next.mcp.enabled;
  } else if (key === 'mcp.configPath') {
    next.mcp = { ...current.mcp };
    delete next.mcp.configPath;
  } else if (key === 'agent.maxTurns') {
    next.agent = { ...current.agent };
    delete next.agent.maxTurns;
  } else if (key === 'agent.contextTokens') {
    next.agent = { ...current.agent };
    delete next.agent.contextTokens;
  } else if (key === 'agent.compaction.reserveTokens') {
    next.agent = { ...current.agent, compaction: { ...current.agent?.compaction } };
    delete next.agent.compaction?.reserveTokens;
  } else if (key === 'agent.compaction.keepRecentTokens') {
    next.agent = { ...current.agent, compaction: { ...current.agent?.compaction } };
    delete next.agent.compaction?.keepRecentTokens;
  } else {
    print(supportedConfigKeys());
    process.exitCode = 1;
    return;
  }
  next = removeEmptyNestedConfig(next);
  saveConfigFileAtPath(next, target.configPath);
  const scope = target.scope === 'project' ? 'project ' : '';
  print(`[config] ${scope}${key} removed from ${target.configPath}`);
}

export function printMissingConfigGuidance(interactive: boolean, options: { bundledDefaultSuppressedBy?: string } = {}): void {
  print('Moss needs a model configuration before it can run.');
  if (options.bundledDefaultSuppressedBy) {
    // Without this, a half-filled config file (e.g. a baseUrl without an API
    // key) silently disabled the built-in gateway and the prompt looked like
    // a broken fresh install.
    print('');
    print(`Note: the built-in model gateway is available but disabled because ${options.bundledDefaultSuppressedBy} already sets model settings.`);
    print('Remove them (moss config unset provider|model|baseUrl) or complete them with an API key.');
  }
  print('');
  print('Fast path:');
  print('  moss setup');
  print('');
  print('Script path (no TTY — model settings are read from config files, never env vars):');
  print('  moss config set provider deepseek');
  print('  moss config set model deepseek-chat');
  print('  write the API key with `moss setup` once, or provide a config file:');
  print('  moss --config-file /path/to/config.json  # {"provider":"deepseek","apiKey":"..."}');
  print('');
  if (interactive) {
    print('You can run setup now, then start `dmoss` again.');
  } else {
    print('One-shot mode does not prompt, so scripts do not hang.');
  }
}

export async function offerSetupForInteractiveMissingConfig(options: { bundledDefaultSuppressedBy?: string } = {}): Promise<void> {
  printMissingConfigGuidance(true, options);
  const answer = await question('Start setup now? [Y/n] ');
  if (!answer || /^y(es)?$/i.test(answer)) {
    await runSetupWizard();
  } else {
    print('Setup skipped. Run `moss setup` when you are ready.');
    process.exitCode = 1;
  }
}
