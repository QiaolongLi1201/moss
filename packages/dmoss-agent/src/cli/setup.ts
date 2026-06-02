import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';
import { stdin as input, stderr as output, stdout as standardOutput } from 'node:process';
import {
  loadCliConfigFile,
  loadConfigFile,
  normalizeApprovalPolicyConfig,
  normalizeConfigProfile,
  normalizeProvider,
  normalizeSafetyModeConfig,
  parseConfigBoolean,
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
  if (normalized === '1' || normalized === 'qwen' || normalized === 'aliyun') return 'qwen';
  if (normalized === '2' || normalized === 'openai') return 'openai';
  if (normalized === '3' || normalized === 'anthropic' || normalized === 'claude') return 'anthropic';
  if (normalized === '4' || normalized === 'compatible' || normalized === 'openai-compatible') return 'openai-compatible';
  return 'qwen';
}

function sanitizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '').replace(/\/v1$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '').replace(/\/v1$/, '');
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
    apiKeyConfigured: Boolean(resolved.apiKey),
    apiKeySource: resolved.apiKeySource,
    workspace: resolved.workspace,
    workspaceSource: resolved.workspaceSource,
    safetyMode: resolved.safetyMode,
    safetyModeSource: resolved.safetyModeSource,
    approvalPolicy: resolved.approvalPolicy,
    approvalPolicySource: resolved.approvalPolicySource,
    trustedTools: [...resolved.trustedTools],
    trustedToolsSource: resolved.trustedToolsSource,
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

export function renderAuthStatus(
  config?: ConfigFile,
  env: NodeJS.ProcessEnv = process.env,
  startDir = process.cwd(),
): string {
  const loaded = config === undefined ? loadCliConfigFile(env, process.argv.slice(2), startDir) : undefined;
  const resolved = resolveCliConfig(env, config ?? loaded?.config, {}, loaded);
  return [
    '[auth]',
    `  provider: ${resolved.provider} (${resolved.providerSource})`,
    `  profile: ${resolved.profile} (${resolved.profileSource})`,
    `  model: ${resolved.model} (${resolved.modelSource})`,
    `  baseUrl: ${withoutSecret(resolved.baseUrl)} (${resolved.baseUrlSource})`,
    `  apiKey: ${resolved.apiKey ? `configured via ${resolved.apiKeySource}` : 'missing'}`,
    `  safetyMode: ${resolved.safetyMode} (${resolved.safetyModeSource})`,
    `  approvalPolicy: ${resolved.approvalPolicy} (${resolved.approvalPolicySource})`,
    `  trustedTools: ${resolved.trustedTools.length ? resolved.trustedTools.join(', ') : 'none'} (${resolved.trustedToolsSource})`,
    `  promptCache: ${resolved.promptCacheEnabled ? 'enabled' : 'disabled'} (${resolved.promptCacheSource})`,
    `  promptCacheDebug: ${resolved.promptCacheDebug ? 'enabled' : 'disabled'} (${resolved.promptCacheDebugSource})`,
    `  guardrails: ${guardrailSummary(resolved)}`,
    `  maxAgentTurns: ${resolved.maxAgentTurns} (${resolved.maxAgentTurnsSource})`,
    `  contextTokens: ${resolved.contextTokens} (${resolved.contextTokensSource})`,
    `  compaction: reserve ${resolved.compactionSettings.reserveTokens}, keepRecent ${resolved.compactionSettings.keepRecentTokens} (${resolved.compactionSettingsSource})`,
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
    '  dmoss config',
    '  dmoss config show',
    '  dmoss config show --json',
    '  dmoss config set <profile|provider|model|baseUrl|safetyMode|approvalPolicy|trustedTools|promptCache|promptCacheDebug|agent.maxTurns|agent.contextTokens|agent.compaction.reserveTokens|agent.compaction.keepRecentTokens> <value>',
    '  dmoss config set --project <key> <value>',
    '',
    'Config file:',
    '  dmoss reads .dmoss/config.json from the current workspace as project defaults',
    '  dmoss --config-file /path/to/config.json config show',
    '  set DMOSS_CONFIG_FILE=/path/to/config.json to use an explicit config file',
    '',
    'Examples:',
    '  dmoss config set profile autonomous',
    '  dmoss config set --project safetyMode workspace-write',
    '  dmoss config set approvalPolicy prompt',
    '  dmoss config set trustedTools exec,write_file',
    '  dmoss config set agent.maxTurns 96',
    '  dmoss config set agent.contextTokens 200000',
    '  dmoss config set agent.compaction.reserveTokens 20000',
  ].join('\n');
}

export function runConfigShow(startDir = process.cwd(), options: { json?: boolean } = {}): void {
  if (options.json) {
    standardOutput.write(`${renderConfigJson(undefined, process.env, startDir)}\n`);
    return;
  }
  print(renderAuthStatus(undefined, process.env, startDir));
}

export async function runSetupWizard(): Promise<void> {
  const current = loadConfigFile();
  print('D-Moss model setup');
  print('');
  print('Choose provider:');
  print('  1. Aliyun / Qwen (recommended for RDK users)');
  print('  2. OpenAI');
  print('  3. Anthropic');
  print('  4. OpenAI-compatible');

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
  const baseUrl = sanitizeBaseUrl(baseUrlAnswer || defaultBaseUrl);
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
    apiKey,
    promptCache: current.promptCache ?? { enabled: true, debug: false },
  };
  saveConfigFile(next);
  print('');
  print(`Saved configuration to ${resolveConfigPath()}`);
  print(`Provider: ${preset.displayName}`);
  print(`Model: ${model}`);
  print(`Base URL: ${withoutSecret(baseUrl)}`);
  print('');
  print('Try `dmoss "帮我检查当前目录"` or run `dmoss` for interactive mode.');
}

export async function runAuthLogout(): Promise<void> {
  const current = loadConfigFile();
  if (!current.apiKey) {
    print('[auth] No API key is stored in the config file.');
    return;
  }
  const answer = await question('Remove stored API key from dmoss config? [y/N] ');
  if (!/^y(es)?$/i.test(answer)) {
    print('[auth] Cancelled.');
    return;
  }
  const next = { ...current };
  delete next.apiKey;
  saveConfigFile(next);
  print('[auth] Stored API key removed. Model and baseUrl were preserved.');
}

function resolveConfigSetTarget(args: string[], startDir: string): { args: string[]; configPath: string; scope: 'user' | 'project' } {
  if (args[0] !== '--project') {
    return { args, configPath: resolveConfigPath(), scope: 'user' };
  }
  const root = path.resolve(startDir);
  return {
    args: args.slice(1),
    configPath: resolveProjectConfigPath(root) ?? path.join(root, '.dmoss', 'config.json'),
    scope: 'project',
  };
}

export function runConfigSet(args: string[], startDir = process.cwd()): void {
  const target = resolveConfigSetTarget(args, startDir);
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
  else if (key === 'provider') next.provider = normalizeProvider(value);
  else if (key === 'model') next.model = value;
  else if (key === 'baseUrl') next.baseUrl = sanitizeBaseUrl(value);
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
      next.trustedTools = parseTrustedTools(value) ?? [];
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
    print('Supported keys: profile, provider, model, baseUrl, safetyMode, approvalPolicy, trustedTools, promptCache, promptCacheDebug, agent.maxTurns, agent.contextTokens, agent.compaction.reserveTokens, agent.compaction.keepRecentTokens');
    process.exitCode = 1;
    return;
  }
  saveConfigFileAtPath(next, target.configPath);
  const scope = target.scope === 'project' ? 'project ' : '';
  print(`[config] ${scope}${key} updated in ${target.configPath}`);
}

export function printMissingConfigGuidance(interactive: boolean): void {
  print('D-Moss needs a model configuration before it can run.');
  print('');
  print('Fast path:');
  print('  dmoss setup');
  print('');
  print('Script/env path:');
  print('  export DMOSS_API_KEY=your-key');
  print('  export DMOSS_MODEL=qwen3.7-max');
  print('  export DMOSS_BASE_URL=https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode');
  print('');
  if (interactive) {
    print('You can run setup now, then start `dmoss` again.');
  } else {
    print('One-shot mode does not prompt, so scripts do not hang.');
  }
}

export async function offerSetupForInteractiveMissingConfig(): Promise<void> {
  printMissingConfigGuidance(true);
  const answer = await question('Start setup now? [Y/n] ');
  if (!answer || /^y(es)?$/i.test(answer)) {
    await runSetupWizard();
  } else {
    print('Setup skipped. Run `dmoss setup` when you are ready.');
    process.exitCode = 1;
  }
}
