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
  profile?: CliConfigProfile | string;
  provider?: CliProviderPreset | string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  workspace?: string;
  safetyMode?: CliSafetyModeConfig | string;
  approvalPolicy?: ConfigApprovalPolicy | string;
  trustedTools?: string[];
  promptCache?: PromptCacheConfig | boolean;
}

export type CliConfigProfile = 'cautious' | 'balanced' | 'autonomous';
export type CliSafetyModeConfig = 'read-only' | 'workspace-write' | 'full-access';
export type ConfigApprovalPolicy = 'prompt' | 'never';

export interface PromptCacheConfig {
  enabled?: boolean;
  debug?: boolean;
}

export interface CliConfigOverrides {
  profile?: CliConfigProfile;
  provider?: CliProviderPreset | string;
  model?: string;
  baseUrl?: string;
  workspace?: string;
  safetyMode?: CliSafetyModeConfig;
  approvalPolicy?: ConfigApprovalPolicy;
  trustedTools?: string[];
  promptCacheEnabled?: boolean;
  promptCacheDebug?: boolean;
}

export interface CliProfileDefaults {
  safetyMode: CliSafetyModeConfig;
  approvalPolicy: ConfigApprovalPolicy;
  trustedTools: string[];
  promptCacheEnabled: boolean;
  promptCacheDebug: boolean;
}

export const CLI_PROFILE_DEFAULTS: Record<CliConfigProfile, CliProfileDefaults> = {
  cautious: {
    safetyMode: 'read-only',
    approvalPolicy: 'prompt',
    trustedTools: [],
    promptCacheEnabled: true,
    promptCacheDebug: false,
  },
  balanced: {
    safetyMode: 'workspace-write',
    approvalPolicy: 'prompt',
    trustedTools: [],
    promptCacheEnabled: true,
    promptCacheDebug: false,
  },
  autonomous: {
    safetyMode: 'workspace-write',
    approvalPolicy: 'never',
    trustedTools: ['exec', 'apply_patch'],
    promptCacheEnabled: true,
    promptCacheDebug: false,
  },
};

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

export function normalizeConfigProfile(value: string | undefined): CliConfigProfile | null {
  const raw = (value || '').toLowerCase().trim();
  if (raw === 'cautious' || raw === 'safe' || raw === 'readonly') return 'cautious';
  if (raw === 'balanced' || raw === 'default' || raw === 'codex') return 'balanced';
  if (raw === 'autonomous' || raw === 'auto' || raw === 'agentic') return 'autonomous';
  return null;
}

function parseConfigProfile(value: string | undefined, source: string): CliConfigProfile | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const profile = normalizeConfigProfile(value);
  if (!profile) {
    throw new Error(`Unsupported ${source} profile "${value}". Supported profiles: cautious, balanced, autonomous`);
  }
  return profile;
}

export function normalizeSafetyModeConfig(value: string | undefined): CliSafetyModeConfig | null {
  const raw = (value || '').toLowerCase().trim();
  if (raw === 'read-only' || raw === 'readonly' || raw === 'untrusted') return 'read-only';
  if (raw === 'workspace-write' || raw === 'workspace' || raw === 'write' || raw === 'on-request') return 'workspace-write';
  if (raw === 'full-access' || raw === 'full' || raw === 'danger-full-access') return 'full-access';
  return null;
}

export function normalizeApprovalPolicyConfig(value: string | undefined): ConfigApprovalPolicy | null {
  const raw = (value || '').toLowerCase().trim();
  if (raw === 'never' || raw === 'auto' || raw === 'auto-approve') return 'never';
  if (raw === 'prompt' || raw === 'ask' || raw === 'on-request') return 'prompt';
  return null;
}

export function parseConfigBoolean(value: string | undefined): boolean | null {
  const raw = (value || '').toLowerCase().trim();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on' || raw === 'enabled') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off' || raw === 'disabled') return false;
  return null;
}

export function parseTrustedTools(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const rawValues = Array.isArray(value) ? value : value.split(',');
  const tools = rawValues
    .map((tool) => tool.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const tool of tools) {
    if (!/^[A-Za-z0-9_.:/-]+$/.test(tool)) {
      throw new Error(`Unsupported trusted tool name "${tool}"`);
    }
    if (!seen.has(tool)) {
      seen.add(tool);
      unique.push(tool);
    }
  }
  return unique.length > 0 ? unique : undefined;
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
  profile: CliConfigProfile;
  profileSource: string;
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
  safetyMode: CliSafetyModeConfig;
  safetyModeSource: string;
  approvalPolicy: ConfigApprovalPolicy;
  approvalPolicySource: string;
  trustedTools: string[];
  trustedToolsSource: string;
  promptCacheEnabled: boolean;
  promptCacheSource: string;
  promptCacheDebug: boolean;
  promptCacheDebugSource: string;
  configPath: string;
}

export function resolveCliConfig(
  env: NodeJS.ProcessEnv = process.env,
  config: ConfigFile = loadConfigFile(),
  overrides: CliConfigOverrides = {},
): ResolvedCliConfig {
  const profileEnv = env.DMOSS_PROFILE || env.DMOSS_CONFIG_PROFILE;
  const configProfile = parseConfigProfile(
    typeof config.profile === 'string' ? config.profile : undefined,
    'config',
  );
  const envProfile = parseConfigProfile(profileEnv, env.DMOSS_PROFILE ? 'DMOSS_PROFILE' : 'DMOSS_CONFIG_PROFILE');
  const profile = overrides.profile ?? envProfile ?? configProfile ?? 'balanced';
  const profileSource = overrides.profile
    ? 'cli'
    : envProfile
      ? (env.DMOSS_PROFILE ? 'DMOSS_PROFILE' : 'DMOSS_CONFIG_PROFILE')
      : configProfile
        ? 'config'
        : 'default';
  const profileDefaults = CLI_PROFILE_DEFAULTS[profile];

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
  const safetyModeEnv = env.DMOSS_SAFETY_MODE || env.DMOSS_CLI_SAFETY_MODE;
  const configSafetyMode = normalizeSafetyModeConfig(
    typeof config.safetyMode === 'string' ? config.safetyMode : undefined,
  );
  const envSafetyMode = normalizeSafetyModeConfig(safetyModeEnv);
  const safetyMode = overrides.safetyMode || envSafetyMode || configSafetyMode || profileDefaults.safetyMode;
  const safetyModeSource = overrides.safetyMode
    ? 'cli'
    : envSafetyMode
      ? (env.DMOSS_SAFETY_MODE ? 'DMOSS_SAFETY_MODE' : 'DMOSS_CLI_SAFETY_MODE')
      : configSafetyMode
        ? 'config'
        : `profile:${profile}`;

  const approvalEnv = env.DMOSS_CLI_AUTO_APPROVE === '1' || env.DMOSS_AUTO_APPROVE === '1'
    ? 'never'
    : (env.DMOSS_APPROVAL_POLICY || env.DMOSS_ASK_FOR_APPROVAL);
  const configApproval = normalizeApprovalPolicyConfig(
    typeof config.approvalPolicy === 'string' ? config.approvalPolicy : undefined,
  );
  const envApproval = normalizeApprovalPolicyConfig(approvalEnv);
  const approvalPolicy = overrides.approvalPolicy || envApproval || configApproval || profileDefaults.approvalPolicy;
  const approvalPolicySource = overrides.approvalPolicy
    ? 'cli'
    : envApproval
      ? (env.DMOSS_CLI_AUTO_APPROVE === '1'
          ? 'DMOSS_CLI_AUTO_APPROVE'
          : env.DMOSS_AUTO_APPROVE === '1'
            ? 'DMOSS_AUTO_APPROVE'
            : env.DMOSS_APPROVAL_POLICY
              ? 'DMOSS_APPROVAL_POLICY'
              : 'DMOSS_ASK_FOR_APPROVAL')
      : configApproval
        ? 'config'
        : `profile:${profile}`;

  const envTrustedTools = parseTrustedTools(env.DMOSS_TRUSTED_TOOLS);
  const configTrustedTools = Array.isArray(config.trustedTools)
    ? parseTrustedTools(config.trustedTools)
    : undefined;
  const trustedTools = overrides.trustedTools ?? envTrustedTools ?? configTrustedTools ?? profileDefaults.trustedTools;
  const trustedToolsSource = overrides.trustedTools
    ? 'cli'
    : envTrustedTools
      ? 'DMOSS_TRUSTED_TOOLS'
      : configTrustedTools
        ? 'config'
        : `profile:${profile}`;

  const promptCacheEnv = env.DMOSS_PROMPT_CACHE ?? env.DMOSS_PROMPT_CACHE_ENABLED;
  const envPromptCache = parseConfigBoolean(promptCacheEnv);
  const promptCacheDebugEnv = env.DMOSS_PROMPT_CACHE_DEBUG ?? env.DMOSS_PROMPT_PREFIX_DEBUG;
  const envPromptCacheDebug = parseConfigBoolean(promptCacheDebugEnv);
  const configPromptCache =
    typeof config.promptCache === 'boolean'
      ? config.promptCache
      : config.promptCache && typeof config.promptCache === 'object' && typeof config.promptCache.enabled === 'boolean'
        ? config.promptCache.enabled
        : undefined;
  const configPromptCacheDebug =
    config.promptCache && typeof config.promptCache === 'object' && typeof config.promptCache.debug === 'boolean'
      ? config.promptCache.debug
      : undefined;
  const promptCacheEnabled = overrides.promptCacheEnabled ?? envPromptCache ?? configPromptCache ?? profileDefaults.promptCacheEnabled;
  const promptCacheSource = overrides.promptCacheEnabled !== undefined
    ? 'cli'
    : envPromptCache !== null
      ? (env.DMOSS_PROMPT_CACHE !== undefined ? 'DMOSS_PROMPT_CACHE' : 'DMOSS_PROMPT_CACHE_ENABLED')
      : configPromptCache !== undefined
        ? 'config'
        : `profile:${profile}`;
  const promptCacheDebug = overrides.promptCacheDebug ?? envPromptCacheDebug ?? configPromptCacheDebug ?? profileDefaults.promptCacheDebug;
  const promptCacheDebugSource = overrides.promptCacheDebug !== undefined
    ? 'cli'
    : envPromptCacheDebug !== null
      ? (env.DMOSS_PROMPT_CACHE_DEBUG !== undefined ? 'DMOSS_PROMPT_CACHE_DEBUG' : 'DMOSS_PROMPT_PREFIX_DEBUG')
      : configPromptCacheDebug !== undefined
        ? 'config'
        : `profile:${profile}`;

  return {
    profile,
    profileSource,
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
    safetyMode,
    safetyModeSource,
    approvalPolicy,
    approvalPolicySource,
    trustedTools: [...trustedTools],
    trustedToolsSource,
    promptCacheEnabled,
    promptCacheSource,
    promptCacheDebug,
    promptCacheDebugSource,
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
