import type { DmossAgent } from '../core/index.js';
import { createDeviceDiagnosticsTools } from '../tools/device-diagnostics.js';
import { createRos2Tools } from '../tools/device-ros2.js';
import {
  createDeviceSshTools,
  probeDeviceSsh,
  type DeviceSshConfig,
  type DeviceSshProbeResult,
} from '../tools/device-ssh.js';
import {
  BOARD_REPLACED_TOOL_NAMES,
  BOARD_SUSPENDED_TOOL_NAMES,
  createBoardWorkspaceTools,
} from '../tools/device-workspace.js';
import type { CliRuntimeStatus, CliDeviceSessionHandle } from './onboarding.js';

const CONNECT_USAGE =
  'Usage: /connect <[user@]board-ip-or-hostname> [--user root] [--port 22] [--key ~/.ssh/id_rsa] [--password <pw>] [--no-verify] [--hybrid]\n' +
  'Defaults come from DMOSS_DEVICE_USER / DMOSS_DEVICE_PORT / DMOSS_DEVICE_KEY / DMOSS_DEVICE_PASSWORD when flags are omitted.\n' +
  'By default the session enters BOARD MODE (exec/file tools run on the board); --hybrid keeps local tools and only adds device_*/ros2_* tools.';

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export interface ParsedDeviceConnectArgs {
  config?: DeviceSshConfig;
  /** When false (--no-verify), skip the SSH reachability probe. Defaults to true. */
  verify?: boolean;
  /** 'board' (default): default tools redirect to the board. 'hybrid' (--hybrid): keep local tools. */
  mode?: 'board' | 'hybrid';
  error?: string;
}

export function parseDeviceConnectArgs(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): ParsedDeviceConnectArgs {
  const args = raw.trim().split(/\s+/).filter(Boolean);
  if (args.length === 0) {
    return { error: CONNECT_USAGE };
  }

  let target = '';
  let user = env.DMOSS_DEVICE_USER || 'root';
  let port = parsePort(env.DMOSS_DEVICE_PORT) ?? 22;
  let keyPath = env.DMOSS_DEVICE_KEY;
  let password = env.DMOSS_DEVICE_PASSWORD;
  let verify = true;
  let mode: 'board' | 'hybrid' = 'board';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--user' || arg === '-u') {
      user = args[++i] || '';
      continue;
    }
    if (arg.startsWith('--user=')) {
      user = arg.slice('--user='.length);
      continue;
    }
    if (arg === '--port' || arg === '-p') {
      port = parsePort(args[++i]) ?? port;
      continue;
    }
    if (arg.startsWith('--port=')) {
      port = parsePort(arg.slice('--port='.length)) ?? port;
      continue;
    }
    if (arg === '--key') {
      keyPath = args[++i] || '';
      continue;
    }
    if (arg.startsWith('--key=')) {
      keyPath = arg.slice('--key='.length);
      continue;
    }
    if (arg === '--password') {
      password = args[++i] || '';
      continue;
    }
    if (arg.startsWith('--password=')) {
      password = arg.slice('--password='.length);
      continue;
    }
    if (arg === '--no-verify') {
      verify = false;
      continue;
    }
    if (arg === '--hybrid') {
      mode = 'hybrid';
      continue;
    }
    if (arg === '--board') {
      mode = 'board';
      continue;
    }
    if (arg.startsWith('-')) {
      return { error: `Unsupported /connect option: ${arg}\n${CONNECT_USAGE}` };
    }
    if (target) return { error: `Unexpected /connect argument: ${arg}\n${CONNECT_USAGE}` };
    target = arg;
  }

  if (!target) {
    return { error: CONNECT_USAGE };
  }
  if (target.includes('@')) {
    const [rawUser, rawHost] = target.split('@', 2);
    if (rawUser) user = rawUser;
    target = rawHost || target;
  }
  if (!target.trim()) return { error: 'Board host is empty.' };

  return {
    config: {
      host: target.trim(),
      user: user || 'root',
      port,
      ...(password ? { password } : {}),
      ...(keyPath ? { keyPath } : {}),
    },
    verify,
    mode,
  };
}

export interface ConnectDeviceOptions {
  /** Skip the SSH reachability probe (--no-verify). Defaults to false. */
  skipVerify?: boolean;
  /** Probe implementation, injectable for tests. Defaults to probeDeviceSsh. */
  probe?: (config: DeviceSshConfig) => Promise<DeviceSshProbeResult>;
  /** 'board' (default): redirect default tools to the board. 'hybrid': keep local tools. */
  mode?: 'board' | 'hybrid';
  /** User locale (e.g. "zh_CN.UTF-8") — failure guidance is localized for zh. */
  locale?: string;
}

export interface DeviceConnectResult {
  ok: boolean;
  message: string;
  /**
   * On a recoverable failure (e.g. auth), a ready-to-complete retry command —
   * UIs should pre-fill the input with it so the user only types the missing
   * part (the password) instead of reconstructing the command.
   */
  retryInput?: string;
}

function isZh(locale: string | undefined): boolean {
  return /^zh/i.test(locale ?? '');
}

function buildRetryCommand(config: DeviceSshConfig): string {
  const port = config.port && config.port !== 22 ? ` --port ${config.port}` : '';
  return `/connect ${config.user || 'root'}@${config.host}${port} --password `;
}

function buildConnectFailureMessage(
  config: DeviceSshConfig,
  probe: DeviceSshProbeResult,
  locale: string | undefined,
): { message: string; retryInput?: string } {
  const target = `${config.user || 'root'}@${config.host}:${config.port || 22}`;
  const zh = isZh(locale);
  const retry = buildRetryCommand(config);

  if (probe.kind === 'auth') {
    const message = zh
      ? [
          `[device] 连接 ${target} 失败：认证被拒（未提供密码，或密码/密钥不对）。设备工具未启用。`,
          `下一步：补上板卡密码重试（命令已为你预填）：`,
          `  ${retry}<密码>`,
          `免密方案：终端执行 ssh-copy-id ${config.user || 'root'}@${config.host} 配置一次，以后 /connect 无需密码。`,
        ].join('\n')
      : [
          `[device] Connection to ${target} FAILED: authentication rejected (no password given, or wrong password/key). Device tools were not enabled.`,
          `Next step — add the board password and retry (command pre-filled for you):`,
          `  ${retry}<password>`,
          `Passwordless option: run ssh-copy-id ${config.user || 'root'}@${config.host} once, then /connect needs no flags.`,
        ].join('\n');
    return { message, retryInput: retry };
  }

  const hints: Record<string, { zh: string; en: string }> = {
    refused: {
      zh: `板卡拒绝了端口 ${config.port || 22} 的连接：检查端口号（--port）以及板卡上 sshd 是否在运行。`,
      en: probe.detail,
    },
    unreachable: {
      zh: `无法到达 ${config.host}：检查 IP 是否正确、板卡是否开机、与本机是否同一网络。`,
      en: probe.detail,
    },
    dns: {
      zh: `无法解析主机名 ${config.host}：检查拼写，或直接使用板卡 IP。`,
      en: probe.detail,
    },
  };
  const hint = probe.kind && hints[probe.kind] ? (zh ? hints[probe.kind].zh : hints[probe.kind].en) : probe.detail;
  const message = zh
    ? [
        `[device] 连接 ${target} 失败，设备工具未启用。`,
        hint,
        `排查后重试：/connect ${config.user || 'root'}@${config.host}（可加 --port/--password/--key；跳过探测用 --no-verify）。`,
      ].join('\n')
    : [
        `[device] Connection to ${target} FAILED — device tools were not enabled.`,
        hint,
        'Retry with explicit credentials (e.g. /connect user@ip --port 22 --password <pw>). To register tools without probing, use --no-verify (or DMOSS_DEVICE_NO_VERIFY=1 for startup env connects).',
      ].join('\n');
  return { message };
}

function buildBoardModePromptLayer(target: string, hostname: string | undefined): string {
  return [
    '## Board Mode Active',
    `This session is connected to ${target}${hostname ? ` (remote hostname: ${hostname})` : ''}.`,
    'The default workspace tools — exec, read_file, write_file, edit_file, list_directory, search_files, search_code, move_file — operate ON THE BOARD over SSH, not on the host PC. Treat every path as a board path (absolute, or relative to the SSH user home).',
    'exec is stateless between calls (cd does not persist; use absolute paths). apply_patch and exec_background are suspended; use edit_file/write_file and `nohup ... &` instead.',
    'Host-local files are unreachable until the user runs /disconnect.',
  ].join('\n');
}

/**
 * Undo everything a device session registered: remove session tools, restore
 * displaced local tools, drop the board-mode prompt layer. Returns verified
 * counts so callers can report what actually happened. @internal
 */
function restoreDeviceSession(
  agent: DmossAgent,
  handle: CliDeviceSessionHandle,
): { removed: number; restored: number } {
  let removed = 0;
  for (const name of handle.registeredNames) {
    if (agent.tools.get(name)) {
      agent.tools.remove(name);
      removed += 1;
    }
  }
  let restored = 0;
  for (const tool of handle.displaced) {
    agent.tools.register(tool);
    restored += 1;
  }
  if (handle.promptLayer && agent.config?.extraPromptLayers) {
    const idx = agent.config.extraPromptLayers.indexOf(handle.promptLayer);
    if (idx >= 0) agent.config.extraPromptLayers.splice(idx, 1);
  }
  return { removed, restored };
}

/**
 * Connect a device for this session. Verifies SSH reachability first (unless
 * skipVerify) and only registers tools — and only claims success — after the
 * probe passes. In board mode (default) the standard workspace tools are
 * replaced by SSH-backed equivalents so the session behaves like moss running
 * on the board; /disconnect (or Ctrl+D on an empty prompt) restores them.
 */
export async function connectDeviceForSession(
  agent: DmossAgent,
  runtime: CliRuntimeStatus | undefined,
  config: DeviceSshConfig,
  options: ConnectDeviceOptions = {},
): Promise<DeviceConnectResult> {
  const target = `${config.user || 'root'}@${config.host}:${config.port || 22}`;
  const mode = options.mode ?? 'board';
  let verifiedHostname: string | undefined;

  if (!options.skipVerify) {
    const probe = options.probe ?? probeDeviceSsh;
    const result = await probe(config);
    if (!result.ok) {
      const failure = buildConnectFailureMessage(config, result, options.locale);
      return { ok: false, message: failure.message, retryInput: failure.retryInput };
    }
    verifiedHostname = result.detail;
  }

  // Reconnect while a session is active: cleanly restore the previous session
  // first, otherwise board mode would snapshot board tools as "local" ones.
  if (runtime?.deviceSession) {
    restoreDeviceSession(agent, runtime.deviceSession);
    runtime.deviceSession = null;
  }

  const sessionTools = [
    ...createDeviceSshTools(config),
    ...createDeviceDiagnosticsTools(config),
    ...createRos2Tools(config),
    ...(mode === 'board' ? createBoardWorkspaceTools(config) : []),
  ];

  // Snapshot the local tools board mode will displace or suspend — BEFORE
  // registering anything — so /disconnect can verifiably restore them.
  const displaced: CliDeviceSessionHandle['displaced'] = [];
  if (mode === 'board') {
    for (const name of [...BOARD_REPLACED_TOOL_NAMES, ...BOARD_SUSPENDED_TOOL_NAMES]) {
      const existing = agent.tools.get(name);
      if (existing) displaced.push(existing);
    }
    for (const name of BOARD_SUSPENDED_TOOL_NAMES) {
      agent.tools.remove(name);
    }
  }

  for (const tool of sessionTools) {
    agent.tools.remove(tool.name);
    agent.tools.register(tool);
  }

  let promptLayer: string | undefined;
  if (mode === 'board' && agent.config) {
    promptLayer = buildBoardModePromptLayer(target, verifiedHostname);
    if (!agent.config.extraPromptLayers) agent.config.extraPromptLayers = [];
    agent.config.extraPromptLayers.push(promptLayer);
  }

  if (runtime) {
    runtime.device = { host: config.host, user: config.user, port: config.port };
    runtime.deviceSession = {
      registeredNames: sessionTools.map((tool) => tool.name),
      displaced,
      promptLayer,
      boardMode: mode === 'board',
    };
  }

  const zh = isZh(options.locale);
  const headline = options.skipVerify
    ? `[device] Connected to ${target} for this session (unverified: SSH probe skipped).`
    : `[device] Connected to ${target} for this session (verified, remote hostname: ${verifiedHostname}).`;
  const modeLine = mode === 'board'
    ? (zh
        ? '板卡模式：exec 和文件工具现在直接在板卡上执行（apply_patch/exec_background 已挂起）。退出：/disconnect 或空输入按 Ctrl+D；想保留本地工具用 /connect --hybrid。'
        : 'BOARD MODE: exec and file tools now run on the board (apply_patch/exec_background suspended). Exit with /disconnect or Ctrl+D on an empty prompt; use /connect --hybrid to keep local tools instead.')
    : (zh
        ? '混合模式：本地工具保留，已追加 device_*/ros2_* 工具。/disconnect 可移除。'
        : 'Hybrid mode: local tools kept; device_*/ros2_* tools added alongside. /disconnect removes them.');
  return {
    ok: true,
    message: [headline, modeLine].join('\n'),
  };
}

/**
 * Disconnect the current device session: remove device/board tools, restore
 * displaced local tools, drop the board-mode prompt layer. The message is
 * derived from the verified restore counts.
 */
export function disconnectDeviceForSession(
  agent: DmossAgent,
  runtime: CliRuntimeStatus | undefined,
): string {
  const handle = runtime?.deviceSession;
  const device = runtime?.device;
  if (!handle) {
    if (device && runtime) {
      runtime.device = null;
      return `[device] Cleared device state for ${device.user || 'root'}@${device.host} (no session tools were registered).`;
    }
    return '[device] No board is connected. Use /connect <[user@]ip> first.';
  }

  const { removed, restored } = restoreDeviceSession(agent, handle);
  const target = device ? `${device.user || 'root'}@${device.host}:${device.port || 22}` : 'the board';
  if (runtime) {
    runtime.device = null;
    runtime.deviceSession = null;
  }
  const localExecBack = handle.boardMode ? Boolean(agent.tools.get('exec')) : true;
  if (handle.boardMode && !localExecBack) {
    return `[device] Disconnected from ${target}, but restoring local tools FAILED (exec missing). Restart moss to recover a clean local toolset.`;
  }
  return [
    `[device] Disconnected from ${target}. Removed ${removed} board/device tools${restored ? `, restored ${restored} local tools` : ''}.`,
    handle.boardMode ? 'Back on the host PC: exec and file tools operate locally again.' : 'Local toolset unchanged.',
  ].join('\n');
}
