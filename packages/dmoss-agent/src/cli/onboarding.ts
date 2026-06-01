import fs from 'node:fs';
import path from 'node:path';
import type { DmossAgent } from '../core/index.js';
import type { Tool } from '../core/tools/tool-types.js';
import { BASE_URL, resolveCliConfig, resolveConfigDir, WORKSPACE, type ResolvedCliConfig } from './config.js';
import { resolveCliDetailMode, type CliDetailMode } from './output.js';
import { getPackageVersion } from './package-info.js';
import { compactPath, label, statusDot, ui } from './ui.js';

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
}

interface ToolGroupSummary {
  id: string;
  title: string;
  enabled: boolean;
  tools: Tool[];
}

const DEFAULT_RUNTIME: Required<Omit<CliRuntimeStatus, 'device' | 'dockerImage'>> & {
  dockerImage?: string;
  device: CliDeviceStatus | null;
} = {
  workspace: WORKSPACE,
  runtimeDir: path.join(WORKSPACE, '.dmoss-runtime'),
  configDir: resolveConfigDir(),
  baseUrl: BASE_URL,
  execBackend: process.env.DMOSS_EXEC_BACKEND || 'local',
  safetyMode: process.env.DMOSS_SAFETY_MODE || process.env.DMOSS_CLI_SAFETY_MODE || 'workspace-write',
  dockerImage: process.env.DMOSS_DOCKER_IMAGE,
  meshEnabled: process.env.DMOSS_MESH_ENABLED === 'true' || process.argv.includes('--mesh'),
  sessionKey: 'cli',
  config: resolveCliConfig(),
  device: null,
};

function runtimeWithDefaults(runtime: CliRuntimeStatus = {}) {
  return { ...DEFAULT_RUNTIME, ...runtime };
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

function oneLine(value: string, maxChars = 96): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1).trimEnd()}...`;
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
  if (tool.name === 'create_subagent') return 'agent';
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

function formatEnabledGroups(groups: ToolGroupSummary[]): string {
  return groups
    .map((g) => `${g.title.toLowerCase()} ${g.tools.length}`)
    .join('  ');
}

export function renderCliWelcome(agent: DmossAgent, runtime: CliRuntimeStatus = {}): string {
  const rt = runtimeWithDefaults(runtime);
  const detailMode = resolveCliDetailMode();
  const tools = agent.tools.getAll();
  const groups = groupTools(tools).filter((g) => g.enabled);
  const memoryCount = countJsonIndex(path.join(rt.runtimeDir, 'memory', 'index.json'));
  const skillCount = countMarkdownFiles(path.join(rt.workspace, 'skills', 'learned'));
  const auth = rt.config;

  const authState = auth.apiKey ? `auth ${auth.apiKeySource}` : 'auth missing';
  const deviceState = rt.device
    ? `device ${rt.device.user || 'root'}@${rt.device.host}:${rt.device.port || 22}`
    : 'device not configured';
  const meshState = rt.meshEnabled ? 'mesh on' : 'mesh off';

  return [
    `${ui.bold('D-Moss Agent')} ${ui.dim(`v${getPackageVersion()}`)}`,
    `${label('model')} ${agent.config.model}   ${label('provider')} ${shortBaseUrl(rt.baseUrl)}   ${label('session')} ${rt.sessionKey}`,
    `${label('workspace')} ${compactPath(rt.workspace)}   ${label('safety')} ${rt.safetyMode}   ${label('detail')} ${describeDetail(detailMode)}`,
    `${statusDot(auth.apiKey ? 'ok' : 'warn')} ${authState}   ${statusDot('info')} tools ${tools.length}   ${statusDot('info')} memory ${memoryCount}   ${statusDot('info')} skills ${skillCount}`,
    `${statusDot(rt.device ? 'ok' : 'warn')} ${deviceState}   ${statusDot(rt.meshEnabled ? 'ok' : 'info')} ${meshState}`,
    groups.length ? `${label('capabilities')} ${formatEnabledGroups(groups)}` : `${label('capabilities')} none`,
    `${ui.dim('commands')} /help  /tools  /status  /examples  /model  /detail`,
  ].join('\n');
}

export function renderCliStatus(agent: DmossAgent, runtime: CliRuntimeStatus = {}): string {
  const rt = runtimeWithDefaults(runtime);
  const memoryCount = countJsonIndex(path.join(rt.runtimeDir, 'memory', 'index.json'));
  const skillCount = countMarkdownFiles(path.join(rt.workspace, 'skills', 'learned'));
  const sessionDir = path.join(rt.runtimeDir, 'sessions');
  const detailMode = resolveCliDetailMode();
  const toolGroups = groupTools(agent.tools.getAll()).filter((g) => g.enabled);
  const auth = rt.config;

  return [
    ui.bold('Status'),
    `  ${label('session')} ${rt.sessionKey}`,
    `  ${label('model')} ${agent.config.model}`,
    `  ${label('provider')} ${auth.provider} (${auth.providerSource}) via ${shortBaseUrl(rt.baseUrl)}`,
    `  ${label('api key')} ${auth.apiKey ? `configured via ${auth.apiKeySource}` : 'missing'}`,
    `  ${label('workspace')} ${rt.workspace}`,
    `  ${label('config')} ${rt.configDir}`,
    `  ${label('sessions')} ${sessionDir}`,
    `  ${label('detail')} ${describeDetail(detailMode)}`,
    `  ${label('safety')} ${rt.safetyMode}`,
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
  const lines = [ui.bold('Tools')];
  for (const group of groups) {
    lines.push(`  ${ui.bold(group.title)}`);
    for (const tool of group.tools.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`    ${ui.cyan(tool.name)} ${ui.dim(oneLine(tool.description))}`);
    }
  }
  lines.push('');
  lines.push(`${ui.dim('tip')} /detail verbose shows redacted tool inputs and outputs during a run.`);
  return lines.join('\n');
}

export function renderCliExamples(agent: DmossAgent, runtime: CliRuntimeStatus = {}): string {
  const rt = runtimeWithDefaults(runtime);
  const toolNames = new Set(agent.tools.getNames());
  const examples = [
    '分析当前工程结构，指出最重要的入口文件和下一步建议',
    '读取 README 并总结这个项目如何启动',
  ];

  if (toolNames.has('exec')) {
    examples.push('运行测试或构建前，先检查 package.json 里有哪些脚本');
  }
  if (rt.device && toolNames.has('device_resources')) {
    examples.push('检查板端 CPU、内存、温度和进程状态，判断是否有异常');
  } else if (!rt.device) {
    examples.push('连接板端：设置 DMOSS_DEVICE_HOST 后重启，再运行 /status 查看设备工具');
  }
  if (rt.device && toolNames.has('ros2_topic_list')) {
    examples.push('列出板端 ROS2 topic，并帮我判断相机或感知节点是否在线');
  }
  if (toolNames.has('mesh_list_peers')) {
    examples.push('列出 mesh peer，看看有没有其他 agent 可以协作');
  }

  return [ui.bold('Examples'), ...examples.slice(0, 6).map((e) => `  - ${e}`)].join('\n');
}

export function renderCliInteractiveHelp(): string {
  return [
    ui.bold('Commands'),
    '  Inspect',
    '    /tools               show registered tools grouped by capability',
    '    /status              show model, workspace, runtime, device, and tool state',
    '    /examples            show prompts matched to enabled capabilities',
    '    /memory              show stored long-term memories',
    '    /skills              list learned SKILL.md files',
    '  Configure',
    '    /detail              explain current output detail mode',
    '    /detail quiet        hide progress and tool lifecycle',
    '    /detail progress     show thinking markers and tool lifecycle (default)',
    '    /detail verbose      show redacted/truncated tool inputs and results',
    '    /model <name>        switch model for this session',
    '    /models              show model examples',
    '    /upgrade             show install/update commands',
    '  Session',
    '    /help                show this help',
    '    /quit                exit',
  ].join('\n');
}

export function renderCliUpgradeHelp(): string {
  return [
    ui.bold('Upgrade'),
    '  Built-in update:',
    '    dmoss-agent update',
    '    dmoss-agent doctor',
    '',
    '  Global install:',
    '    npm i -g @rdk-moss/agent@latest',
    '    dmoss-agent --version',
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
