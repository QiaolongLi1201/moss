#!/usr/bin/env node
/**
 * D-Moss Agent CLI — standalone command-line agent.
 *
 * Usage:
 *   npx dmoss-agent                    # interactive mode
 *   npx dmoss-agent "check disk usage" # one-shot mode
 *   echo "list files" | npx dmoss-agent # piped mode
 *
 * Configuration (in priority order):
 *   1. Environment variables (DMOSS_API_KEY, DMOSS_MODEL, DMOSS_BASE_URL, DMOSS_WORKSPACE)
 *   2. Config file: ~/.dmoss/config.json
 *   3. Ancestor .env files (walks up from cwd)
 *   4. Built-in defaults
 *
 * Fallback environment variables (OpenAI compat):
 *   OPENAI_API_KEY, OPENAI_BASE_URL
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';
import { DmossAgent, JsonlSessionStore, MemoryManager } from './core/index.js';
import { configureRootLogger, type LogLevel } from './logger.js';
import pc from 'picocolors';

/**
 * 是否启用颜色化输出。默认启用；`--no-color` / `NO_COLOR` / `DMOSS_NO_COLOR=1` 禁用；
 * 非 TTY 环境（管道/日志文件）自动关闭避免 ANSI 污染。
 */
const colorEnabled = (() => {
  if (process.argv.includes('--no-color')) return false;
  if (process.env.NO_COLOR || process.env.DMOSS_NO_COLOR === '1') return false;
  if (!process.stderr.isTTY && !process.stdout.isTTY) return false;
  return true;
})();

const c = {
  bold: (s: string) => (colorEnabled ? pc.bold(s) : s),
  dim: (s: string) => (colorEnabled ? pc.dim(s) : s),
  red: (s: string) => (colorEnabled ? pc.red(s) : s),
  green: (s: string) => (colorEnabled ? pc.green(s) : s),
  yellow: (s: string) => (colorEnabled ? pc.yellow(s) : s),
  blue: (s: string) => (colorEnabled ? pc.blue(s) : s),
  cyan: (s: string) => (colorEnabled ? pc.cyan(s) : s),
  magenta: (s: string) => (colorEnabled ? pc.magenta(s) : s),
  gray: (s: string) => (colorEnabled ? pc.gray(s) : s),
};
import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMContentBlock,
} from './core/llm-provider.js';
import type { Tool } from './core/tool-types.js';
import { registerBuiltinTools } from './tools/builtin.js';
import { validateMemoryWriteContent } from './core/memory.js';
import { SkillLearner } from './core/skill-learner.js';
import { WorkspaceMemory } from './core/workspace-memory.js';
import { createDockerExecTool } from './tools/docker-exec.js';
import { createDeviceSshTools, getDeviceConfigFromEnv } from './tools/device-ssh.js';
import { createDeviceDiagnosticsTools } from './tools/device-diagnostics.js';
import { createRos2Tools } from './tools/device-ros2.js';
import { AgentMesh, createMeshTools, isMeshVerboseEnabled } from './mesh/agent-mesh.js';
import { LanDiscovery } from './mesh/lan-discovery.js';

/** When false (default), suppress [tool] / [learned] stderr noise. Set DMOSS_VERBOSE_TOOLS=true to show. */
function dmossVerboseTools(): boolean {
  return process.env.DMOSS_VERBOSE_TOOLS === 'true' || process.env.DMOSS_VERBOSE_CLI === 'true';
}

// ---------------------------------------------------------------------------
// Cross-platform config directory
// ---------------------------------------------------------------------------

function resolveConfigDir(): string {
  const explicit = process.env.DMOSS_CONFIG_DIR;
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dmoss');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'dmoss');
}

interface ConfigFile {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  workspace?: string;
}

function loadConfigFile(): ConfigFile {
  const configPath = path.join(resolveConfigDir(), 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as ConfigFile;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// .env loader (ancestor walk — no external dependency)
// ---------------------------------------------------------------------------

function loadEnvFile(envPath: string): void {
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

function loadEnvFromAncestors(startDir: string, maxHops = 16): void {
  let dir = path.resolve(startDir);
  for (let i = 0; i < maxHops; i++) {
    loadEnvFile(path.join(dir, '.env'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Resolve configuration: env > config file > .env ancestors > defaults
// ---------------------------------------------------------------------------

loadEnvFromAncestors(process.cwd());
loadEnvFromAncestors(path.dirname(fileURLToPath(import.meta.url)));

const configFile = loadConfigFile();

const API_KEY = process.env.DMOSS_API_KEY || process.env.OPENAI_API_KEY || configFile.apiKey || '';
const MODEL = process.env.DMOSS_MODEL || configFile.model || 'claude-sonnet-4-20250514';
const BASE_URL =
  process.env.DMOSS_BASE_URL ||
  process.env.OPENAI_BASE_URL ||
  configFile.baseUrl ||
  'https://api.anthropic.com';
const WORKSPACE = process.env.DMOSS_WORKSPACE || configFile.workspace || process.cwd();

// ---------------------------------------------------------------------------
// --help / --version fast path
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

/**
 * 解析日志级别 flag（优先级：CLI flag > env > 默认 info）
 *   --debug     → debug（所有级别）
 *   --quiet     → warn（只显示警告和错误）
 *   --log-level=<level>  → 精确指定
 *   DMOSS_LOG_LEVEL 环境变量   → 次优先级
 *   默认                     → info
 *
 * --json        → 以 JSON 行输出（便于日志聚合/grep）
 *
 * 对齐 docs/logging.md 规范；与 server 端共享同一套 logger 行为。
 */
function resolveCliLogLevel(): LogLevel {
  if (argv.includes('--debug')) return 'debug';
  if (argv.includes('--quiet')) return 'warn';
  const explicit = argv.find((a) => a.startsWith('--log-level='));
  if (explicit) {
    const v = explicit.slice('--log-level='.length).toLowerCase() as LogLevel;
    if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
  }
  const env = (process.env.DMOSS_LOG_LEVEL ?? '').toLowerCase() as LogLevel;
  if (env === 'debug' || env === 'info' || env === 'warn' || env === 'error') return env;
  return 'info';
}

configureRootLogger({
  scope: 'dmoss-agent',
  level: resolveCliLogLevel(),
  json: argv.includes('--json') || process.env.DMOSS_LOG_JSON === '1',
});

if (argv.includes('--help') || argv.includes('-h')) {
  const configDir = resolveConfigDir();
  const lines = [
    '',
    `  ${c.bold(c.cyan('dmoss-agent'))}  ${c.dim('— standalone agent for robotics & edge devices')}`,
    '',
    `  ${c.bold('Quick start')}`,
    `    ${c.cyan('$')} dmoss-agent                      ${c.dim('# interactive REPL')}`,
    `    ${c.cyan('$')} dmoss-agent "check disk usage"   ${c.dim('# one-shot mode')}`,
    `    ${c.cyan('$')} echo "list files" | dmoss-agent  ${c.dim('# piped stdin')}`,
    '',
    `  ${c.bold('Interactive commands')}`,
    `    ${c.green('/model')} ${c.dim('<name>')}    switch LLM model (e.g. /model gpt-4o)`,
    `    ${c.green('/models')}          list suggested model names`,
    `    ${c.green('/memory')}          show stored long-term memories`,
    `    ${c.green('/skills')}          list learned SKILL.md entries`,
    `    ${c.green('/quit')}            exit`,
    '',
    `  ${c.bold('Flags')}`,
    `    ${c.yellow('--debug')}              verbose logging (level=debug)`,
    `    ${c.yellow('--quiet')}              only warnings & errors (level=warn)`,
    `    ${c.yellow('--log-level=')}${c.dim('<lv>')}   debug | info | warn | error`,
    `    ${c.yellow('--json')}               emit logs as JSON lines (log aggregators)`,
    `    ${c.yellow('--no-color')}           disable ANSI colors`,
    `    ${c.yellow('--help, -h')}           show this help`,
    `    ${c.yellow('--version, -v')}        show version`,
    '',
    `  ${c.bold('Environment')}`,
    `    ${c.magenta('DMOSS_API_KEY')}           ${c.dim('LLM API key (required)')}`,
    `    ${c.magenta('DMOSS_MODEL')}             ${c.dim('model name (default: claude-sonnet-4-20250514)')}`,
    `    ${c.magenta('DMOSS_BASE_URL')}          ${c.dim('LLM API base URL')}`,
    `    ${c.magenta('DMOSS_WORKSPACE')}         ${c.dim('working directory (default: cwd)')}`,
    `    ${c.magenta('DMOSS_EXEC_BACKEND')}      ${c.dim('local (default) or docker')}`,
    `    ${c.magenta('DMOSS_DOCKER_IMAGE')}      ${c.dim('docker image (default: node:20-slim)')}`,
    `    ${c.magenta('DMOSS_DEVICE_HOST')}       ${c.dim('device IP/hostname (enables SSH tools)')}`,
    `    ${c.magenta('DMOSS_DEVICE_USER')}       ${c.dim('device SSH user (default: root)')}`,
    `    ${c.magenta('DMOSS_DEVICE_PASSWORD')}   ${c.dim('device SSH password')}`,
    `    ${c.magenta('DMOSS_DEVICE_PORT')}       ${c.dim('device SSH port (default: 22)')}`,
    `    ${c.magenta('DMOSS_DEVICE_KEY')}        ${c.dim('path to SSH private key')}`,
    `    ${c.magenta('DMOSS_LOG_LEVEL')}         ${c.dim('overrides default log level')}`,
    `    ${c.magenta('DMOSS_LOG_JSON')}          ${c.dim('=1 → JSON log lines')}`,
    '',
    `  ${c.bold('Config file')}`,
    `    ${c.gray(path.join(configDir, 'config.json'))}`,
    '',
    `  ${c.bold('Built-in features')}`,
    `    ${c.green('✓')} Session persistence (JSONL) with ${c.cyan('--resume')}-style recovery`,
    `    ${c.green('✓')} Long-term memory (memory_read / write / delete)`,
    `    ${c.green('✓')} Workspace context (USER.md, MEMORY.md, AGENTS.md auto-loaded)`,
    `    ${c.green('✓')} Skill learning — successful runs crystallize into SKILL.md`,
    `    ${c.green('✓')} Docker sandbox (${c.yellow('DMOSS_EXEC_BACKEND=docker')})`,
    `    ${c.green('✓')} ${c.cyan('LAN Agent Mesh')} — P2P discovery via UDP broadcast`,
    `    ${c.green('✓')} Framework-level tool-call self-healing (stream-error resilient)`,
    '',
    `  ${c.bold('Device & robotics tools')}`,
    `    ${c.blue('device_exec')} · ${c.blue('device_info')} · ${c.blue('device_file_read')} · ${c.blue('device_file_list')}`,
    `    ${c.blue('device_temperature')} · ${c.blue('device_resources')} · ${c.blue('device_processes')} · ${c.blue('device_network')} · ${c.blue('device_cameras')}`,
    `    ${c.blue('ros2_topic_list')} · ${c.blue('ros2_topic_echo')} · ${c.blue('ros2_topic_hz')} · ${c.blue('ros2_node_list')}`,
    `    ${c.blue('ros2_service_list')} · ${c.blue('ros2_service_call')} · ${c.blue('ros2_launch')} · ${c.blue('ros2_pkg_list')}`,
    '',
    `  ${c.dim('Docs: https://github.com/D-Moss/dmoss-agent · License: MIT')}`,
    '',
  ];
  console.log(lines.join('\n'));
  process.exit(0);
}

if (argv.includes('--version') || argv.includes('-v')) {
  try {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'package.json',
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    console.log(`${c.bold('dmoss-agent')} ${c.cyan(`v${pkg.version}`)}`);
  } catch {
    console.log(`${c.bold('dmoss-agent')} ${c.dim('(unknown version)')}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// API key validation
// ---------------------------------------------------------------------------

if (!API_KEY) {
  const configDir = resolveConfigDir();
  console.error('Error: DMOSS_API_KEY is required.\n');
  console.error('Set it via one of:');
  console.error(`  1. Environment variable:  export DMOSS_API_KEY=your-key`);
  if (process.platform === 'win32') {
    console.error(`     PowerShell:            $env:DMOSS_API_KEY="your-key"`);
  }
  console.error(`  2. Config file:           ${path.join(configDir, 'config.json')}`);
  console.error(`     { "apiKey": "your-key" }`);
  console.error(`  3. .env file in project:  DMOSS_API_KEY=your-key`);
  console.error(`\nAlso accepts OPENAI_API_KEY as fallback.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// API response types (avoid `as any` on fetch results)
// ---------------------------------------------------------------------------

interface AnthropicResponse {
  content: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// ---------------------------------------------------------------------------
// Minimal LLM provider (Anthropic + OpenAI-compatible)
// ---------------------------------------------------------------------------

const cliProvider: LLMProvider = {
  id: 'cli-provider',
  displayName: 'CLI LLM Provider',

  async complete(opts: LLMRequestOptions): Promise<LLMResponse> {
    return this.stream(opts, () => {});
  },

  async stream(
    opts: LLMRequestOptions,
    onEvent: (e: LLMStreamEvent) => void,
  ): Promise<LLMResponse> {
    const isAnthropic = BASE_URL.includes('anthropic');
    if (isAnthropic) {
      return callAnthropic(opts, onEvent);
    }
    return callOpenAI(opts, onEvent);
  },
};

async function callAnthropic(
  opts: LLMRequestOptions,
  _onEvent: (e: LLMStreamEvent) => void,
): Promise<LLMResponse> {
  const body = {
    model: opts.model || MODEL,
    max_tokens: opts.maxTokens || 4096,
    system: opts.systemPrompt,
    messages: opts.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    tools: opts.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    })),
    stream: false,
  };

  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: opts.abortSignal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const data: AnthropicResponse = (await res.json()) as AnthropicResponse;
  const content: LLMContentBlock[] = (data.content || []).map((b) => {
    if (b.type === 'text') return { type: 'text' as const, text: b.text ?? '' };
    if (b.type === 'tool_use')
      return {
        type: 'tool_use' as const,
        id: b.id ?? '',
        name: b.name ?? '',
        input: b.input ?? {},
      };
    return { type: 'text' as const, text: '' };
  });

  return {
    content,
    stopReason: data.stop_reason as LLMResponse['stopReason'],
    usage: data.usage
      ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens }
      : undefined,
  };
}

async function callOpenAI(
  opts: LLMRequestOptions,
  _onEvent: (e: LLMStreamEvent) => void,
): Promise<LLMResponse> {
  const body: Record<string, unknown> = {
    model: opts.model || MODEL,
    max_tokens: opts.maxTokens || 4096,
    messages: [
      ...(opts.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : []),
      ...opts.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
    ],
  };

  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }

  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: opts.abortSignal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }

  const data: OpenAIResponse = (await res.json()) as OpenAIResponse;
  const choice = data.choices?.[0];
  const content: LLMContentBlock[] = [];

  if (choice?.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      });
    }
  }

  return {
    content,
    stopReason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    usage: data.usage
      ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function createMemoryTools(memoryManager: MemoryManager): Tool[] {
  const memoryRead: Tool = {
    name: 'memory_read',
    description:
      'Search long-term memory for relevant entries. Use to recall user preferences, past decisions, or stored facts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (keywords or natural language)' },
        limit: { type: 'number', description: 'Max results to return (default: 5)' },
      },
      required: ['query'],
    },
    async execute(input) {
      const results = await memoryManager.search(input.query, input.limit || 5);
      if (results.length === 0) return 'No matching memories found.';
      return results
        .map((r, i) => `[${i + 1}] (score: ${r.score.toFixed(2)}) ${r.snippet}`)
        .join('\n\n');
    },
  };

  const memoryWrite: Tool = {
    name: 'memory_write',
    description:
      'Store an important fact, user preference, or decision in long-term memory for future recall.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact or preference to remember' },
      },
      required: ['content'],
    },
    async execute(input) {
      const validation = validateMemoryWriteContent(input.content);
      if (!validation.ok) return `Memory write rejected: ${validation.reason}`;
      const id = await memoryManager.add(input.content);
      return `Stored in memory (id: ${id})`;
    },
  };

  const memoryDelete: Tool = {
    name: 'memory_delete',
    description: 'Delete a specific memory entry by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory entry ID to delete' },
      },
      required: ['id'],
    },
    async execute(input) {
      const deleted = await memoryManager.delete(input.id);
      return deleted ? `Deleted memory ${input.id}` : `Memory ${input.id} not found`;
    },
  };

  return [memoryRead, memoryWrite, memoryDelete];
}

async function main() {
  if (process.platform === 'win32') {
    try {
      execSync('chcp 65001', { stdio: 'ignore' });
    } catch {
      /* ignore: best-effort UTF-8 console for fewer mojibake artifacts */
    }
  }

  const runtimeDir = path.join(WORKSPACE, '.dmoss-runtime');
  const sessionsDir = path.join(runtimeDir, 'sessions');
  const memoryDir = path.join(runtimeDir, 'memory');
  const skillsDir = path.join(WORKSPACE, 'skills');

  const sessionStore = new JsonlSessionStore({ dir: sessionsDir });
  const memoryManager = new MemoryManager(memoryDir);
  const skillLearner = new SkillLearner({ skillsDir });
  const workspaceMemory = new WorkspaceMemory({ workspaceDir: WORKSPACE });

  const wsContext = await workspaceMemory.loadContext();
  const wsPromptLayer = workspaceMemory.buildPromptLayer(wsContext);

  const extraPromptLayers: string[] = [];
  if (wsPromptLayer) extraPromptLayers.push(wsPromptLayer);

  const agent = new DmossAgent({
    llmProvider: cliProvider,
    sessionStore,
    model: MODEL,
    enableToolOutputTruncation: true,
    extraPromptLayers,
    hooks: {
      enrichToolContext: (ctx) => ({ ...ctx, workspaceDir: WORKSPACE }),
    },
  });

  registerBuiltinTools(agent);

  const execBackend = process.env.DMOSS_EXEC_BACKEND || 'local';
  if (execBackend === 'docker') {
    const dockerExec = createDockerExecTool({
      workspaceDir: WORKSPACE,
      image: process.env.DMOSS_DOCKER_IMAGE,
    });
    agent.tools.register(dockerExec);
  }

  for (const tool of createMemoryTools(memoryManager)) {
    agent.tools.register(tool);
  }

  const deviceConfig = getDeviceConfigFromEnv();

  const meshEnabled = process.env.DMOSS_MESH_ENABLED === 'true' || argv.includes('--mesh');
  if (meshEnabled) {
    const meshPort = parseInt(process.env.DMOSS_MESH_PORT || '9090', 10);
    const meshId = process.env.DMOSS_MESH_ID || `dmoss-${Date.now()}`;
    const meshName = process.env.DMOSS_MESH_NAME || `D-Moss @ ${os.hostname()}`;
    const meshPeers = (process.env.DMOSS_MESH_PEERS || '')
      .split(',')
      .filter(Boolean)
      .map((p) => {
        const [host, port] = p.split(':');
        return { host, port: parseInt(port || '9090', 10) };
      });

    const allowIncoming = process.env.DMOSS_MESH_ALLOW_INCOMING !== 'false';

    const mesh = new AgentMesh({
      id: meshId,
      name: meshName,
      port: meshPort,
      peers: meshPeers,
      capabilities: deviceConfig ? ['device-control', 'ros2'] : ['general'],
      deviceInfo: deviceConfig ? `${deviceConfig.host}` : undefined,
      allowIncoming,
    });

    mesh.onQuery(async (query) => {
      const result = await agent.chat(`mesh-${Date.now()}`, query);
      return result.response || '(no response)';
    });

    await mesh.start();
    await mesh.announce();
    if (isMeshVerboseEnabled()) {
      console.error(`[mesh] Agent mesh started on port ${meshPort} (id: ${meshId})`);
      console.error(
        `[mesh] Incoming queries: ${allowIncoming ? 'ALLOWED' : 'BLOCKED'} (set DMOSS_MESH_ALLOW_INCOMING=false to block)`,
      );
      if (meshPeers.length)
        console.error(
          `[mesh] Known peers: ${meshPeers.map((p) => `${p.host}:${p.port}`).join(', ')}`,
        );
    }

    for (const tool of createMeshTools(mesh)) {
      agent.tools.register(tool);
    }

    try {
      const discovery = new LanDiscovery({
        mesh,
        meshPort: meshPort,
        agentId: meshId,
        agentName: meshName,
      });

      discovery.onNewPeer((peer) => {
        if (isMeshVerboseEnabled()) {
          console.error(
            `\n[mesh] 🔗 New peer discovered: ${peer.name} (${peer.host}:${peer.port})`,
          );
          if (peer.deviceInfo) console.error(`[mesh]    Device: ${peer.deviceInfo}`);
        }
      });

      await discovery.start();
      if (isMeshVerboseEnabled()) {
        console.error(`[mesh] LAN auto-discovery active (UDP broadcast on port 9091)`);
      }
    } catch (err) {
      console.error(
        `[mesh] LAN discovery unavailable: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  if (deviceConfig) {
    console.error(
      `[device] Connected to ${deviceConfig.host} (${deviceConfig.user || 'root'}@${deviceConfig.host}:${deviceConfig.port || 22})`,
    );
    for (const tool of createDeviceSshTools(deviceConfig)) {
      agent.tools.register(tool);
    }
    for (const tool of createDeviceDiagnosticsTools(deviceConfig)) {
      agent.tools.register(tool);
    }
    for (const tool of createRos2Tools(deviceConfig)) {
      agent.tools.register(tool);
    }
  }

  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const oneShotMessage = args.join(' ').trim();

  if (oneShotMessage) {
    await runOneShot(agent, oneShotMessage, skillLearner);
    return;
  }

  const isTTY = process.stdin.isTTY;
  if (!isTTY) {
    let piped = '';
    for await (const chunk of process.stdin) {
      piped += chunk;
    }
    if (piped.trim()) {
      await runOneShot(agent, piped.trim(), skillLearner);
    }
    return;
  }

  await runInteractive(agent, skillLearner);
}

async function runOneShot(agent: DmossAgent, message: string, learner?: SkillLearner) {
  for await (const event of agent.streamChat('cli', message)) {
    switch (event.type) {
      case 'text_delta':
        process.stdout.write(event.delta);
        break;
      case 'tool_start':
        if (dmossVerboseTools()) process.stderr.write(`\n[tool] ${event.toolName}...\n`);
        break;
      case 'tool_end':
        if (dmossVerboseTools() && event.isError)
          process.stderr.write(`[tool] ${event.toolName} failed\n`);
        break;
      case 'done':
        process.stdout.write('\n');
        if (learner && event.result?.toolCalls && event.result.toolCalls.length >= 2) {
          try {
            const messages = await agent.config.sessionStore.loadMessages('cli');
            const skillPath = await learner.maybeLearnFromSession('cli', messages);
            if (skillPath && dmossVerboseTools()) {
              process.stderr.write(`\n[learned] Skill saved: ${path.basename(skillPath)}\n`);
            }
          } catch {
            /* non-critical */
          }
        }
        break;
    }
  }
}

let currentModel = MODEL;

async function runInteractive(agent: DmossAgent, skillLearner?: SkillLearner) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: '\n> ',
  });

  console.error(`D-Moss Agent (model: ${currentModel}, workspace: ${WORKSPACE})`);
  console.error('Commands: /model <name> | /models | /memory | /skills | /quit');
  console.error('Type your message and press Enter. Ctrl+C to exit.\n');
  rl.prompt();

  for await (const line of rl) {
    const msg = line.trim();
    if (!msg) {
      rl.prompt();
      continue;
    }
    if (msg === '/quit' || msg === '/exit') break;

    if (msg.startsWith('/model ')) {
      const newModel = msg.slice(7).trim();
      if (newModel) {
        currentModel = newModel;
        (agent.config as any).model = newModel;
        console.error(`[config] Model switched to: ${newModel}`);
      } else {
        console.error(`[config] Current model: ${currentModel}`);
      }
      rl.prompt();
      continue;
    }

    if (msg === '/models') {
      console.error(`[config] Current model: ${currentModel}`);
      console.error('[config] Switch with: /model <model-name>');
      console.error('[config] Examples:');
      console.error('  /model gpt-4o');
      console.error('  /model claude-sonnet-4-20250514');
      console.error('  /model qwen-plus');
      console.error('  /model deepseek-chat');
      rl.prompt();
      continue;
    }

    if (msg === '/memory') {
      const memDir = path.join(WORKSPACE, '.dmoss-runtime', 'memory');
      try {
        const indexPath = path.join(memDir, 'index.json');
        const raw = fs.readFileSync(indexPath, 'utf-8');
        const entries = JSON.parse(raw);
        console.error(`[memory] ${entries.length} entries stored`);
        for (const e of entries.slice(0, 5)) {
          console.error(`  - [${e.id}] ${e.content.slice(0, 80)}...`);
        }
        if (entries.length > 5) console.error(`  ... and ${entries.length - 5} more`);
      } catch {
        console.error('[memory] No memories stored yet.');
      }
      rl.prompt();
      continue;
    }

    if (msg === '/skills') {
      const learnedDir = path.join(WORKSPACE, 'skills', 'learned');
      try {
        const files = fs.readdirSync(learnedDir).filter((f: string) => f.endsWith('.md'));
        console.error(`[skills] ${files.length} learned skills:`);
        for (const f of files) {
          console.error(`  - ${f}`);
        }
      } catch {
        console.error('[skills] No learned skills yet.');
      }
      rl.prompt();
      continue;
    }

    if (msg.startsWith('/')) {
      console.error(`[help] Unknown command: ${msg}`);
      console.error('[help] Available: /model /models /memory /skills /quit');
      rl.prompt();
      continue;
    }

    await runOneShot(agent, msg, skillLearner);
    rl.prompt();
  }

  rl.close();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
