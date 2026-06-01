import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL } from '@rdk-moss/core';

export type CliProviderPreset = 'qwen' | 'openai' | 'anthropic' | 'openai-compatible';

export interface ProviderPreset {
  id: CliProviderPreset;
  displayName: string;
  defaultModel: string;
  defaultBaseUrl: string;
  keyEnvVars: string[];
}

export const PROVIDER_PRESETS: Record<CliProviderPreset, ProviderPreset> = {
  qwen: {
    id: 'qwen',
    displayName: 'Aliyun / Qwen',
    defaultModel: 'qwen3.7-max',
    defaultBaseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode',
    keyEnvVars: ['DASHSCOPE_API_KEY', 'ALIYUN_API_KEY'],
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com',
    keyEnvVars: ['OPENAI_API_KEY'],
  },
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic',
    defaultModel: DEFAULT_MODEL,
    defaultBaseUrl: 'https://api.anthropic.com',
    keyEnvVars: ['ANTHROPIC_API_KEY'],
  },
  'openai-compatible': {
    id: 'openai-compatible',
    displayName: 'OpenAI-compatible',
    defaultModel: 'gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com',
    keyEnvVars: ['OPENAI_API_KEY'],
  },
};

export function resolveConfigDir(): string {
  const explicit = process.env.DMOSS_CONFIG_DIR;
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dmoss');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'dmoss');
}

export interface ConfigFile {
  provider?: CliProviderPreset | string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  workspace?: string;
}

export interface CliConfigOverrides {
  provider?: CliProviderPreset | string;
  model?: string;
  baseUrl?: string;
  workspace?: string;
}

export function resolveConfigPath(configDir = resolveConfigDir()): string {
  return path.join(configDir, 'config.json');
}

export function loadConfigFile(): ConfigFile {
  const configPath = resolveConfigPath();
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as ConfigFile;
  } catch {
    return {};
  }
}

export function saveConfigFile(config: ConfigFile, configDir = resolveConfigDir()): void {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const configPath = resolveConfigPath(configDir);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Windows and some filesystems may not support chmod; best effort.
  }
}

export function normalizeProvider(value: string | undefined): CliProviderPreset {
  const raw = (value || '').toLowerCase().trim();
  if (raw === 'qwen' || raw === 'aliyun' || raw === 'dashscope') return 'qwen';
  if (raw === 'openai') return 'openai';
  if (raw === 'anthropic' || raw === 'claude') return 'anthropic';
  if (raw === 'openai-compatible' || raw === 'compatible' || raw === 'custom') {
    return 'openai-compatible';
  }
  return 'anthropic';
}

function inferProviderFromBaseUrl(baseUrl: string | undefined): CliProviderPreset | null {
  const raw = (baseUrl || '').toLowerCase();
  if (!raw) return null;
  if (raw.includes('aliyuncs.com') || raw.includes('dashscope') || raw.includes('token-plan')) {
    return 'qwen';
  }
  if (raw.includes('api.openai.com')) return 'openai';
  if (raw.includes('anthropic.com')) return 'anthropic';
  return 'openai-compatible';
}

function firstEnv(env: NodeJS.ProcessEnv, names: string[]): { value: string; source: string } | null {
  for (const name of names) {
    const value = env[name];
    if (value) return { value, source: name };
  }
  return null;
}

export interface ResolvedCliConfig {
  provider: CliProviderPreset;
  providerSource: string;
  apiKey: string;
  apiKeySource: string;
  model: string;
  modelSource: string;
  baseUrl: string;
  baseUrlSource: string;
  workspace: string;
  workspaceSource: string;
  configPath: string;
}

export function resolveCliConfig(
  env: NodeJS.ProcessEnv = process.env,
  config: ConfigFile = loadConfigFile(),
  overrides: CliConfigOverrides = {},
): ResolvedCliConfig {
  const providerEnv = env.DMOSS_PROVIDER;
  const inferredProvider = inferProviderFromBaseUrl(
    overrides.baseUrl ||
      env.DMOSS_BASE_URL ||
      env.OPENAI_BASE_URL ||
      env.ANTHROPIC_BASE_URL ||
      env.DASHSCOPE_BASE_URL ||
      config.baseUrl,
  );
  const provider = overrides.provider || providerEnv || config.provider
    ? normalizeProvider(overrides.provider || providerEnv || config.provider)
    : inferredProvider || 'anthropic';
  const preset = PROVIDER_PRESETS[provider];
  const providerSource = overrides.provider
    ? 'cli'
    : providerEnv
      ? 'DMOSS_PROVIDER'
      : config.provider
        ? 'config'
        : inferredProvider
          ? 'baseUrl'
          : 'default';

  const apiKeyEnv = firstEnv(env, [
    'DMOSS_API_KEY',
    ...preset.keyEnvVars,
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DASHSCOPE_API_KEY',
    'ALIYUN_API_KEY',
  ]);
  const modelEnv = env.DMOSS_MODEL;
  const baseUrlEnv = firstEnv(env, [
    'DMOSS_BASE_URL',
    'OPENAI_BASE_URL',
    'ANTHROPIC_BASE_URL',
    'DASHSCOPE_BASE_URL',
  ]);
  const workspaceEnv = env.DMOSS_WORKSPACE;

  return {
    provider,
    providerSource,
    apiKey: apiKeyEnv?.value || config.apiKey || '',
    apiKeySource: apiKeyEnv?.source || (config.apiKey ? 'config' : 'missing'),
    model: overrides.model || modelEnv || config.model || preset.defaultModel,
    modelSource: overrides.model ? 'cli' : modelEnv ? 'DMOSS_MODEL' : config.model ? 'config' : 'provider default',
    baseUrl: overrides.baseUrl || baseUrlEnv?.value || config.baseUrl || preset.defaultBaseUrl,
    baseUrlSource: overrides.baseUrl ? 'cli' : baseUrlEnv?.source || (config.baseUrl ? 'config' : 'provider default'),
    workspace: overrides.workspace || workspaceEnv || config.workspace || process.cwd(),
    workspaceSource: overrides.workspace ? 'cli' : workspaceEnv ? 'DMOSS_WORKSPACE' : config.workspace ? 'config' : 'cwd',
    configPath: resolveConfigPath(),
  };
}

export function loadEnvFile(envPath: string): void {
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadEnvFromAncestors(startDir: string, maxHops = 16): void {
  let dir = path.resolve(startDir);
  for (let i = 0; i < maxHops; i++) {
    loadEnvFile(path.join(dir, '.env'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

loadEnvFromAncestors(process.cwd());
loadEnvFromAncestors(path.dirname(fileURLToPath(import.meta.url)));

const configFile = loadConfigFile();
const resolvedConfig = resolveCliConfig(process.env, configFile);

export const PROVIDER = resolvedConfig.provider;
export const API_KEY = resolvedConfig.apiKey;
export const MODEL = resolvedConfig.model;
export const BASE_URL = resolvedConfig.baseUrl;
export const WORKSPACE = resolvedConfig.workspace;
export const CONFIG_PATH = resolvedConfig.configPath;
export const CONFIG_SOURCE = resolvedConfig;
