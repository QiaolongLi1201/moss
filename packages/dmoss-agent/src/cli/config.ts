import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL } from '@rdk-moss/core';
import { DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from '../context/compaction.js';
import { resolveDmossMaxAgentTurns } from '../utils/max-agent-turns.js';

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

export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DMOSS_CONFIG_DIR;
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dmoss');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'dmoss');
}

function readArgvValue(argv: string[], index: number): string | null {
  const arg = argv[index] || '';
  const eqIdx = arg.indexOf('=');
  if (eqIdx !== -1) return arg.slice(eqIdx + 1);
  const next = argv[index + 1];
  return next && !next.startsWith('-') ? next : null;
}

function resolveCliConfigFileArg(argv: string[] = process.argv.slice(2)): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    if (arg === '--config-file' || arg.startsWith('--config-file=')) {
      const value = readArgvValue(argv, i);
      return value && value.trim() ? path.resolve(value) : null;
    }
  }
  return null;
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
  deniedTools?: string[];
  promptCache?: PromptCacheConfig | boolean;
  guardrails?: GuardrailsConfig;
  agent?: AgentRuntimeConfig;
  mcp?: McpCliConfig;
  hooks?: HooksConfig;
}

export interface LoadedCliConfigFile {
  config: ConfigFile;
  configPath: string;
  projectConfigPath?: string;
}

export class CliConfigFileError extends Error {
  readonly configPath: string;

  constructor(configPath: string, reason: string) {
    super(`Invalid dmoss config at ${configPath}: ${reason}`);
    this.name = 'CliConfigFileError';
    this.configPath = configPath;
  }
}

export type CliConfigProfile = 'cautious' | 'balanced' | 'autonomous';
export type CliSafetyModeConfig = 'read-only' | 'workspace-write' | 'full-access';
export type ConfigApprovalPolicy = 'prompt' | 'never';

export interface PromptCacheConfig {
  enabled?: boolean;
  debug?: boolean;
}

export interface TextGuardrailConfig {
  blockPatterns?: string[];
  redactPatterns?: string[];
}

export interface GuardrailsConfig {
  input?: TextGuardrailConfig;
  output?: TextGuardrailConfig;
}

export interface AgentRuntimeConfig {
  maxTurns?: number;
  contextTokens?: number;
  compaction?: Partial<Pick<CompactionSettings, 'reserveTokens' | 'keepRecentTokens'>>;
}

export interface McpCliConfig {
  enabled?: boolean;
  configPath?: string;
}

/**
 * A single user-configured hook: a shell command run on an agent event.
 * The command receives a JSON payload on stdin plus `MOSS_HOOK_EVENT` /
 * `MOSS_TOOL_NAME` / `MOSS_WORKSPACE` env vars.
 */
export interface HookCommandConfig {
  /** Regex (as a string) matched against the tool name. Omit to match every tool. */
  matcher?: string;
  /** Shell command to execute. */
  command: string;
  /** Per-run timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** PreToolUse only: when true (default), a non-zero exit blocks the tool. */
  blocking?: boolean;
}

/** Config-driven hooks that automate workflows around the agent loop. */
export interface HooksConfig {
  /** Run before a matching tool executes; a blocking hook can veto the call. */
  PreToolUse?: HookCommandConfig[];
  /** Run after a matching tool returns (side-effect automation: format, notify, log). */
  PostToolUse?: HookCommandConfig[];
  /** Run once at session start. */
  SessionStart?: HookCommandConfig[];
}

export interface ResolvedTextGuardrailConfig {
  blockPatterns: string[];
  redactPatterns: string[];
}

export interface ResolvedGuardrailsConfig {
  input: ResolvedTextGuardrailConfig;
  output: ResolvedTextGuardrailConfig;
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
  deniedTools?: string[];
  promptCacheEnabled?: boolean;
  promptCacheDebug?: boolean;
  maxAgentTurns?: number;
  contextTokens?: number;
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

function resolveExplicitConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): string | null {
  const fromArgv = resolveCliConfigFileArg(argv);
  if (fromArgv) return fromArgv;
  const explicit = env.DMOSS_CONFIG_FILE || env.DMOSS_CONFIG_PATH;
  return explicit && explicit.trim() ? path.resolve(explicit) : null;
}

function hasExplicitConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): boolean {
  return resolveExplicitConfigPath(env, argv) !== null;
}

export function resolveConfigPath(
  configDir?: string,
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): string {
  if (configDir) return path.join(configDir, 'config.json');
  return resolveExplicitConfigPath(env, argv) || path.join(resolveConfigDir(env), 'config.json');
}

export function resolveProjectConfigPath(startDir = process.cwd(), maxHops = 16): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < maxHops; i++) {
    const candidate = path.join(dir, '.dmoss', 'config.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadConfigFile(configPath = resolveConfigPath()): ConfigFile {
  if (!fs.existsSync(configPath)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliConfigFileError(configPath, message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliConfigFileError(configPath, message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliConfigFileError(configPath, 'expected a JSON object');
  }
  return parsed as ConfigFile;
}

function mergePromptCacheConfig(
  projectPromptCache: ConfigFile['promptCache'],
  userPromptCache: ConfigFile['promptCache'],
): ConfigFile['promptCache'] {
  if (
    projectPromptCache &&
    typeof projectPromptCache === 'object' &&
    userPromptCache &&
    typeof userPromptCache === 'object'
  ) {
    return { ...projectPromptCache, ...userPromptCache };
  }
  return userPromptCache ?? projectPromptCache;
}

function mergeTextGuardrailConfig(
  projectGuardrail: TextGuardrailConfig | undefined,
  userGuardrail: TextGuardrailConfig | undefined,
): TextGuardrailConfig | undefined {
  if (!projectGuardrail && !userGuardrail) return undefined;
  return {
    ...projectGuardrail,
    ...userGuardrail,
  };
}

function mergeGuardrailsConfig(
  projectGuardrails: ConfigFile['guardrails'],
  userGuardrails: ConfigFile['guardrails'],
): ConfigFile['guardrails'] {
  if (!projectGuardrails && !userGuardrails) return undefined;
  return {
    input: mergeTextGuardrailConfig(projectGuardrails?.input, userGuardrails?.input),
    output: mergeTextGuardrailConfig(projectGuardrails?.output, userGuardrails?.output),
  };
}

function mergeAgentRuntimeConfig(
  projectAgent: ConfigFile['agent'],
  userAgent: ConfigFile['agent'],
): ConfigFile['agent'] {
  if (!projectAgent && !userAgent) return undefined;
  return {
    ...projectAgent,
    ...userAgent,
    compaction: {
      ...projectAgent?.compaction,
      ...userAgent?.compaction,
    },
  };
}

function mergeMcpConfig(
  projectMcp: ConfigFile['mcp'],
  userMcp: ConfigFile['mcp'],
): ConfigFile['mcp'] {
  if (!projectMcp && !userMcp) return undefined;
  return {
    ...projectMcp,
    ...userMcp,
  };
}

function mergeHooksConfig(project?: HooksConfig, user?: HooksConfig): HooksConfig | undefined {
  if (!project && !user) return undefined;
  // Project and user hooks both run; project hooks are evaluated first.
  return {
    PreToolUse: [...(project?.PreToolUse ?? []), ...(user?.PreToolUse ?? [])],
    PostToolUse: [...(project?.PostToolUse ?? []), ...(user?.PostToolUse ?? [])],
    SessionStart: [...(project?.SessionStart ?? []), ...(user?.SessionStart ?? [])],
  };
}

export function mergeConfigFiles(projectConfig: ConfigFile, userConfig: ConfigFile): ConfigFile {
  return {
    ...projectConfig,
    ...userConfig,
    promptCache: mergePromptCacheConfig(projectConfig.promptCache, userConfig.promptCache),
    guardrails: mergeGuardrailsConfig(projectConfig.guardrails, userConfig.guardrails),
    agent: mergeAgentRuntimeConfig(projectConfig.agent, userConfig.agent),
    mcp: mergeMcpConfig(projectConfig.mcp, userConfig.mcp),
    hooks: mergeHooksConfig(projectConfig.hooks, userConfig.hooks),
  };
}

export function loadCliConfigFile(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
  startDir = process.cwd(),
): LoadedCliConfigFile {
  const configPath = resolveConfigPath(undefined, env, argv);
  const userConfig = loadConfigFile(configPath);
  if (hasExplicitConfigPath(env, argv)) {
    return { config: userConfig, configPath };
  }

  const projectConfigPath = resolveProjectConfigPath(startDir) ?? undefined;
  if (!projectConfigPath) {
    return { config: userConfig, configPath };
  }
  return {
    config: mergeConfigFiles(loadConfigFile(projectConfigPath), userConfig),
    configPath,
    projectConfigPath,
  };
}

export function saveConfigFileAtPath(config: ConfigFile, configPath: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
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

export function saveConfigFile(config: ConfigFile, configDir?: string): void {
  saveConfigFileAtPath(config, resolveConfigPath(configDir));
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
    if (!/^[A-Za-z0-9_.:/\-*?]+$/.test(tool)) {
      throw new Error(`Unsupported trusted tool name "${tool}"`);
    }
    if (!seen.has(tool)) {
      seen.add(tool);
      unique.push(tool);
    }
  }
  return unique.length > 0 ? unique : undefined;
}

function parsePatternList(value: unknown, source: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Unsupported ${source}; expected an array of strings`);
  }
  const patterns = value
    .map((pattern) => (typeof pattern === 'string' ? pattern.trim() : ''))
    .filter(Boolean);
  for (const pattern of patterns) {
    if (pattern.length > 500) {
      throw new Error(`Unsupported ${source} pattern: values must be 500 characters or less`);
    }
  }
  return [...new Set(patterns)];
}

export function normalizeGuardrailsConfig(config: ConfigFile['guardrails']): ResolvedGuardrailsConfig {
  return {
    input: {
      blockPatterns: parsePatternList(config?.input?.blockPatterns, 'guardrails.input.blockPatterns'),
      redactPatterns: parsePatternList(config?.input?.redactPatterns, 'guardrails.input.redactPatterns'),
    },
    output: {
      blockPatterns: parsePatternList(config?.output?.blockPatterns, 'guardrails.output.blockPatterns'),
      redactPatterns: parsePatternList(config?.output?.redactPatterns, 'guardrails.output.redactPatterns'),
    },
  };
}

function hasGuardrails(config: ResolvedGuardrailsConfig): boolean {
  return config.input.blockPatterns.length > 0 ||
    config.input.redactPatterns.length > 0 ||
    config.output.blockPatterns.length > 0 ||
    config.output.redactPatterns.length > 0;
}

function parsePositiveInteger(value: unknown, source: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Unsupported ${source}; expected a positive integer`);
  }
  return value;
}

function parsePositiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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

function resolveMcpConfigPath(
  mcpPath: string | undefined,
  source: 'env' | 'config' | 'default',
  configPaths: Pick<LoadedCliConfigFile, 'configPath' | 'projectConfigPath'> | undefined,
  env: NodeJS.ProcessEnv,
): string {
  if (mcpPath && path.isAbsolute(mcpPath)) return mcpPath;
  if (source === 'env' && mcpPath) return path.resolve(mcpPath);

  const configPath = configPaths?.configPath ?? resolveConfigPath(undefined, env);
  if (source === 'config' && mcpPath) {
    const baseDir = configPaths?.projectConfigPath
      ? path.dirname(path.dirname(configPaths.projectConfigPath))
      : path.dirname(configPath);
    return path.resolve(baseDir, mcpPath);
  }

  return path.join(path.dirname(configPath), 'mcp.json');
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
  deniedTools: string[];
  deniedToolsSource: string;
  promptCacheEnabled: boolean;
  promptCacheSource: string;
  promptCacheDebug: boolean;
  promptCacheDebugSource: string;
  guardrails: ResolvedGuardrailsConfig;
  guardrailsSource: string;
  maxAgentTurns: number;
  maxAgentTurnsSource: string;
  contextTokens: number;
  contextTokensSource: string;
  compactionSettings: Pick<CompactionSettings, 'reserveTokens' | 'keepRecentTokens'>;
  compactionSettingsSource: string;
  mcpEnabled: boolean;
  mcpEnabledSource: string;
  mcpConfigPath: string;
  mcpConfigPathSource: string;
  configPath: string;
  projectConfigPath?: string;
}

export type CliConfigAuditSeverity = 'warn';

export interface CliConfigAuditWarning {
  code: string;
  severity: CliConfigAuditSeverity;
  source: string;
  message: string;
}

function hasToolPatternWildcard(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

export function isBroadTrustedToolPattern(pattern: string): boolean {
  const compact = pattern.trim();
  if (compact === '*' || compact === '**') return true;
  if (compact === '*_*' || compact === '*__*') return true;
  if (compact.endsWith('_*') && !compact.endsWith('__*')) return true;
  return false;
}

function findConflictingToolPatterns(trustedTools: readonly string[], deniedTools: readonly string[]): string[] {
  const denied = new Set(deniedTools);
  return trustedTools.filter((pattern) => denied.has(pattern));
}

export function auditResolvedCliConfig(config: Pick<
  ResolvedCliConfig,
  | 'approvalPolicy'
  | 'approvalPolicySource'
  | 'safetyMode'
  | 'safetyModeSource'
  | 'trustedTools'
  | 'trustedToolsSource'
  | 'deniedTools'
  | 'deniedToolsSource'
>): CliConfigAuditWarning[] {
  const warnings: CliConfigAuditWarning[] = [];
  if (config.approvalPolicy === 'never') {
    warnings.push({
      code: 'approval.auto_approval',
      severity: 'warn',
      source: config.approvalPolicySource,
      message: `auto-approval is enabled via ${config.approvalPolicySource}; keep deniedTools current for risky tools`,
    });
    if (config.deniedTools.length === 0) {
      warnings.push({
        code: 'approval.no_denied_tools',
        severity: 'warn',
        source: config.deniedToolsSource,
        message: `auto-approval has no deniedTools guardrail (${config.deniedToolsSource}); add high-risk tools or globs to deniedTools`,
      });
    }
  }

  if (config.safetyMode === 'full-access' && config.approvalPolicy === 'never') {
    warnings.push({
      code: 'approval.full_access_auto_approval',
      severity: 'warn',
      source: `${config.safetyModeSource}, ${config.approvalPolicySource}`,
      message: `full-access safety and auto-approval are both enabled; prefer workspace-write or prompt approval unless the workspace is fully trusted`,
    });
  }

  const conflictingPatterns = findConflictingToolPatterns(config.trustedTools, config.deniedTools);
  if (conflictingPatterns.length > 0) {
    warnings.push({
      code: 'approval.conflicting_tool_patterns',
      severity: 'warn',
      source: `${config.trustedToolsSource}, ${config.deniedToolsSource}`,
      message: `trustedTools also appear in deniedTools: ${conflictingPatterns.join(', ')}; deniedTools takes precedence`,
    });
  }

  const broadTrustedPatterns = config.trustedTools.filter(isBroadTrustedToolPattern);
  if (broadTrustedPatterns.length > 0) {
    warnings.push({
      code: 'trustedTools.broad_patterns',
      severity: 'warn',
      source: config.trustedToolsSource,
      message: `broad trusted pattern(s): ${broadTrustedPatterns.join(', ')}; prefer exact tool names or narrow server__tool globs`,
    });
  }

  return warnings;
}

export function hasTrustedToolWildcard(config: Pick<ResolvedCliConfig, 'trustedTools'>): boolean {
  return config.trustedTools.some(hasToolPatternWildcard);
}

export function resolveCliConfig(
  env: NodeJS.ProcessEnv = process.env,
  config?: ConfigFile,
  overrides: CliConfigOverrides = {},
  loadedConfig?: Pick<LoadedCliConfigFile, 'configPath' | 'projectConfigPath'>,
): ResolvedCliConfig {
  const defaultLoadedConfig = config === undefined ? loadCliConfigFile(env) : undefined;
  const activeConfig = config ?? defaultLoadedConfig?.config ?? {};
  const configPaths = loadedConfig ?? defaultLoadedConfig;
  const profileEnv = env.DMOSS_PROFILE || env.DMOSS_CONFIG_PROFILE;
  const configProfile = parseConfigProfile(
    typeof activeConfig.profile === 'string' ? activeConfig.profile : undefined,
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
      activeConfig.baseUrl,
  );
  const provider = overrides.provider || providerEnv || activeConfig.provider
    ? normalizeProvider(overrides.provider || providerEnv || activeConfig.provider)
    : inferredProvider || 'anthropic';
  const preset = PROVIDER_PRESETS[provider];
  const providerSource = overrides.provider
    ? 'cli'
    : providerEnv
      ? 'DMOSS_PROVIDER'
      : activeConfig.provider
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
    typeof activeConfig.safetyMode === 'string' ? activeConfig.safetyMode : undefined,
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
    typeof activeConfig.approvalPolicy === 'string' ? activeConfig.approvalPolicy : undefined,
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
  const configTrustedTools = Array.isArray(activeConfig.trustedTools)
    ? parseTrustedTools(activeConfig.trustedTools)
    : undefined;
  const trustedTools = overrides.trustedTools ?? envTrustedTools ?? configTrustedTools ?? profileDefaults.trustedTools;
  const trustedToolsSource = overrides.trustedTools
    ? 'cli'
    : envTrustedTools
      ? 'DMOSS_TRUSTED_TOOLS'
      : configTrustedTools
        ? 'config'
        : `profile:${profile}`;
  const envDeniedTools = parseTrustedTools(env.DMOSS_DENIED_TOOLS);
  const configDeniedTools = Array.isArray(activeConfig.deniedTools)
    ? parseTrustedTools(activeConfig.deniedTools)
    : undefined;
  const deniedTools = overrides.deniedTools ?? envDeniedTools ?? configDeniedTools ?? [];
  const deniedToolsSource = overrides.deniedTools
    ? 'cli'
    : envDeniedTools
      ? 'DMOSS_DENIED_TOOLS'
      : configDeniedTools
        ? 'config'
        : 'default';

  const promptCacheEnv = env.DMOSS_PROMPT_CACHE ?? env.DMOSS_PROMPT_CACHE_ENABLED;
  const envPromptCache = parseConfigBoolean(promptCacheEnv);
  const promptCacheDebugEnv = env.DMOSS_PROMPT_CACHE_DEBUG ?? env.DMOSS_PROMPT_PREFIX_DEBUG;
  const envPromptCacheDebug = parseConfigBoolean(promptCacheDebugEnv);
  const configPromptCache =
    typeof activeConfig.promptCache === 'boolean'
      ? activeConfig.promptCache
      : activeConfig.promptCache && typeof activeConfig.promptCache === 'object' && typeof activeConfig.promptCache.enabled === 'boolean'
        ? activeConfig.promptCache.enabled
        : undefined;
  const configPromptCacheDebug =
    activeConfig.promptCache && typeof activeConfig.promptCache === 'object' && typeof activeConfig.promptCache.debug === 'boolean'
      ? activeConfig.promptCache.debug
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
  const guardrails = normalizeGuardrailsConfig(activeConfig.guardrails);
  const guardrailsSource = hasGuardrails(guardrails) ? 'config' : 'default';
  const configMaxAgentTurns = parsePositiveInteger(activeConfig.agent?.maxTurns, 'agent.maxTurns');
  const envMaxAgentTurns = parsePositiveIntegerEnv(env.DMOSS_MAX_AGENT_TURNS);
  const maxAgentTurns = resolveDmossMaxAgentTurns(String(overrides.maxAgentTurns ?? envMaxAgentTurns ?? configMaxAgentTurns ?? ''));
  const maxAgentTurnsSource = overrides.maxAgentTurns !== undefined
    ? 'cli'
    : envMaxAgentTurns !== undefined
      ? 'DMOSS_MAX_AGENT_TURNS'
      : configMaxAgentTurns !== undefined
        ? 'config'
        : 'default';
  const configContextTokens = parsePositiveInteger(activeConfig.agent?.contextTokens, 'agent.contextTokens');
  const envContextTokens = parsePositiveIntegerEnv(env.DMOSS_CONTEXT_TOKENS);
  const contextTokens = overrides.contextTokens ?? envContextTokens ?? configContextTokens ?? 200_000;
  const contextTokensSource = overrides.contextTokens !== undefined
    ? 'cli'
    : envContextTokens !== undefined
      ? 'DMOSS_CONTEXT_TOKENS'
      : configContextTokens !== undefined
        ? 'config'
        : 'default';
  const configCompactionReserve = parsePositiveInteger(
    activeConfig.agent?.compaction?.reserveTokens,
    'agent.compaction.reserveTokens',
  );
  const configCompactionKeepRecent = parsePositiveInteger(
    activeConfig.agent?.compaction?.keepRecentTokens,
    'agent.compaction.keepRecentTokens',
  );
  const compactionSettings = {
    reserveTokens: configCompactionReserve ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    keepRecentTokens: configCompactionKeepRecent ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
  };
  const compactionSettingsSource =
    configCompactionReserve !== undefined || configCompactionKeepRecent !== undefined ? 'config' : 'default';
  const mcpEnabledEnv = parseConfigBoolean(env.DMOSS_MCP_ENABLED);
  const configMcpEnabled =
    activeConfig.mcp && typeof activeConfig.mcp === 'object' && typeof activeConfig.mcp.enabled === 'boolean'
      ? activeConfig.mcp.enabled
      : undefined;
  const mcpEnabled = mcpEnabledEnv ?? configMcpEnabled ?? false;
  const mcpEnabledSource = mcpEnabledEnv !== null
    ? 'DMOSS_MCP_ENABLED'
    : configMcpEnabled !== undefined
      ? 'config'
      : 'default';
  const configMcpPath =
    activeConfig.mcp && typeof activeConfig.mcp === 'object' && typeof activeConfig.mcp.configPath === 'string'
      ? activeConfig.mcp.configPath
      : undefined;
  const envMcpPath = env.DMOSS_MCP_CONFIG || env.DMOSS_MCP_CONFIG_FILE;
  const mcpConfigPathSource = envMcpPath
    ? (env.DMOSS_MCP_CONFIG ? 'DMOSS_MCP_CONFIG' : 'DMOSS_MCP_CONFIG_FILE')
    : configMcpPath
      ? 'config'
      : 'default';
  const mcpConfigPath = resolveMcpConfigPath(
    envMcpPath || configMcpPath,
    envMcpPath ? 'env' : configMcpPath ? 'config' : 'default',
    configPaths,
    env,
  );

  return {
    profile,
    profileSource,
    provider,
    providerSource,
    apiKey: apiKeyEnv?.value || activeConfig.apiKey || '',
    apiKeySource: apiKeyEnv?.source || (activeConfig.apiKey ? 'config' : 'missing'),
    model: overrides.model || modelEnv || activeConfig.model || preset.defaultModel,
    modelSource: overrides.model ? 'cli' : modelEnv ? 'DMOSS_MODEL' : activeConfig.model ? 'config' : 'provider default',
    baseUrl: overrides.baseUrl || baseUrlEnv?.value || activeConfig.baseUrl || preset.defaultBaseUrl,
    baseUrlSource: overrides.baseUrl ? 'cli' : baseUrlEnv?.source || (activeConfig.baseUrl ? 'config' : 'provider default'),
    workspace: overrides.workspace || workspaceEnv || activeConfig.workspace || process.cwd(),
    workspaceSource: overrides.workspace ? 'cli' : workspaceEnv ? 'DMOSS_WORKSPACE' : activeConfig.workspace ? 'config' : 'cwd',
    safetyMode,
    safetyModeSource,
    approvalPolicy,
    approvalPolicySource,
    trustedTools: [...trustedTools],
    trustedToolsSource,
    deniedTools: [...deniedTools],
    deniedToolsSource,
    promptCacheEnabled,
    promptCacheSource,
    promptCacheDebug,
    promptCacheDebugSource,
    guardrails,
    guardrailsSource,
    maxAgentTurns,
    maxAgentTurnsSource,
    contextTokens,
    contextTokensSource,
    compactionSettings,
    compactionSettingsSource,
    mcpEnabled,
    mcpEnabledSource,
    mcpConfigPath,
    mcpConfigPathSource,
    configPath: configPaths?.configPath ?? resolveConfigPath(undefined, env),
    projectConfigPath: configPaths?.projectConfigPath,
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

function loadResolvedConfigForModuleDefaults(): ResolvedCliConfig {
  try {
    const loadedConfigFile = loadCliConfigFile();
    return resolveCliConfig(process.env, loadedConfigFile.config, {}, loadedConfigFile);
  } catch {
    const configPath = resolveConfigPath();
    return resolveCliConfig(process.env, {}, {}, { configPath });
  }
}

const resolvedConfig = loadResolvedConfigForModuleDefaults();

export const PROVIDER = resolvedConfig.provider;
export const API_KEY = resolvedConfig.apiKey;
export const MODEL = resolvedConfig.model;
export const BASE_URL = resolvedConfig.baseUrl;
export const WORKSPACE = resolvedConfig.workspace;
export const CONFIG_PATH = resolvedConfig.configPath;
export const CONFIG_SOURCE = resolvedConfig;
