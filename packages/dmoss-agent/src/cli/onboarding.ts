import fs from 'node:fs';
import path from 'node:path';
import type { DmossAgent } from '../core/index.js';
import type { Tool } from '../core/tools/tool-types.js';
import { formatCommunityAuthStatus, type DmossCommunityAuthRuntime } from './community-auth.js';
import { auditResolvedCliConfig, BASE_URL, resolveCliConfig, resolveConfigDir, resolveConfigPath, WORKSPACE, type ResolvedCliConfig } from './config.js';
import { formatInteractiveCommandSections } from './interactive-commands.js';
import { resolveCliDetailMode, type CliDetailMode } from './output.js';
import { getPackageVersion } from './package-info.js';
import { compactPath, label, ui } from './ui.js';

export interface CliDeviceStatus {
  host: string;
  user?: string;
  port?: number;
}

export interface CliRuntimeStatus {
  workspace?: string;
  runtimeDir?: string;
  configDir?: string;
  baseUrl?: string;
  execBackend?: string;
  safetyMode?: string;
  dockerImage?: string;
  meshEnabled?: boolean;
  device?: CliDeviceStatus | null;
  sessionKey?: string;
  config?: ResolvedCliConfig;
  communityAuth?: DmossCommunityAuthRuntime;
}

interface ToolGroupSummary {
  id: string;
  title: string;
  enabled: boolean;
  tools: Tool[];
}

function loadDefaultRuntimeConfig(): ResolvedCliConfig {
  try {
    return resolveCliConfig();
  } catch {
    return resolveCliConfig(process.env, {}, {}, { configPath: resolveConfigPath() });
  }
}

const DEFAULT_RUNTIME: Required<Omit<CliRuntimeStatus, 'device' | 'dockerImage' | 'communityAuth'>> & {
  dockerImage?: string;
  device: CliDeviceStatus | null;
  communityAuth?: DmossCommunityAuthRuntime;
} = {
  workspace: WORKSPACE,
  runtimeDir: path.join(WORKSPACE, '.moss'),
  configDir: resolveConfigDir(),
  baseUrl: BASE_URL,
  execBackend: process.env.DMOSS_EXEC_BACKEND || 'local',
  safetyMode: process.env.DMOSS_SAFETY_MODE || process.env.DMOSS_CLI_SAFETY_MODE || 'workspace-write',
  dockerImage: process.env.DMOSS_DOCKER_IMAGE,
  meshEnabled: process.env.DMOSS_MESH_ENABLED === 'true' || process.argv.includes('--mesh'),
  sessionKey: 'cli',
  config: loadDefaultRuntimeConfig(),
  communityAuth: undefined,
  device: null,
};

function runtimeWithDefaults(runtime: CliRuntimeStatus = {}) {
  return { ...DEFAULT_RUNTIME, ...runtime };
}

function guardrailLine(config: ResolvedCliConfig): string {
  const inputCount = (config.guardrails?.input?.blockPatterns?.length ?? 0) + (config.guardrails?.input?.redactPatterns?.length ?? 0);
  const outputCount = (config.guardrails?.output?.blockPatterns?.length ?? 0) + (config.guardrails?.output?.redactPatterns?.length ?? 0);
  if (inputCount === 0 && outputCount === 0) return 'guardrails off';
  return `guardrails in ${inputCount} out ${outputCount}`;
}

function configWarningLines(config: ResolvedCliConfig): string[] {
  const warnings = auditResolvedCliConfig(config);
  if (warnings.length === 0) return [`  ${label('config warnings')} none`];
  return [
    `  ${label('config warnings')} ${warnings.length}`,
    ...warnings.map((warning) => `    ${warning.code}: ${warning.message}`),
  ];
}

function countJsonIndex(filePath: string): number {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function countMarkdownFiles(dirPath: string): number {
  try {
    return fs.readdirSync(dirPath).filter((f) => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

function shortBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.host;
  } catch {
    return value || '(not configured)';
  }
}

function describeDetail(mode: CliDetailMode): string {
  if (mode === 'quiet') return 'quiet';
  if (mode === 'verbose') return 'verbose';
  return 'progress';
}

function classifyTool(tool: Tool): string {
  if (tool.name.startsWith('memory_')) return 'memory';
  if (tool.name.startsWith('device_')) return 'device';
  if (tool.name.startsWith('ros2_')) return 'ros2';
  if (tool.name.startsWith('mesh_')) return 'mesh';
  if (tool.name === 'exec') return 'workspace';
  if (
    tool.name === 'read_file' ||
    tool.name === 'write_file' ||
    tool.name === 'apply_patch' ||
    tool.name === 'list_directory' ||
    tool.name === 'search_files' ||
    tool.name === 'search_code'
  ) {
    return 'workspace';
  }
  if (
    tool.name === 'create_subagent' ||
    tool.name === 'subagent_status' ||
    tool.name === 'subagent_stop'
  ) {
    return 'agent';
  }
  return 'other';
}

function groupTools(tools: Tool[]): ToolGroupSummary[] {
  const groups: ToolGroupSummary[] = [
    { id: 'workspace', title: 'Workspace', enabled: false, tools: [] },
    { id: 'memory', title: 'Memory', enabled: false, tools: [] },
    { id: 'device', title: 'Device SSH', enabled: false, tools: [] },
    { id: 'ros2', title: 'ROS2/TROS', enabled: false, tools: [] },
    { id: 'mesh', title: 'Agent Mesh', enabled: false, tools: [] },
    { id: 'agent', title: 'Sub-agents', enabled: false, tools: [] },
    { id: 'other', title: 'Other', enabled: false, tools: [] },
  ];
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const tool of tools) {
    const group = byId.get(classifyTool(tool)) ?? byId.get('other');
    if (!group) continue;
    group.tools.push(tool);
    group.enabled = true;
  }
  return groups;
}

export function renderCliWelcome(agent: DmossAgent, runtime: CliRuntimeStatus = {}): string {
  const rt = runtimeWithDefaults(runtime);
  const auth = rt.config;
  const community = rt.communityAuth?.getStatus();
  const providerState = auth.usingBundledDefault ? 'built-in D-Robotics model' : auth.provider;
  const loginState = community?.authenticated
    ? formatCommunityAuthStatus(community)
    : auth.usingBundledDefault
      ? 'optional; /auth login links community'
      : auth.apiKey ? 'own provider configured' : 'model key missing';
  const deviceState = rt.device
    ? `${rt.device.user || 'root'}@${rt.device.host}:${rt.device.port || 22}`
    : 'not connected';

  return [
    `${ui.bold('Moss Agent')} ${ui.dim(`v${getPackageVersion()}`)}`,
    `${label('model')} ${agent.config.model} (${providerState})`,
    `${label('workspace')} ${compactPath(rt.workspace)}`,
    `${label('login')} ${loginState}`,
    `${label('board')} ${deviceState}`,
    `${ui.dim('next')} /quickstart, /model, or moss setup for your own model`,
  ].join('\n');
}

export function renderCliQuickStart(agent: DmossAgent, runtime: CliRuntimeStatus = {}): string {
  const rt = runtimeWithDefaults(runtime);
  const auth = rt.config;
  const toolNames = new Set(agent.tools.getNames());
  const apiKeyState = auth.usingBundledDefault
    ? 'built-in model (no model key required)'
    : auth.apiKey ? `configured via ${auth.apiKeySource}` : 'missing';
  const examples = [
    'Analyze this project structure and point out the key entry files and next steps',
    toolNames.has('exec') ? 'Check which scripts package.json defines, then suggest one command to verify the project' : null,
    rt.device && toolNames.has('device_resources')
      ? 'Check the board CPU, memory, temperature and processes, and flag anything abnormal'
      : 'Connect a board: /connect <board-ip> (uses DMOSS_DEVICE_USER/PASSWORD/KEY/PORT if set)',
    rt.device && toolNames.has('ros2_topic_list')
      ? 'List the ROS2 topics on the board and tell me whether the camera or perception nodes are online'
      : null,
  ].filter(Boolean) as string[];

  return [
    ui.bold('Quick start'),
    '',
    `  ${label('1/3 Model')} ${agent.config.model} · provider ${auth.usingBundledDefault ? 'built-in D-Robotics model' : auth.provider} · api key ${apiKeyState}`,
    auth.usingBundledDefault
      ? '      Built-in D-Robotics model is ready without a model API key or forced login. Optional: `/auth login` links a community session; `moss setup` uses your own provider.'
      : auth.apiKey
        ? '      Change it anytime: run `moss setup` (interactive), or `/model` to choose a model for this session.'
        : '      Configure it: run `moss setup` — choose a provider, choose a model, and paste your API key.',
    '      Model settings live in moss config only — env vars (DEEPSEEK_API_KEY, DMOSS_PROVIDER, ...) are ignored.',
    '      Image input: OpenAI/Anthropic default on; OpenAI-compatible/DeepSeek/Qwen default off. Set DMOSS_IMAGE_INPUT=true for vision-capable gateways.',
    `      Settings are saved to ${compactPath(auth.configPath)} — inspect them with /config.`,
    '',
    `  ${label('2/3 Workspace')} ${compactPath(rt.workspace)} · safety ${rt.safetyMode}`,
    '      The workspace is the folder you launch Moss in — cd into your project first, then run `moss`.',
    '      Set it without moving: `moss config set workspace /path/to/project`. See the full picture with /status.',
    '      Control what Moss may change: `moss config set safetyMode read-only|workspace-write|full-access` (or /config).',
    rt.device
      ? `      Board connected: ${rt.device.user || 'root'}@${rt.device.host}:${rt.device.port || 22} — device and ROS tools are on.`
      : '      /connect <board-ip> enables board and ROS tools for this session. Use env vars for credentials: DMOSS_DEVICE_USER/PASSWORD/KEY/PORT.',
    '',
    `  ${label('3/3 Try')} ask for an outcome in plain language — Moss chooses the tools automatically:`,
    ...examples.slice(0, 4).map((example) => `      - ${example}`),
    '',
    `  ${label('Customize')} drop an AGENTS.md in your workspace (or run /init) — it is auto-loaded into every session as your project's system prompt (build/test commands, layout, conventions).`,
  ].join('\n');
}

export function renderCliStatus(
  agent: DmossAgent,
  runtime: CliRuntimeStatus = {},
  options: { verbose?: boolean } = {},
): string {
  const rt = runtimeWithDefaults(runtime);
  const memoryCount = countJsonIndex(path.join(rt.runtimeDir, 'memory', 'index.json'));
  const skillCount = countMarkdownFiles(path.join(rt.workspace, '.moss', 'skills', 'learned'));
  const sessionDir = path.join(rt.runtimeDir, 'sessions');
  const detailMode = resolveCliDetailMode();
  const toolGroups = groupTools(agent.tools.getAll()).filter((g) => g.enabled);
  const auth = rt.config;
  const community = rt.communityAuth?.getStatus();
  if (!options.verbose) {
    return [
      ui.bold('Status'),
      `  ${label('model')} ${agent.config.model} (${auth.usingBundledDefault ? 'built-in D-Robotics model' : auth.provider})`,
      `  ${label('login')} ${community ? formatCommunityAuthStatus(community) : 'unknown'}`,
      `  ${label('workspace')} ${rt.workspace}`,
      `  ${label('board')} ${rt.device ? `${rt.device.user || 'root'}@${rt.device.host}:${rt.device.port || 22}` : 'not connected'}`,
      `  ${label('tools')} ${agent.tools.size} (${toolGroups.map((g) => g.title).join(', ') || 'none'})`,
      `  ${label('memory')} ${memoryCount} entries`,
      `  ${label('skills')} ${skillCount}`,
      `  ${label('setup')} moss setup · /model · /quickstart`,
      '',
      '  Details: /status --verbose',
    ].join('\n');
  }

  return [
    ui.bold('Status'),
    `  ${label('session')} ${rt.sessionKey}`,
    `  ${label('model')} ${agent.config.model}`,
    `  ${label('provider')} ${auth.usingBundledDefault ? 'built-in D-Robotics model' : `${auth.provider} (${auth.providerSource}) via ${shortBaseUrl(rt.baseUrl)}`}`,
    `  ${label('community')} ${community ? formatCommunityAuthStatus(community) : 'unknown'}`,
    `  ${label('profile')} ${auth.profile ?? 'balanced'} (${auth.profileSource ?? 'default'})`,
    `  ${label('api key')} ${auth.usingBundledDefault ? 'built-in model (hidden)' : auth.apiKey ? `configured via ${auth.apiKeySource}` : 'missing'}`,
    `  ${label('image input')} ${auth.imageInput ? 'enabled' : 'disabled'} (${auth.imageInputSource})`,
    `  ${label('workspace')} ${rt.workspace}`,
    `  ${label('config')} ${rt.configDir}`,
    `  ${label('sessions')} ${sessionDir}`,
    `  ${label('detail')} ${describeDetail(detailMode)}`,
    `  ${label('safety')} ${rt.safetyMode}`,
    `  ${label('approval')} ${auth.approvalPolicy ?? 'prompt'} (${auth.approvalPolicySource ?? 'default'})`,
    `  ${label('trusted tools')} ${(auth.trustedTools ?? []).length ? (auth.trustedTools ?? []).join(', ') : 'none'} (${auth.trustedToolsSource ?? 'default'})`,
    `  ${label('denied tools')} ${(auth.deniedTools ?? []).length ? (auth.deniedTools ?? []).join(', ') : 'none'} (${auth.deniedToolsSource ?? 'default'})`,
    `  ${label('prompt cache')} ${auth.promptCacheEnabled === false ? 'disabled' : 'enabled'} (${auth.promptCacheSource ?? 'default'})`,
    `  ${label('prompt cache debug')} ${auth.promptCacheDebug === true ? 'enabled' : 'disabled'} (${auth.promptCacheDebugSource ?? 'default'})`,
    `  ${label('guardrails')} ${guardrailLine(auth)} (${auth.guardrailsSource ?? 'default'})`,
    `  ${label('max turns')} ${auth.maxAgentTurns} (${auth.maxAgentTurnsSource ?? 'default'})`,
    `  ${label('context tokens')} ${auth.contextTokens} (${auth.contextTokensSource ?? 'default'})`,
    `  ${label('compaction')} reserve ${auth.compactionSettings?.reserveTokens ?? 20000}, keepRecent ${auth.compactionSettings?.keepRecentTokens ?? 20000} (${auth.compactionSettingsSource ?? 'default'})`,
    `  ${label('exec')} ${rt.execBackend}${rt.execBackend === 'docker' && rt.dockerImage ? ` (${rt.dockerImage})` : ''}`,
    `  ${label('memory')} ${memoryCount} entries`,
    `  ${label('skills')} ${skillCount}`,
    `  ${label('tools')} ${agent.tools.size} (${toolGroups.map((g) => g.title).join(', ')})`,
    `  ${label('device')} ${rt.device ? `${rt.device.user || 'root'}@${rt.device.host}:${rt.device.port || 22}` : 'not connected'}`,
    `  ${label('mesh')} ${rt.meshEnabled ? 'enabled' : 'disabled'}`,
  ].join('\n');
}

export function renderCliTools(agent: DmossAgent): string {
  const groups = groupTools(agent.tools.getAll()).filter((g) => g.enabled);
  const capabilityLine = groups.length
    ? groups.map((group) => `${group.title.toLowerCase()} ${group.tools.length}`).join(' · ')
    : 'none detected';
  return [
    ui.bold('Tools run automatically'),
    `  ${label('capabilities')} ${capabilityLine}`,
    '  Ask for the outcome, not the tool name:',
    '    - read README and tell me how to start this project',
    '    - run the smallest relevant test and explain the failure',
    '    - check the board resources and ROS topics',
    '',
    '  Useful controls:',
    '    /quickstart        configure model, workspace, board, and first tasks',
    '    /status            view model, workspace, device, and capabilities',
    '    Ctrl+V / paste path attach copied images, Finder files, or file paths',
    '    /compact           compress older conversation history into a summary',
    '    /detail verbose    show redacted tool inputs and results',
  ].join('\n');
}

export function renderCliPermissions(runtime: CliRuntimeStatus = {}): string {
  const rt = runtimeWithDefaults(runtime);
  const auth = rt.config;
  const safety = auth.safetyMode ?? rt.safetyMode;
  const approval = auth.approvalPolicy ?? 'prompt';
  const configuredTrustedTools = auth.trustedTools ?? [];
  const trustedTools = configuredTrustedTools.length ? configuredTrustedTools.join(', ') : 'none';
  const configuredDeniedTools = auth.deniedTools ?? [];
  const deniedTools = configuredDeniedTools.length ? configuredDeniedTools.join(', ') : 'none';
  const cache = auth.promptCacheEnabled === false ? 'disabled' : 'enabled';
  const cacheDebug = auth.promptCacheDebug === true ? 'enabled' : 'disabled';
  const imageInput = auth.imageInput === true ? 'enabled' : 'disabled';
  const mcp = auth.mcpEnabled === true ? 'enabled' : 'disabled';
  // Host-embedded TUIs may pass a partial config; never crash the session
  // over missing optional sections.
  const guardrails = auth.guardrails ?? {
    input: { blockPatterns: [], redactPatterns: [] },
    output: { blockPatterns: [], redactPatterns: [] },
  };
  const inputGuardrails = (guardrails.input?.blockPatterns?.length ?? 0) + (guardrails.input?.redactPatterns?.length ?? 0);
  const outputGuardrails = (guardrails.output?.blockPatterns?.length ?? 0) + (guardrails.output?.redactPatterns?.length ?? 0);
  const compaction = auth.compactionSettings ?? { reserveTokens: 20000, keepRecentTokens: 20000 };
  return [
    ui.bold('Permissions & Config'),
    `  ${label('config file')} ${auth.configPath}`,
    `  ${label('profile')} ${auth.profile ?? 'balanced'} (${auth.profileSource ?? 'default'})`,
    `  ${label('workspace')} ${auth.workspace} (${auth.workspaceSource})`,
    `  ${label('safety')} ${safety} (${auth.safetyModeSource ?? 'default'})`,
    `  ${label('approval')} ${approval} (${auth.approvalPolicySource ?? 'default'})`,
    `  ${label('trusted tools')} ${trustedTools} (${auth.trustedToolsSource ?? 'default'})`,
    `  ${label('denied tools')} ${deniedTools} (${auth.deniedToolsSource ?? 'default'})`,
    `  ${label('prompt cache')} ${cache} (${auth.promptCacheSource ?? 'default'})`,
    `  ${label('prompt cache debug')} ${cacheDebug} (${auth.promptCacheDebugSource ?? 'default'})`,
    `  ${label('image input')} ${imageInput} (${auth.imageInputSource ?? 'provider default'})`,
    `  ${label('mcp')} ${mcp} (${auth.mcpEnabledSource ?? 'default'})`,
    `  ${label('mcp config')} ${auth.mcpConfigPath} (${auth.mcpConfigPathSource ?? 'default'})`,
    `  ${label('guardrails')} input ${inputGuardrails}, output ${outputGuardrails} (${auth.guardrailsSource ?? 'default'})`,
    `  ${label('max turns')} ${auth.maxAgentTurns} (${auth.maxAgentTurnsSource ?? 'default'})`,
    `  ${label('context tokens')} ${auth.contextTokens} (${auth.contextTokensSource ?? 'default'})`,
    `  ${label('compaction')} reserve ${compaction.reserveTokens}, keepRecent ${compaction.keepRecentTokens} (${auth.compactionSettingsSource ?? 'default'})`,
    ...configWarningLines(auth),
    '',
    '  Profiles:',
    '    cautious        read-only, prompt approvals, stable prompt cache',
    '    balanced        workspace-write, prompt approvals, stable prompt cache',
    '    autonomous      workspace-write, auto approvals, trusts exec/apply_patch, stable prompt cache',
    '',
    '  Safety modes:',
    '    read-only        allow reads/search/status only; block mutations',
    '    workspace-write  allow workspace/runtime writes; block broader side effects',
    '    full-access      allow all declared tool side-effect classes',
    '',
    '  Approval policies:',
    '    prompt           ask before side-effectful tools',
    '    prompt + a       trust the approved tool for the current session',
    '    never            auto-approve allowed side-effectful tools',
    '',
    '  Persist changes:',
    '    moss config init --project',
    '    moss setup',
    '    moss config set provider deepseek|qwen|openai|anthropic|openai-compatible',
    '    moss config set model <your-model>',
    '    moss config set baseUrl https://your-gateway.example/v1',
    '    moss config set imageInput true|false',
    '    moss config set profile cautious|balanced|autonomous',
    '    moss config set --project safetyMode workspace-write',
    '    moss config set workspace /path/to/workspace',
    '    moss config set safetyMode read-only|workspace-write|full-access',
    '    moss config set approvalPolicy prompt|never',
    '    moss config set trustedTools exec,filesystem__*',
    '    moss config set deniedTools device_*,write_file',
    '    moss config set promptCache true|false',
    '    moss config set promptCacheDebug true|false',
    '    moss config set mcp.enabled true|false',
    '    moss config set mcp.configPath .moss/mcp.json',
    '    edit guardrails.input/output blockPatterns or redactPatterns in config JSON',
    '    moss config set agent.maxTurns 96',
    '    moss config set agent.contextTokens 200000',
    '    moss config set agent.compaction.reserveTokens 20000',
    '    moss config unset --project safetyMode',
    '    moss config unset approvalPolicy',
    '',
    '  Environment overrides (model settings are config-only; provider/model/key/baseUrl env vars are ignored):',
    '    DMOSS_IMAGE_INPUT, DMOSS_PROFILE, DMOSS_SAFETY_MODE, DMOSS_APPROVAL_POLICY, DMOSS_TRUSTED_TOOLS, DMOSS_PROMPT_CACHE, DMOSS_PROMPT_CACHE_DEBUG, DMOSS_MCP_ENABLED, DMOSS_MCP_CONFIG, DMOSS_MAX_AGENT_TURNS, DMOSS_CONTEXT_TOKENS',
  ].join('\n');
}

export function renderCliExamples(agent: DmossAgent, runtime: CliRuntimeStatus = {}): string {
  const rt = runtimeWithDefaults(runtime);
  const toolNames = new Set(agent.tools.getNames());
  const examples = [
    'Analyze this project structure and point out the key entry files and next steps',
    'Read the README and summarize how to start this project',
  ];

  if (toolNames.has('exec')) {
    examples.push('Before running tests or a build, check which scripts package.json defines');
  }
  if (rt.device && toolNames.has('device_resources')) {
    examples.push('Check the board CPU, memory, temperature and processes, and flag anything abnormal');
  } else if (!rt.device) {
    examples.push('Connect a board: /connect <board-ip>, then run /status to see the device tools');
  }
  if (rt.device && toolNames.has('ros2_topic_list')) {
    examples.push('List the ROS2 topics on the board and help me tell whether the camera or perception nodes are online');
  }
  if (toolNames.has('mesh_list_peers')) {
    examples.push('List the mesh peers to see whether other agents are available to collaborate');
  }

  return [ui.bold('Examples'), ...examples.slice(0, 6).map((e) => `  - ${e}`)].join('\n');
}

export function renderCliInteractiveHelp(): string {
  return [
    ui.bold('Commands'),
    ...formatInteractiveCommandSections({ indent: '    ', commandWidth: 24 }),
    '',
    '  Shortcuts',
    '    Ctrl+V                   attach a copied image, Finder file, or file path in the full TUI',
    '    Esc                      stop the active run in the full TUI',
    '    Ctrl+O                   expand/collapse tool calls in the full TUI',
    '    Ctrl+C                   exit',
    '',
    '  Advanced commands still work when needed: /status --verbose, /context, /cost, /rewind, /permissions, /tools, /memory, /skills, /upgrade, /detail, /queue.',
  ].join('\n');
}

export function renderCliUpgradeHelp(): string {
  return [
    ui.bold('Upgrade'),
    '  Built-in update:',
    '    moss update',
    '    moss doctor',
    '',
  '  Global install:',
    '    npm i -g @rdk-moss/agent@latest',
    '    moss --version',
    '',
    '  Without global install:',
    '    npx -y @rdk-moss/agent@latest',
    '',
    '  From this repository:',
    '    npm install',
    '    npm run build -w @rdk-moss/agent',
    '    node packages/dmoss-agent/dist/cli.js --version',
  ].join('\n');
}

export function renderCliDetailHelp(): string {
  return [
    `${ui.bold('Detail')} current: ${describeDetail(resolveCliDetailMode())}`,
    '  quiet    final answers only; useful for scripts',
    '  progress thinking markers, tool names, status, and elapsed time; safe default',
    '  verbose  redacted/truncated tool inputs and results for debugging',
    '  raw thinking is hidden unless DMOSS_SHOW_THINKING=true is explicitly set',
  ].join('\n');
}
