import fs from 'node:fs';
import * as readline from 'node:readline';
import { stdin as input, stderr as output } from 'node:process';
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
  saveConfigFile,
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
    `  config: ${resolved.configPath}`,
    `  projectConfig: ${resolved.projectConfigPath || 'none'}`,
  ].join('\n');
}

export function renderConfigUsage(): string {
  return [
    'Usage:',
    '  dmoss config',
    '  dmoss config show',
    '  dmoss config set <profile|provider|model|baseUrl|safetyMode|approvalPolicy|trustedTools|promptCache|promptCacheDebug> <value>',
    '',
    'Config file:',
    '  dmoss reads .dmoss/config.json from the current workspace as project defaults',
    '  dmoss --config-file /path/to/config.json config show',
    '  set DMOSS_CONFIG_FILE=/path/to/config.json to use an explicit config file',
    '',
    'Examples:',
    '  dmoss config set profile autonomous',
    '  dmoss config set approvalPolicy prompt',
    '  dmoss config set trustedTools exec,write_file',
  ].join('\n');
}

export function runConfigShow(startDir = process.cwd()): void {
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

export function runConfigSet(args: string[]): void {
  const [key, ...rest] = args;
  const value = rest.join(' ').trim();
  if (!key || !value) {
    print(renderConfigUsage());
    process.exitCode = 1;
    return;
  }
  const current = loadConfigFile();
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
  }
  else {
    print('Supported keys: profile, provider, model, baseUrl, safetyMode, approvalPolicy, trustedTools, promptCache, promptCacheDebug');
    process.exitCode = 1;
    return;
  }
  saveConfigFile(next);
  print(`[config] ${key} updated in ${resolveConfigPath()}`);
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
