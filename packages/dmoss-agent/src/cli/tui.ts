import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdin, useCursor, measureElement, type DOMElement } from 'ink';
import { enableMouse, disableMouse, parseMouseEvent } from './input/mouse.js';
import stringWidth from 'string-width';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { StreamingSpinner } from './components/StreamingSpinner.js';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { DmossAgent, DmossAgentEvent, ToolResultOutcome } from '../core/index.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import type { SessionMeta } from '../core/session/session.js';
import { SkillRegistry, type SkillMeta } from '../skills/index.js';
import { setCliApprovalAsker, setCliInteractionMode, getCliInteractionMode, type CliInteractionMode } from './approval.js';
import { FileCheckpointStore, checkpointTargetPaths } from './file-checkpoint.js';
import { renderCliDetailHelp, renderCliExamples, renderCliPermissions, renderCliStatus, renderCliTools, renderCliUpgradeHelp, type CliRuntimeStatus } from './onboarding.js';
import { getPackageVersion } from './package-info.js';
import { startCliUpdateCheck } from './update-check.js';
import { compactPath, ui } from './ui.js';

type TranscriptKind = 'user' | 'assistant' | 'system' | 'error' | 'shell' | 'tool';
type TuiRunState = 'ready' | 'running' | 'approval';

interface TranscriptItem {
  id: number;
  kind: TranscriptKind;
  text: string;
  turnId?: number;
  status?: 'running' | 'ok' | 'failed';
  toolName?: string;
  toolCallId?: string;
  toolInput?: string;
  toolInputRaw?: unknown;
  startedAt?: number;
  elapsedMs?: number;
  outcome?: ToolResultOutcome;
  result?: string;
  finalized?: boolean;
}

interface ActivityItem {
  id: string;
  toolName: string;
  toolCallId: string;
  startedAt: number;
  status: 'running' | 'ok' | 'failed';
  inputSummary?: string;
  elapsedMs?: number;
  outcome?: ToolResultOutcome;
  inputRaw?: unknown;
  result?: string;
}

interface ApprovalState {
  question: string;
  resolve: (answer: string) => void;
}

export interface QueuedInput {
  raw: string;
  message: string;
  enqueuedAt?: number;
}

export interface QueueDrainState {
  busy: boolean;
  approvalActive: boolean;
  pausedAfterCancel: boolean;
  queueLength: number;
}

export interface TranscriptViewportRowsOptions {
  transcriptLength: number;
  terminalRows: number;
  headerRows: number;
  promptRows: number;
  queueRows: number;
  footerRows: number;
  approvalRows: number;
  noticeRows: number;
}

export interface AttachmentRef {
  index: number;
  kind: 'image' | 'file';
  label: string;
}

export interface DmossTuiProps {
  agent: DmossAgent;
  skillLearner?: SkillLearner;
  runtime?: CliRuntimeStatus;
  sessionKey: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Theme & icons (Claude Code-inspired warm, low-noise terminal palette)
// ────────────────────────────────────────────────────────────────────────────

import { legacyTheme as theme } from './theme/theme.js';
import { BRAND_ORANGE, BRAND_CYAN } from './theme/brand.js';

// Glyphs — emoji at line-start only (never in alignment columns).
// Falls back to bracket tags when DMOSS_TUI_NO_EMOJI=1 or terminal lacks UTF-8.
function emojiEnabled(): boolean {
  if (process.env.DMOSS_TUI_NO_EMOJI === '1') return false;
  const lang = `${process.env.LANG || ''} ${process.env.LC_ALL || ''} ${process.env.LC_CTYPE || ''}`;
  if (lang && !/utf-?8/i.test(lang)) return false;
  return true;
}

// Tool-call rows use Claude Code's `⏺` bullet and `⎿` result connector
// (see ActivityItemLine). The old per-tool emoji map and status glyphs were
// retired in favor of that single, consistent marker style.

// ────────────────────────────────────────────────────────────────────────────
// Sanitizers & helpers (unchanged public surface)
// ────────────────────────────────────────────────────────────────────────────

function nextId(): number {
  return Date.now() + Math.floor(Math.random() * 1000);
}

const ANSI_RE = new RegExp(
  String.raw`\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))`,
  'g',
);
const CONTROL_CHAR_RE = new RegExp(String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]`, 'g');
const LONG_TOKEN_RE = /[^\s]{33,}/g;
const COPY_SENSITIVE_TOKEN_RE = /^(?:https?:\/\/|file:\/\/|[A-Za-z]:\\|\/|\.\/|\.\.\/|[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+|[A-Za-z0-9_-]*_[A-Za-z0-9_-]*|\[[^\]\n]{1,160}\]\((?:https?:\/\/|file:\/\/)[^)]+\))/;
const RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LOCAL_SHELL_OUTPUT_LIMIT = 40_000;
const MAX_TRANSCRIPT_ITEMS = 200;
const MAX_INPUT_HISTORY = 100;
const WELCOME_PANEL_ROWS_ESTIMATE = 18;
const HEADLINE_MAX = 72;

const AGENTS_MD_TEMPLATE = `# AGENTS.md

Project memory for D-Moss and coding agents. Auto-loaded at the start of every session.

## Overview
<!-- What this project is, in one or two sentences. -->

## Build / test / run
<!-- The exact commands an agent should use, e.g. install / build / test / lint. -->

## Layout
<!-- Top-level directories and what lives in each. -->

## Conventions
<!-- Code style, naming, patterns to follow, and things NOT to touch. -->
`;

const KNOWN_COMMANDS = [
  '/help',
  '/tools',
  '/status',
  '/permissions',
  '/config',
  '/examples',
  '/model',
  '/models',
  '/detail',
  '/queue',
  '/queue drop',
  '/queue pop',
  '/queue resume',
  '/queue continue',
  '/clearqueue',
  '/memory',
  '/skills',
  '/init',
  '/diff',
  '/sessions',
  '/context',
  '/cost',
  '/rewind',
  '/session',
  '/upgrade',
  '/stop',
  '/abort',
  '/clear',
  '/thinking',
  '/quit',
  '/exit',
] as const;

export function sanitizeRenderableText(text: string): string {
  const withoutAnsi = text.includes('\x1B') ? text.replace(ANSI_RE, '') : text;
  const withoutControls = CONTROL_CHAR_RE.test(withoutAnsi)
    ? withoutAnsi.replace(CONTROL_CHAR_RE, '')
    : withoutAnsi;
  const binarySafe = withoutControls
    .split('\n')
    .map((line) => {
      const replacementCount = (line.match(/\uFFFD/g) ?? []).length;
      return replacementCount >= 12 && replacementCount / Math.max(1, line.length) > 0.2
        ? '[binary data omitted]'
        : line;
    })
    .join('\n');
  const tokenSafe = binarySafe.replace(LONG_TOKEN_RE, (token) => {
    if (COPY_SENSITIVE_TOKEN_RE.test(token)) return token;
    return token.replace(/(.{24})/g, '$1 ');
  });
  return tokenSafe
    .split('\n')
    .map((line) => (RTL_RE.test(line) ? `\u2067${line}\u2069` : line))
    .join('\n');
}

export function isLocalShellLine(raw: string): boolean {
  return raw.startsWith('!') && raw.trim() !== '!';
}

function appendLimited(current: string, chunk: string, limit = LOCAL_SHELL_OUTPUT_LIMIT): string {
  const next = `${current}${chunk}`;
  if (next.length <= limit) return next;
  return next.slice(-limit);
}

export function runLocalShellCommand(options: {
  command: string;
  cwd: string;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}): Promise<{ output: string; exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('Local shell command aborted before start'));
      return;
    }
    let output = '';
    let settled = false;
    const child = spawn(options.command, {
      cwd: options.cwd,
      shell: true,
      env: { ...process.env, DMOSS_TUI_LOCAL_SHELL: '1' },
    });
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const push = (chunk: Buffer) => {
      const text = sanitizeRenderableText(chunk.toString('utf8'));
      output = appendLimited(output, text);
      options.onChunk?.(text);
    };
    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Process may have already exited.
      }
      settle(() => reject(new Error('Local shell command aborted')));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', (code, signal) => {
      settle(() => resolve({ output, exitCode: code, signal }));
    });
  });
}

export function visibleText(text: string, maxLines = Number.POSITIVE_INFINITY): string {
  const clean = sanitizeRenderableText(text).trimEnd();
  if (!Number.isFinite(maxLines)) return clean;
  const lines = clean.split('\n');
  if (lines.length <= maxLines) return clean;
  return [
    `... ${lines.length - maxLines} earlier lines hidden ...`,
    ...lines.slice(-maxLines),
  ].join('\n');
}

export function formatQueueWait(enqueuedAt: number | undefined, now = Date.now()): string | null {
  if (enqueuedAt === undefined || !Number.isFinite(enqueuedAt)) return null;
  const waitMs = Math.max(0, now - enqueuedAt);
  if (waitMs < 1000) return '<1s';
  if (waitMs < 60_000) return `${Math.floor(waitMs / 1000)}s`;
  if (waitMs < 3_600_000) return `${Math.floor(waitMs / 60_000)}m`;
  return `${Math.floor(waitMs / 3_600_000)}h`;
}

function queueItemKind(item: QueuedInput): string {
  if (isLocalShellLine(item.raw)) return 'local shell';
  if (item.message.startsWith('/')) return 'command';
  return 'prompt';
}

export function dropLastQueuedInput(items: QueuedInput[]): { next: QueuedInput[]; dropped?: QueuedInput } {
  if (items.length === 0) return { next: [] };
  return {
    next: items.slice(0, -1),
    dropped: items[items.length - 1],
  };
}

export function queueItemMeta(item: QueuedInput, now = Date.now()): string {
  const lineCount = sanitizeRenderableText(item.message).split('\n').length;
  const charCount = sanitizeRenderableText(item.message).length;
  const wait = formatQueueWait(item.enqueuedAt, now);
  return [
    queueItemKind(item),
    wait ? `waiting ${wait}` : null,
    `${lineCount} line${lineCount === 1 ? '' : 's'}`,
    `${charCount} chars`,
  ].filter(Boolean).join(' · ');
}

export function shouldDrainQueue(state: QueueDrainState): boolean {
  return !state.busy && !state.approvalActive && !state.pausedAfterCancel && state.queueLength > 0;
}

export function stopRequestedMessage(queueLength: number): string {
  if (queueLength > 0) {
    return `Stop requested. Queue paused (${queueLength} item${queueLength === 1 ? '' : 's'}); use /queue resume or send a new prompt to continue.`;
  }
  return 'Stop requested for the current run.';
}

export function queueResumedMessage(queueLength: number): string {
  if (queueLength > 0) {
    return `Queue resumed (${queueLength} item${queueLength === 1 ? '' : 's'} waiting).`;
  }
  return 'Queue resumed.';
}

export function isQueueControlCommand(message: string): boolean {
  return message === '/queue'
    || message === '/queued'
    || message === '/queue drop'
    || message === '/queue pop'
    || message === '/queue clear'
    || message === '/clearqueue'
    || message === '/queue resume'
    || message === '/queue continue';
}

function availableTranscriptRows(options: TranscriptViewportRowsOptions): number {
  // Reserve a little vertical slack for Box margins/borders that Ink does not
  // expose as rows in the surrounding chrome estimates.
  return Math.max(
    1,
    options.terminalRows
      - options.headerRows
      - options.promptRows
      - options.queueRows
      - options.footerRows
      - options.approvalRows
      - options.noticeRows
      - 2,
  );
}

export function shouldRenderCompactWelcome(options: TranscriptViewportRowsOptions): boolean {
  return options.transcriptLength === 0 && availableTranscriptRows(options) < WELCOME_PANEL_ROWS_ESTIMATE;
}

export function transcriptViewportRows(options: TranscriptViewportRowsOptions): number | undefined {
  if (options.transcriptLength === 0) return undefined;
  return availableTranscriptRows(options);
}

function formatSessionTimestamp(updatedAt: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return 'unknown time';
  return new Date(updatedAt).toLocaleString();
}

export function formatTuiSessions(
  sessions: SessionMeta[],
  currentSessionKey: string,
  options: { limit?: number } = {},
): string {
  const limit = Math.max(1, options.limit ?? 10);
  const recent = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  const lines = [
    'Sessions',
    `  current: ${currentSessionKey}`,
  ];
  if (recent.length === 0) {
    lines.push('  No saved sessions found yet.');
  } else {
    lines.push(`  recent (${recent.length}${sessions.length > recent.length ? ` of ${sessions.length}` : ''})`);
    for (const session of recent) {
      const marker = session.sessionKey === currentSessionKey ? '*' : ' ';
      const count = `${session.messageCount} message${session.messageCount === 1 ? '' : 's'}`;
      lines.push(`  ${marker} ${session.sessionKey} · ${count} · updated ${formatSessionTimestamp(session.updatedAt)}`);
    }
  }
  lines.push('');
  lines.push('Shell: dmoss resume --last');
  lines.push('Shell: dmoss resume --session <key>');
  lines.push('Shell: dmoss fork --fork-from <key>');
  return lines.join('\n');
}

export function extractAttachmentRefs(text: string): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  const seen = new Set<string>();
  const re = /\[((?:Image|File) #(\d+))\]/g;
  for (const match of text.matchAll(re)) {
    const label = match[1] || '';
    if (seen.has(label)) continue;
    seen.add(label);
    refs.push({
      index: Number(match[2]),
      kind: label.startsWith('Image') ? 'image' : 'file',
      label,
    });
  }
  return refs;
}

export function formatAttachmentChip(ref: AttachmentRef): string {
  return `[${ref.label}] ${ref.kind}`;
}

export function statusLine(options: {
  state: TuiRunState;
  model: string;
  device: string;
  workspace: string;
  cacheMode?: string;
  profile?: string;
}): string {
  const parts = [
    'D-Moss',
    statusBadge(options.state),
    options.model || 'no model',
    options.profile ? `profile ${options.profile}` : '',
    options.device,
    compactPath(options.workspace),
    options.cacheMode || 'cache stable',
  ];
  return parts.filter(Boolean).join('  ');
}

export function promptCacheModeLabel(runtime?: CliRuntimeStatus): string {
  if (runtime?.config?.promptCacheEnabled === false) return 'cache off';
  return runtime?.config?.promptCacheDebug === true ? 'cache debug' : 'cache stable';
}

export type ExecutionMode = 'pc-host' | 'on-board' | 'hybrid';

export interface DeviceContextSummary {
  mode: ExecutionMode;
  runningOn: string;
  targetDevice: string;
  inference: string;
  permissions: string;
  policy: string;
  deviceContext: string;
  lockedCapabilities: string;
}

// Device-side Moss follows NemoClaw-like runtime principles without copying its
// UI: explicit execution plane, filesystem/process/network policy, inference
// routing, operator approval, lifecycle evidence, and recoverable board runtime.
const DEVICE_WORKFLOWS = [
  { title: 'Diagnose Board', description: 'OS, NPU, memory, temperature, services, network, logs' },
  { title: 'Deploy Model', description: 'dependencies, inference run, benchmark, output evidence' },
  { title: 'Bring up Sensor', description: 'camera, audio, IMU, serial, driver config, data flow' },
  { title: 'Debug ROS/tros', description: 'topics, nodes, services, logs, graph health' },
] as const;

function isLikelyBoardRuntime(): boolean {
  if (process.env.DMOSS_BOARD_RUNTIME === '1') return true;
  if (process.env.RDK_BOARD || process.env.RDK_MODEL || process.env.TROS_DISTRO) return true;
  if (process.platform !== 'linux') return false;
  if (process.arch === 'arm64' || process.arch === 'arm') return true;
  try {
    const model = fs.readFileSync('/proc/device-tree/model', 'utf8').toLowerCase();
    return /rdk|d-robotics|horizon|raspberry|rockchip|jetson/.test(model);
  } catch {
    return false;
  }
}

function readFirstExisting(paths: readonly string[]): string | null {
  for (const candidate of paths) {
    try {
      const value = fs.readFileSync(candidate, 'utf8').trim();
      if (value) return sanitizeRenderableText(value);
    } catch {
      // Best-effort local fact collection; missing board files are expected on PCs.
    }
  }
  return null;
}

function localBoardModel(): string | null {
  return process.env.RDK_MODEL
    || readFirstExisting(['/proc/device-tree/model', '/sys/firmware/devicetree/base/model']);
}

function localOsName(): string {
  try {
    const raw = fs.readFileSync('/etc/os-release', 'utf8');
    const pretty = raw.match(/^PRETTY_NAME=(.*)$/m)?.[1] || raw.match(/^NAME=(.*)$/m)?.[1];
    return pretty ? pretty.replace(/^"|"$/g, '') : `${process.platform} ${process.arch}`;
  } catch {
    return `${process.platform} ${process.arch}`;
  }
}

function localMemoryLabel(): string {
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = Number(raw.match(/^MemTotal:\s+(\d+)/m)?.[1]);
    if (Number.isFinite(kb) && kb > 0) return `${Math.round(kb / 1024 / 1024)}GB RAM`;
  } catch {
    // Not Linux or procfs unavailable.
  }
  return 'memory unknown';
}

function localTemperatureLabel(): string {
  try {
    const thermalRoot = '/sys/class/thermal';
    const zones = fs.readdirSync(thermalRoot).filter((name) => name.startsWith('thermal_zone'));
    for (const zone of zones) {
      const raw = fs.readFileSync(path.join(thermalRoot, zone, 'temp'), 'utf8').trim();
      const milli = Number(raw);
      if (Number.isFinite(milli) && milli > 0) return `${Math.round(milli / 1000)}C`;
    }
  } catch {
    // Thermal zones are board/OS specific.
  }
  return 'temperature unknown';
}

function localNpuLabel(): string {
  const candidates = ['/dev/bpu0', '/dev/hobot_bpu', '/dev/jpu', '/sys/class/bpu'];
  return candidates.some((candidate) => fs.existsSync(candidate)) ? 'NPU present' : 'NPU unknown';
}

function localCameraLabel(): string {
  try {
    const count = fs.readdirSync('/dev').filter((name) => /^video\d+$/.test(name)).length;
    if (count > 0) return `${count} camera node${count === 1 ? '' : 's'}`;
  } catch {
    // /dev may be unavailable in tests or restricted containers.
  }
  return 'camera unknown';
}

function localRosLabel(): string {
  if (process.env.TROS_DISTRO) return `TROS ${process.env.TROS_DISTRO}`;
  if (process.env.ROS_DISTRO) return `ROS ${process.env.ROS_DISTRO}`;
  return 'ROS graph unknown';
}

function localServiceLabel(): string {
  try {
    const procEntries = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
    let count = 0;
    for (const pid of procEntries.slice(0, 1024)) {
      try {
        const comm = fs.readFileSync(path.join('/proc', pid, 'comm'), 'utf8').toLowerCase();
        if (/moss|ros|tros|hobot|bpu|camera/.test(comm)) count += 1;
      } catch {
        // Process may have exited between readdir and read.
      }
    }
    return `${count} related service${count === 1 ? '' : 's'} seen`;
  } catch {
    return 'services unknown';
  }
}

export function inferExecutionMode(runtime?: CliRuntimeStatus): ExecutionMode {
  if (process.env.DMOSS_HYBRID_MODE === '1') return 'hybrid';
  if (runtime?.meshEnabled && runtime?.device) return 'hybrid';
  if (isLikelyBoardRuntime()) return 'on-board';
  return 'pc-host';
}

function modeLabel(mode: ExecutionMode): string {
  if (mode === 'on-board') return 'On-board Agent';
  if (mode === 'hybrid') return 'Hybrid Agent';
  return 'PC Host Agent';
}

function runningOnLabel(mode: ExecutionMode): string {
  if (mode === 'on-board') return localBoardModel() || 'local RDK board';
  if (mode === 'hybrid') return `${process.platform}/${process.arch} host + board runtime`;
  return `${process.platform}/${process.arch} host`;
}

export function boardSurfaceLabel(runtime?: CliRuntimeStatus): string {
  const mode = inferExecutionMode(runtime);
  if (mode === 'on-board') return 'current machine is the board';
  if (mode === 'hybrid' && runtime?.device) return `host -> board Moss ${runtime.device.user || 'root'}@${runtime.device.host}`;
  if (runtime?.device) return `remote board ${runtime.device.user || 'root'}@${runtime.device.host}`;
  return 'no board target';
}

function inferenceRouteLabel(runtime?: CliRuntimeStatus): string {
  if (process.env.DMOSS_INFERENCE_ROUTE) return process.env.DMOSS_INFERENCE_ROUTE;
  const baseUrl = runtime?.baseUrl || runtime?.config?.baseUrl || '';
  const provider = runtime?.config?.provider || 'unknown';
  if (/localhost|127\.0\.0\.1|::1/.test(baseUrl)) {
    return inferExecutionMode(runtime) === 'on-board' ? 'local board inference' : 'local host inference';
  }
  if (provider === 'qwen' || provider === 'openai' || provider === 'anthropic') return `cloud routed (${provider})`;
  return provider === 'unknown' ? 'inference route unknown' : `routed (${provider})`;
}

function permissionBoundaryLabel(runtime?: CliRuntimeStatus): string {
  const safety = runtime?.config?.safetyMode || runtime?.safetyMode || 'workspace-write';
  const approval = runtime?.config?.approvalPolicy || 'prompt';
  if (safety === 'read-only') return 'diagnose allowed, repair blocked';
  if (approval === 'prompt') return 'diagnose allowed, repair requires approval';
  return 'diagnose and repair allowed by policy';
}

function runtimePolicyLabel(runtime?: CliRuntimeStatus): string {
  const safety = runtime?.config?.safetyMode || runtime?.safetyMode || 'workspace-write';
  const approval = runtime?.config?.approvalPolicy || 'prompt';
  const fsPolicy = safety === 'read-only'
    ? 'read-only fs'
    : safety === 'full-access'
      ? 'full fs with policy gates'
      : 'workspace/runtime fs';
  const processPolicy = approval === 'prompt'
    ? 'process/service changes require approval'
    : 'process/service changes auto-approved';
  const networkPolicy = runtime?.meshEnabled ? 'mesh/network enabled' : 'network via approved tools';
  return `${fsPolicy}  ·  ${processPolicy}  ·  ${networkPolicy}  ·  lifecycle install/upgrade/recover/uninstall requires evidence`;
}

function connectUnlockLine(runtime?: CliRuntimeStatus): string {
  if (inferExecutionMode(runtime) === 'on-board' || runtime?.device) return 'device workflows unlocked';
  return 'Connect a board to unlock: device diagnosis, model deployment, sensor bring-up, ROS/tros debugging, log collection';
}

function deviceContextLine(runtime?: CliRuntimeStatus): string {
  const mode = inferExecutionMode(runtime);
  if (mode === 'on-board') {
    return [
      localBoardModel() || 'RDK board',
      localOsName(),
      localNpuLabel(),
      localCameraLabel(),
      localRosLabel(),
      localServiceLabel(),
      localMemoryLabel(),
      localTemperatureLabel(),
    ].join('  ·  ');
  }
  if (runtime?.device) {
    return `remote board ${runtime.device.host}:${runtime.device.port || 22}  ·  device facts available after diagnose`;
  }
  return 'no live board context  ·  local workspace only';
}

export function executionPlaneSummary(runtime?: CliRuntimeStatus): DeviceContextSummary {
  const mode = inferExecutionMode(runtime);
  return {
    mode,
    runningOn: runningOnLabel(mode),
    targetDevice: boardSurfaceLabel(runtime),
    inference: inferenceRouteLabel(runtime),
    permissions: permissionBoundaryLabel(runtime),
    policy: runtimePolicyLabel(runtime),
    deviceContext: deviceContextLine(runtime),
    lockedCapabilities: connectUnlockLine(runtime),
  };
}

export function boardTip(runtime?: CliRuntimeStatus): string {
  const mode = inferExecutionMode(runtime);
  if (mode === 'on-board') return 'On-board Moss verifies by changing device state and returning logs, metrics, and service evidence.';
  if (mode === 'hybrid') return 'Hybrid Moss routes development from host to board runtime with operator approval.';
  if (runtime?.device) return 'PC Host Moss uses SSH/bridge tools for board diagnostics; ! stays on the host.';
  return 'Connect an RDK board to move from repo-only help to hardware verification.';
}

function compactWelcomeTip(tip: string): string {
  if (tip.startsWith('Connect an RDK board')) return 'Connect a board for hardware verification.';
  if (tip.startsWith('PC Host Moss uses SSH')) return 'SSH tools target the board; ! stays on this host.';
  if (tip.startsWith('Hybrid Moss')) return 'Hybrid routes host work to board runtime with approval.';
  if (tip.startsWith('On-board Moss')) return 'On-board Moss proves changes with device evidence.';
  return tip;
}

export function footerHint(state: TuiRunState): string {
  if (state === 'approval') return 'y approve · a always this session · n/Esc deny';
  if (state === 'running') return 'Esc cancel · Enter queue · /queue clear · Ctrl+C exit';
  return 'Ctrl+O tools · Tab complete · Up/Down history · /help · Ctrl+C exit';
}

export function editorPreviewLines(value: string, placeholder: string, maxLines = 8): string[] {
  if (!value) return [placeholder];
  const normalized = sanitizeRenderableText(value).replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length <= maxLines) return lines;
  return [
    `... ${lines.length - maxLines} earlier input lines ...`,
    ...lines.slice(-maxLines),
  ];
}

export interface PromptEditState {
  value: string;
  cursor: number;
}

export type PromptEditIntent =
  | { type: 'insert'; text: string }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'killBefore' }
  | { type: 'killAfter' }
  | { type: 'deletePreviousWord' };

function clampPromptCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return value.length;
  return Math.max(0, Math.min(value.length, Math.trunc(cursor)));
}

function previousCodePointStart(value: string, cursor: number): number {
  const index = clampPromptCursor(value, cursor);
  if (index <= 0) return 0;
  const previous = value.charCodeAt(index - 1);
  const beforePrevious = index > 1 ? value.charCodeAt(index - 2) : 0;
  if (previous >= 0xdc00 && previous <= 0xdfff && beforePrevious >= 0xd800 && beforePrevious <= 0xdbff) {
    return index - 2;
  }
  return index - 1;
}

function nextCodePointEnd(value: string, cursor: number): number {
  const index = clampPromptCursor(value, cursor);
  if (index >= value.length) return value.length;
  const current = value.charCodeAt(index);
  const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
  if (current >= 0xd800 && current <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    return index + 2;
  }
  return index + 1;
}

function previousWordStart(value: string, cursor: number): number {
  let index = clampPromptCursor(value, cursor);
  while (index > 0 && /\s/.test(value[index - 1] || '')) index -= 1;
  while (index > 0 && !/\s/.test(value[index - 1] || '')) index -= 1;
  return index;
}

export function applyPromptEdit(state: PromptEditState, intent: PromptEditIntent): PromptEditState {
  const value = state.value;
  const cursor = clampPromptCursor(value, state.cursor);
  switch (intent.type) {
    case 'insert': {
      const text = intent.text.replace(/\r\n?/g, '\n');
      return {
        value: `${value.slice(0, cursor)}${text}${value.slice(cursor)}`,
        cursor: cursor + text.length,
      };
    }
    case 'left':
      return { value, cursor: previousCodePointStart(value, cursor) };
    case 'right':
      return { value, cursor: nextCodePointEnd(value, cursor) };
    case 'home':
      return { value, cursor: 0 };
    case 'end':
      return { value, cursor: value.length };
    case 'backspace':
      if (cursor === 0) return { value, cursor };
      {
        const start = previousCodePointStart(value, cursor);
        return { value: `${value.slice(0, start)}${value.slice(cursor)}`, cursor: start };
      }
    case 'delete':
      if (cursor >= value.length) return { value, cursor };
      return { value: `${value.slice(0, cursor)}${value.slice(nextCodePointEnd(value, cursor))}`, cursor };
    case 'killBefore':
      return { value: value.slice(cursor), cursor: 0 };
    case 'killAfter':
      return { value: value.slice(0, cursor), cursor };
    case 'deletePreviousWord': {
      const start = previousWordStart(value, cursor);
      return { value: `${value.slice(0, start)}${value.slice(cursor)}`, cursor: start };
    }
  }
}

export function shouldPromptReturnInsertNewline(key: { shift?: boolean; ctrl?: boolean }): boolean {
  return Boolean(key.shift);
}

interface EditorPreviewLine {
  text: string;
  cursorColumn: number | null;
}

function editorPreviewLinesWithCursor(
  value: string,
  _placeholder: string,
  cursor: number,
  maxLines = 8,
): EditorPreviewLine[] {
  if (!value) return [{ text: '', cursorColumn: 0 }];
  const normalized = sanitizeRenderableText(value).replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const normalizedCursor = clampPromptCursor(normalized, cursor);
  const beforeCursor = normalized.slice(0, normalizedCursor);
  const cursorLineIndex = beforeCursor.split('\n').length - 1;
  const cursorColumn = beforeCursor.slice(beforeCursor.lastIndexOf('\n') + 1).length;
  if (lines.length <= maxLines) {
    return lines.map((line, index) => ({
      text: line,
      cursorColumn: index === cursorLineIndex ? cursorColumn : null,
    }));
  }
  const hiddenCount = lines.length - maxLines;
  return [
    { text: `... ${hiddenCount} earlier input lines ...`, cursorColumn: null },
    ...lines.slice(-maxLines).map((line, index) => {
      const originalIndex = hiddenCount + index;
      return {
        text: line,
        cursorColumn: originalIndex === cursorLineIndex ? cursorColumn : null,
      };
    }),
  ];
}

export function commandSuggestion(command: string): string | null {
  const normalized = command.trim().toLowerCase();
  if (!normalized.startsWith('/')) return null;
  const preferSubcommand = normalized.includes(' ');
  const scored = KNOWN_COMMANDS
    .map((known, index) => {
      const prefixMatch = known.startsWith(normalized) || normalized.startsWith(known);
      if (prefixMatch) return { known, score: 0, prefixMatch, index };
      let score = Math.abs(known.length - normalized.length);
      const limit = Math.min(known.length, normalized.length);
      for (let i = 0; i < limit; i += 1) {
        if (known[i] !== normalized[i]) score += 1;
      }
      return { known, score, prefixMatch, index };
    })
    .sort((a, b) => (
      a.score - b.score
      || Number(b.prefixMatch) - Number(a.prefixMatch)
      || (a.prefixMatch && b.prefixMatch
        ? (preferSubcommand ? b.known.length - a.known.length : a.index - b.index)
        : a.index - b.index)
    ));
  const best = scored[0];
  return best && best.score <= 3 ? best.known : null;
}

function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0] || '';
  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

export function completeSlashCommandInput(value: string, cursor: number): PromptEditState | null {
  const currentCursor = clampPromptCursor(value, cursor);
  const beforeCursor = value.slice(0, currentCursor);
  const afterCursor = value.slice(currentCursor);
  if (!beforeCursor.startsWith('/') || /\s/.test(beforeCursor)) return null;
  if (afterCursor && !/^\s/.test(afterCursor)) return null;

  const normalized = beforeCursor.toLowerCase();
  const exactCandidates = KNOWN_COMMANDS.filter((command) => command.startsWith(normalized));
  const completion = exactCandidates.length > 0
    ? commonPrefix(exactCandidates)
    : commandSuggestion(normalized);
  if (!completion || completion === beforeCursor) return null;
  return {
    value: `${completion}${afterCursor}`,
    cursor: completion.length,
  };
}

export function promptPlaceholder(state: TuiRunState): string {
  if (state === 'approval') return 'answer approval with y, a, n, or Esc';
  if (state === 'running') return 'running... /stop to cancel';
  return 'Ask Moss for code, board, or ROS help';
}

export function statusBadge(state: TuiRunState): string {
  if (state === 'approval') return 'approval needed';
  if (state === 'running') return 'running';
  return 'ready';
}

export function approvalKeyDecision(inputChar: string, key: { escape?: boolean }): 'allow-once' | 'allow-always' | 'deny' | null {
  const normalized = inputChar.toLowerCase();
  if (key.escape || normalized === 'n') return 'deny';
  if (normalized === 'y') return 'allow-once';
  if (normalized === 'a') return 'allow-always';
  return null;
}

function renderMemory(workspace: string): string {
  const memDir = path.join(workspace, '.dmoss-runtime', 'memory');
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(memDir, 'index.json'), 'utf-8')) as Array<{ id: string; content: string }>;
    const shown = entries.slice(0, 5).map((entry) => `  • [${entry.id}] ${entry.content.slice(0, 80)}...`);
    return [`Memory: ${entries.length} entries`, ...shown].join('\n');
  } catch {
    return 'Memory: no entries stored yet.';
  }
}

function formatSkillLine(skill: SkillMeta): string {
  const tags = skill.tags.length > 0 ? ` · ${skill.tags.slice(0, 3).join(', ')}` : '';
  const disabled = skill.enabled ? '' : ' · disabled';
  const description = visibleText(skill.description, 1);
  return `  • ${skill.name} · ${skill.risk}${disabled}${tags} - ${description}`;
}

function listLearnedSkillFiles(workspace: string): string[] {
  const learnedDir = path.join(workspace, 'skills', 'learned');
  try {
    return fs.readdirSync(learnedDir)
      .filter((file) => file.endsWith('.md'))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export function renderSkills(workspace: string): string {
  const learned = listLearnedSkillFiles(workspace);
  let registered: SkillMeta[] = [];
  try {
    registered = new SkillRegistry({ workspaceDir: workspace }).list();
  } catch {
    registered = [];
  }
  const lines = [
    `Skills: ${registered.length} available, ${learned.length} learned`,
  ];
  if (registered.length > 0) {
    lines.push('Available SKILL.md entries:');
    lines.push(...registered.slice(0, 8).map(formatSkillLine));
    if (registered.length > 8) lines.push(`  ... ${registered.length - 8} more available skill${registered.length - 8 === 1 ? '' : 's'}`);
  } else {
    lines.push('Available SKILL.md entries: none found in skills/ or agent/skills/.');
  }
  if (learned.length > 0) {
    lines.push('Learned skills:');
    lines.push(...learned.slice(0, 8).map((file) => `  • ${file}`));
    if (learned.length > 8) lines.push(`  ... ${learned.length - 8} more learned skill${learned.length - 8 === 1 ? '' : 's'}`);
  } else {
    lines.push('Learned skills: none yet.');
  }
  return lines.join('\n');
}

function modelExamples(currentModel: string): string {
  return [
    `Current model: ${currentModel}`,
    'Switch with: /model <model-name>',
    'Examples:',
    '  /model gpt-4o',
    '  /model qwen-plus',
    '  /model deepseek-chat',
  ].join('\n');
}

function summarizeToolInput(input: unknown, maxChars = 80): string {
  if (input === undefined || input === null) return '';
  let raw: string;
  try {
    raw = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    raw = String(input);
  }
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Pull the most informative arg out of a tool input for the headline.
 * Examples:
 *   { path: 'src/foo.ts' }            → 'src/foo.ts'
 *   { command: 'npm run build' }      → 'npm run build'
 *   { query: 'authStore' }            → 'authStore'
 *   { url: 'https://...' }            → 'https://...'
 * Falls back to summarizeToolInput.
 */
function toolHeadline(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return summarizeToolInput(input, HEADLINE_MAX);
  if (typeof input !== 'object') return String(input);
  const obj = input as Record<string, unknown>;
  const preferred = ['path', 'file_path', 'filepath', 'file', 'command', 'cmd', 'query', 'pattern', 'url', 'symbol', 'task', 'description', 'subject'];
  for (const key of preferred) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      const compact = value.replace(/\s+/g, ' ').trim();
      return compact.length > HEADLINE_MAX ? `${compact.slice(0, HEADLINE_MAX - 1).trimEnd()}…` : compact;
    }
  }
  return summarizeToolInput(input, HEADLINE_MAX);
}

function humanTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(Math.round(n));
}

/** Progressive color for context usage: green → amber → orange → red. */
function ctxUsageBarColor(usage: { used: number; total: number }): string {
  const pct = usage.total > 0 ? (usage.used / usage.total) * 100 : 0;
  if (pct >= 90) return theme.error;
  if (pct >= 70) return theme.warn;
  if (pct >= 50) return theme.primarySoft;
  return theme.success;
}

function activityLabel(event: DmossAgentEvent): string | null {
  if (event.type === 'compaction') return `compacted ${event.droppedMessages} messages`;
  if (event.type === 'microcompact') return `compressed ${event.compressedCount} items`;
  if (event.type === 'working_context_checkpoint') return `${event.status}`;
  return null;
}

function toolOutcomeLabel(item: ActivityItem): string {
  if (!item.outcome) return '';
  if (item.outcome === 'ok') return '';
  return `${item.outcome} · `;
}

function transcriptColor(kind: TranscriptKind): 'cyan' | 'red' | 'gray' | 'green' | 'magenta' | undefined {
  if (kind === 'user') return 'cyan';
  if (kind === 'error') return 'red';
  if (kind === 'shell') return 'green';
  if (kind === 'tool') return 'gray';
  if (kind === 'system') return 'gray';
  return undefined;
}

function statusBarColor(state: TuiRunState): string {
  if (state === 'approval') return theme.warn;
  if (state === 'running') return theme.tool;
  return theme.success;
}

let markdownRendererConfigured = false;
function ensureMarkdownRenderer(): void {
  if (markdownRendererConfigured) return;
  marked.setOptions({ mangle: false, headerIds: false } as Parameters<typeof marked.setOptions>[0]);
  // marked-terminal's runtime extension shape is valid for marked.use(), but
  // its current .d.ts does not model the MarkedExtension intersection.
  // Tone down the default colors so the outer theme drives accent — code/quote
  // become dim, headings keep bold so they remain scannable.
  marked.use(markedTerminal({
    reflowText: false,
    code: ui.dim,
    blockquote: ui.dim,
    codespan: ui.cyan,
    listitem: (text: string) => `  • ${text}`,
  }) as unknown as Parameters<typeof marked.use>[0]);
  markdownRendererConfigured = true;
}

export function renderMarkdown(text: string): string {
  ensureMarkdownRenderer();
  return sanitizeRenderableText(marked.parse(text) as string).trimEnd();
}

// ────────────────────────────────────────────────────────────────────────────
// Components
// ────────────────────────────────────────────────────────────────────────────

export interface StatusBarProps {
  state: TuiRunState;
  device: string;
  workspace: string;
  version: string;
  notice?: string;
  model?: string;
  ctxUsage?: { used: number; total: number };
  flashHint?: string;
  hint?: string;
}

export interface SessionHeaderProps {
  device: string;
  workspace: string;
  model?: string;
  state: TuiRunState;
  toolsExpanded?: boolean;
  version?: string;
  cacheMode?: string;
  profile?: string;
}

export function SessionHeader({ device: _device, workspace, model, state: _state, toolsExpanded: _toolsExpanded, version, cacheMode: _cacheMode, profile: _profile }: SessionHeaderProps): React.ReactElement {
  // Claude-code-style welcome card: one rounded box holding the RDK mark, a help
  // hint, cwd and model — the same shape as Claude Code's launch panel. The RDK
  // orange/cyan mark is the only RDK-branded element.
  const cursor = emojiEnabled() ? '▪' : '#';
  return React.createElement(
    Box,
    // flexShrink:0 so the bordered card is NEVER squashed when the transcript is
    // tall — without it Yoga shrinks this multi-line box and its lines overlap
    // (the garbled "model: …cwd…" header in the bug report).
    { flexDirection: 'column', flexShrink: 0, borderStyle: 'round', borderColor: theme.claude, paddingX: 1, marginBottom: 1 },
    React.createElement(Text, null,
      React.createElement(Text, { color: BRAND_ORANGE, bold: true }, '>_'),
      React.createElement(Text, { color: BRAND_CYAN }, ` ${cursor}  `),
      React.createElement(Text, { color: theme.claude, bold: true }, 'RDK Studio'),
      React.createElement(Text, { color: theme.textDim }, version ? `  ${version}` : ''),
    ),
    React.createElement(Text, null, ''),
    React.createElement(Text, { color: theme.textMuted }, '  /help for help, /status for your current setup'),
    React.createElement(Text, { color: theme.textMuted }, `  cwd: ${compactPath(workspace)}`),
    React.createElement(Text, { color: theme.textMuted }, `  model: ${model || 'connecting…'}`),
  );
}

/**
 * Single-line status bar:
 *   Default  ready  ctx 21k/200k (10%)  ─────  model  |  Ctrl+O expand · /help
 * Colors:
 *   - mode (Default): primary
 *   - status: state-dependent (green/cyan/amber)
 *   - ctx %: muted < 70 < amber < 90 < red
 *   - rest: dim
 */
export function StatusBar({ state, device, workspace, version, notice, model, ctxUsage, flashHint, hint }: StatusBarProps): React.ReactElement {
  const ctxPct = ctxUsage && ctxUsage.total > 0 ? (ctxUsage.used / ctxUsage.total) * 100 : null;
  const ctxColor = ctxPct === null
    ? theme.textDim
    : ctxPct >= 90 ? theme.error
    : ctxPct >= 70 ? theme.warn
    : theme.textMuted;
  const ctxLabel = ctxUsage
    ? `ctx ${humanTokens(ctxUsage.used)}/${humanTokens(ctxUsage.total)} (${Math.round(ctxPct ?? 0)}%)`
    : '';

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    notice ? React.createElement(Text, { color: theme.warn }, notice) : null,
    React.createElement(
      Box,
      { flexDirection: 'row', borderStyle: 'single', borderTop: true, borderBottom: false, borderLeft: false, borderRight: false, borderColor: theme.border },
      // Run mode label (kept subtle, Claude-code low-noise status line)
      React.createElement(Text, { color: theme.textMuted, bold: true }, 'Default'),
      React.createElement(Text, { color: theme.textMuted }, '  '),
      // Status badge + live spinner while the agent is working (self-animating;
      // re-renders on its own interval so the run never looks frozen)
      React.createElement(Text, { color: statusBarColor(state), bold: true }, statusBadge(state)),
      state === 'running'
        ? React.createElement(StreamingSpinner, { active: true })
        : null,
      React.createElement(Text, { color: theme.textMuted }, '  '),
      // Context window usage
      ctxLabel ? React.createElement(Text, { color: ctxColor }, ctxLabel) : null,
      ctxLabel ? React.createElement(Text, { color: theme.textMuted }, '  ') : null,
      // Flash hint (transient: tools expanded/collapsed)
      flashHint ? React.createElement(Text, { color: theme.warn }, flashHint) : null,
      flashHint ? React.createElement(Text, { color: theme.textMuted }, '  ') : null,
      // Spacer
      React.createElement(Box, { flexGrow: 1 }),
      // Right side: device · workspace · model · version · hint
      React.createElement(Text, { color: theme.textMuted },
        `${device}  ·  ${compactPath(workspace)}  ·  ${model || 'connecting...'}  ·  ${version}${hint ? `  |  ${hint}` : ''}`,
      ),
    ),
  );
}

export interface WelcomePanelProps {
  workspace: string;
  device: string;
  model?: string;
  cacheMode?: string;
  profile?: string;
  executionPlane?: DeviceContextSummary;
  tip?: string;
  compact?: boolean;
}

export function WelcomePanel({
  workspace,
  device: _device,
  model: _model,
  cacheMode: _cacheMode,
  profile: _profile,
  executionPlane,
  tip,
  compact = false,
}: WelcomePanelProps): React.ReactElement {
  const plane = executionPlane ?? executionPlaneSummary();
  const resolvedTip = tip ?? boardTip();
  // Claude-code-style minimal welcome: one slim context line, a compact "Try"
  // hint, the board tip, and the key hints. Heavy device block intentionally
  // de-emphasized (the RDK logo + context now live in SessionHeader).
  if (compact) {
    return React.createElement(
      Box,
      { flexDirection: 'column', marginBottom: 1 },
      React.createElement(Text, { color: theme.textMuted },
        `  ${modeLabel(plane.mode)} · ${plane.targetDevice} · ${compactPath(workspace)}`),
      React.createElement(Text, null,
        React.createElement(Text, { color: theme.textMuted }, '  Tip: '),
        compactWelcomeTip(resolvedTip),
      ),
    );
  }
  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1, marginBottom: 1 },
    React.createElement(Text, { color: theme.textMuted }, ' Tips for getting started:'),
    React.createElement(Text, null, ' '),
    ...DEVICE_WORKFLOWS.map((workflow, i) => React.createElement(Text, { key: workflow.title },
      React.createElement(Text, { color: theme.textMuted }, ` ${i + 1}. `),
      React.createElement(Text, { color: theme.text }, workflow.title),
      React.createElement(Text, { color: theme.textMuted }, ` — ${workflow.description}`),
    )),
    React.createElement(Text, null, ' '),
    React.createElement(Text, { color: theme.textDim }, ` ${resolvedTip}`),
  );
}

export interface ActivityItemLineProps {
  item: ActivityItem;
  expanded?: boolean;
}

/**
 * Tool call block. Always renders one-line headline:
 *   {icon} {toolName} · {headline}  {elapsed|…|!}
 * When expanded, appends the full input JSON below (indented).
 *
 * Test contract (cli-tui-render.spec.mjs):
 *   - running tool shows "…"
 *   - completed tool shows "<elapsed>ms"
 *   - failed tool contains "!"
 *   - inputSummary content stays visible
 */
export function ActivityItemLine({ item, expanded }: ActivityItemLineProps): React.ReactElement {
  const bullet = emojiEnabled() ? '⏺' : '*';
  const connector = emojiEnabled() ? '⎿' : 'L';
  const bulletColor = item.status === 'failed' ? theme.error : theme.claude;
  const headline = item.inputSummary || '';
  const elapsedText = item.status === 'running'
    ? '…'
    : ` ${toolOutcomeLabel(item)}${item.elapsedMs ?? 0}ms`;
  const failedMark = item.status === 'failed' ? ' !' : '';

  // Claude-code headline: `⏺ Tool (summary)  <elapsed>`. Keep the test-required
  // tokens (… / ms / !) and the input summary visible.
  const headEl = React.createElement(Text, null,
    React.createElement(Text, { color: bulletColor, bold: true }, `${bullet} `),
    React.createElement(Text, { color: theme.text, bold: true }, item.toolName),
    headline ? React.createElement(Text, { color: theme.textMuted }, ` (${headline})`) : null,
    React.createElement(Text, { color: theme.textDim }, elapsedText),
    failedMark ? React.createElement(Text, { color: theme.error, bold: true }, failedMark) : null,
  );

  // 展开详情：代码改动工具渲染彩色 diff，其余工具显示真实输出(result)，最后回退 input JSON。
  let detailLines: React.ReactElement[] = [];
  if (expanded) {
    const raw = item.inputRaw as Record<string, unknown> | undefined;
    const patch = raw?.patch;
    const content = raw?.content;
    if (item.toolName === 'apply_patch' && typeof patch === 'string') {
      detailLines = patch.split('\n').slice(0, 80).map((line, idx) => React.createElement(Text, {
        key: idx,
        color: (line.startsWith('+') && !line.startsWith('+++')) ? theme.diffAddedWord
          : (line.startsWith('-') && !line.startsWith('---')) ? theme.diffRemovedWord
          : (line.startsWith('@@') || line.startsWith('***')) ? theme.claude
          : theme.textDim,
      }, line));
    } else if (item.toolName === 'write_file' && typeof content === 'string') {
      detailLines = content.split('\n').slice(0, 80).map((line, idx) =>
        React.createElement(Text, { key: idx, color: theme.diffAddedWord }, `+ ${line}`));
    } else if (typeof item.result === 'string' && item.result.trim()) {
      detailLines = item.result.split('\n').slice(0, 40).map((line, idx) =>
        React.createElement(Text, { key: idx, color: theme.textDim }, line));
    } else if (item.inputRaw !== undefined) {
      let json = '';
      try { json = typeof item.inputRaw === 'string' ? item.inputRaw : JSON.stringify(item.inputRaw, null, 2); }
      catch { json = String(item.inputRaw); }
      detailLines = json.split('\n').slice(0, 24).map((line, idx) =>
        React.createElement(Text, { key: idx, color: theme.textDim }, line));
    }
  }

  if (detailLines.length > 0) {
    return React.createElement(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      headEl,
      React.createElement(Box, { flexDirection: 'row' },
        React.createElement(Text, { color: theme.textDim }, `  ${connector}  `),
        React.createElement(Box, { flexDirection: 'column' }, ...detailLines),
      ),
    );
  }

  return React.createElement(
    Box,
    { marginTop: 1, flexDirection: 'column' },
    headEl,
  );
}

export interface ApprovalPromptLineProps {
  question: string;
}

export function ApprovalPromptLine({ question }: ApprovalPromptLineProps): React.ReactElement {
  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: theme.permission,
      paddingX: 1,
    },
    React.createElement(Text, { color: theme.permission, bold: true }, '? permission requested'),
    ...visibleText(question, 8).split('\n').map((line, idx) => (
      React.createElement(Text, { key: idx, color: theme.text }, line)
    )),
    React.createElement(Text, { color: theme.textMuted }, 'y approve · a always this session · n/Esc deny'),
  );
}

export interface TranscriptMessageProps {
  item: TranscriptItem;
}

function sideRule(options: {
  id: number;
  text: string;
  ruleColor: string;
  textColor?: string;
  prefix?: string;
}): React.ReactElement {
  const lines = visibleText(options.text).split('\n');
  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      marginTop: 1,
      paddingLeft: 1,
      borderStyle: 'single',
      borderLeft: true,
      borderTop: false,
      borderBottom: false,
      borderRight: false,
      borderColor: options.ruleColor,
    },
    options.prefix
      ? React.createElement(Text, { color: options.ruleColor, bold: true }, options.prefix)
      : null,
    ...lines.map((line, index) => React.createElement(Text, {
      key: `${options.id}-${index}`,
      color: options.textColor ?? theme.text,
    }, `  ${line || ' '}`)),
  );
}

export function TranscriptMessage({ item, model, toolsExpanded }: TranscriptMessageProps & { model?: string; toolsExpanded?: boolean }): React.ReactElement {
  if (item.kind === 'tool' && item.toolName) {
    return React.createElement(ActivityItemLine, {
      item: {
        id: `${item.id}`,
        toolName: item.toolName,
        toolCallId: item.toolCallId ?? `${item.id}`,
        startedAt: item.startedAt ?? 0,
        status: item.status ?? 'ok',
        inputSummary: item.toolInput,
        elapsedMs: item.elapsedMs,
        outcome: item.outcome,
        inputRaw: item.toolInputRaw,
        result: item.result,
      },
      expanded: toolsExpanded,
    });
  }
  if (item.kind === 'shell') {
    return sideRule({ id: item.id, text: item.text, ruleColor: theme.tool, textColor: theme.textMuted });
  }
  if (item.kind === 'assistant' && !item.finalized) {
    const refs = extractAttachmentRefs(item.text);
    return React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      React.createElement(Text, { color: theme.text }, visibleText(item.text)),
      React.createElement(Text, { color: theme.claude }, '●'),
      ...refs.map((ref) => React.createElement(Text, {
        key: `${item.id}-${ref.label}`,
        color: ref.kind === 'image' ? theme.primary : theme.warn,
      }, formatAttachmentChip(ref))),
    );
  }
  if (item.kind === 'assistant' && item.finalized) {
    const rendered = renderMarkdown(item.text);
    return React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 1, marginBottom: 1 },
      React.createElement(Text, { color: theme.text }, rendered || visibleText(item.text)),
      model ? React.createElement(Text, { color: theme.textDim }, model) : null,
    );
  }
  if (item.kind === 'user') {
    // Claude-code-style echo: plain text on a subtle grey block, no border.
    const lines = visibleText(item.text).split('\n');
    return React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      ...lines.map((line, idx) => React.createElement(Text, {
        key: `${item.id}-${idx}`,
        backgroundColor: theme.userMessageBackground,
        color: '#f5f5f5', // fixed light fg on the dark echo block (readable on any terminal bg)
      }, ` ${line || ' '} `)),
    );
  }
  if (item.kind === 'error') {
    const refs = extractAttachmentRefs(item.text);
    const lines = visibleText(item.text).split('\n');
    const mark = emojiEnabled() ? '⏺' : '!';
    return React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      React.createElement(Text, null,
        React.createElement(Text, { color: theme.error, bold: true }, `${mark} `),
        React.createElement(Text, { color: theme.error }, lines[0] || 'error'),
      ),
      ...lines.slice(1).map((line, idx) => React.createElement(Text, {
        key: `${item.id}-${idx}`,
        color: theme.error,
      }, `  ${line || ' '}`)),
      ...refs.map((ref) => React.createElement(Text, {
        key: `${item.id}-${ref.label}`,
        color: ref.kind === 'image' ? theme.claude : theme.warn,
      }, formatAttachmentChip(ref))),
    );
  }
  // system
  const refs = extractAttachmentRefs(item.text);
  const lines = visibleText(item.text).split('\n');
  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    ...lines.map((line, idx) => React.createElement(Text, {
      key: `${item.id}-${idx}`,
      color: theme.textMuted,
    }, `· ${line || ' '}`)),
    ...refs.map((ref) => React.createElement(Text, {
      key: `${item.id}-${ref.label}`,
      color: ref.kind === 'image' ? theme.primary : theme.warn,
    }, formatAttachmentChip(ref))),
  );
}

export interface PromptEditorProps {
  value: string;
  cursor?: number;
  onChange: (value: string) => void;
  onCursorChange?: (cursor: number) => void;
  onSubmit: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  onHistoryPrevious?: () => void;
  onHistoryNext?: () => void;
  onShiftEnter?: () => void;
  hint?: string;
  model?: string;
  mode?: string;
}

function commandRowsForInput(value: string): Array<[string, string]> {
  if (!value.startsWith('/')) return [];
  const normalized = value.trim().toLowerCase();
  const allRows: Array<[string, string]> = [
    ['/model', 'switch model'],
    ['/status', 'runtime and device'],
    ['/permissions', 'safety and approvals'],
    ['/tools', 'tool surface'],
    ['/sessions', 'recent sessions'],
    ['/queue', 'queued prompts'],
    ['/context', 'context usage'],
    ['/diff', 'git diff'],
    ['/init', 'create AGENTS.md'],
    ['/config', 'config and policy'],
    ['/examples', 'starter tasks'],
    ['/detail', 'quiet/progress/verbose'],
    ['/cost', 'token estimate'],
    ['/rewind', 'undo file changes'],
    ['/thinking', 'thinking deltas'],
    ['/clear', 'clear visible transcript'],
    ['/quit', 'exit D-Moss'],
  ];
  // Full filtered list; the visible window (responsive count + selection
  // centering) is computed at render time so the menu can be navigated/scrolled.
  return normalized === '/'
    ? allRows
    : allRows.filter(([command]) => command.startsWith(normalized));
}

export function promptEditorRowBudget(
  value: string,
  options: { hint?: string; model?: string; placeholder?: string; maxPreviewLines?: number } = {},
): number {
  const maxPreviewLines = options.maxPreviewLines ?? 6;
  let rows = 1; // PromptEditor marginTop.
  const commandRows = commandRowsForInput(value);
  if (commandRows.length > 0) {
    rows += Math.min(6, commandRows.length) + 1; // visible command window (cap 6) plus marginBottom.
  } else if (value.startsWith('/') && commandSuggestion(value)) {
    rows += 1;
  }
  const lineCount = value.length > 0 ? value.split('\n').length : 0;
  if (lineCount > 1) rows += 1;
  rows += editorPreviewLinesWithCursor(
    value,
    options.placeholder ?? '',
    clampPromptCursor(value, value.length),
    maxPreviewLines,
  ).length;
  if (!value && options.placeholder) rows += 1;
  if (options.hint) rows += 1;
  rows += 2; // bordered input box adds top + bottom border rows
  return rows;
}

export function PromptEditor({
  value,
  cursor,
  onChange,
  onCursorChange,
  onSubmit,
  placeholder,
  disabled,
  onHistoryPrevious,
  onHistoryNext,
  onShiftEnter,
  hint,
  model: _model,
  mode,
}: PromptEditorProps): React.ReactElement {
  const lineCount = value.length > 0 ? value.split('\n').length : 0;
  const isMulti = lineCount > 1;
  const currentCursor = clampPromptCursor(value, cursor ?? value.length);
  const applyEdit = (intent: PromptEditIntent): void => {
    const next = applyPromptEdit({ value, cursor: currentCursor }, intent);
    onChange(next.value);
    onCursorChange?.(next.cursor);
  };

  // ── Slash-command menu: navigable + responsive window (Claude-code style) ──
  const { rows: termRows, columns: termColumns } = useTerminalSize();
  const commandRows = commandRowsForInput(value);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const menuOpen = commandRows.length > 0 && !menuDismissed;
  const maxVisibleCommands = Math.max(1, Math.min(6, termRows - 3));
  const clampedMenuIndex = menuOpen ? Math.max(0, Math.min(menuIndex, commandRows.length - 1)) : 0;
  // Window follows the selection (centered, clamped so the last page stays full).
  const menuStart = menuOpen
    ? Math.max(0, Math.min(clampedMenuIndex - Math.floor(maxVisibleCommands / 2), commandRows.length - maxVisibleCommands))
    : 0;
  const menuWindow = menuOpen ? commandRows.slice(menuStart, menuStart + maxVisibleCommands) : [];
  // Typing re-filters → reset selection to the top and re-open a dismissed menu.
  useEffect(() => { setMenuIndex(0); setMenuDismissed(false); }, [value]);

  useInput((inputChar, key) => {
    if (disabled) return;
    // While the command menu is open it owns arrows / Ctrl+n,p / Tab / Enter / Esc.
    if (menuOpen) {
      if (key.upArrow || (key.ctrl && inputChar.toLowerCase() === 'p')) {
        setMenuIndex((i) => (i <= 0 ? commandRows.length - 1 : i - 1));
        return;
      }
      if (key.downArrow || (key.ctrl && inputChar.toLowerCase() === 'n')) {
        setMenuIndex((i) => (i >= commandRows.length - 1 ? 0 : i + 1));
        return;
      }
      if (key.escape) { setMenuDismissed(true); return; }
      if ((key.tab && !key.shift) || inputChar === '\t') {
        const picked = commandRows[clampedMenuIndex]?.[0];
        if (picked) { onChange(picked); onCursorChange?.(picked.length); }
        return;
      }
      if (key.return && !shouldPromptReturnInsertNewline(key)) {
        const picked = commandRows[clampedMenuIndex]?.[0];
        if (picked) { onSubmit(picked); return; }
      }
    }
    if (key.upArrow) {
      onHistoryPrevious?.();
      return;
    }
    if (key.downArrow) {
      onHistoryNext?.();
      return;
    }
    if ((key.tab && !key.shift) || inputChar === '\t') {
      const completion = completeSlashCommandInput(value, currentCursor);
      if (completion) {
        onChange(completion.value);
        onCursorChange?.(completion.cursor);
      }
      return;
    }
    if (key.leftArrow) {
      applyEdit({ type: 'left' });
      return;
    }
    if (key.rightArrow) {
      applyEdit({ type: 'right' });
      return;
    }
    const normalizedInput = inputChar.toLowerCase();
    if (key.ctrl && (normalizedInput === 'a' || inputChar === '\u0001')) {
      applyEdit({ type: 'home' });
      return;
    }
    if (key.ctrl && (normalizedInput === 'e' || inputChar === '\u0005')) {
      applyEdit({ type: 'end' });
      return;
    }
    if (key.ctrl && (normalizedInput === 'u' || inputChar === '\u0015')) {
      applyEdit({ type: 'killBefore' });
      return;
    }
    if (key.ctrl && (normalizedInput === 'k' || inputChar === '\u000b')) {
      applyEdit({ type: 'killAfter' });
      return;
    }
    if (key.ctrl && (normalizedInput === 'w' || inputChar === '\u0017')) {
      applyEdit({ type: 'deletePreviousWord' });
      return;
    }
    if (key.return) {
      if (shouldPromptReturnInsertNewline(key)) {
        applyEdit({ type: 'insert', text: '\n' });
        onShiftEnter?.();
        return;
      }
      onSubmit(value);
      return;
    }
    if (key.backspace) {
      applyEdit({ type: 'backspace' });
      return;
    }
    if (key.delete) {
      applyEdit({ type: 'delete' });
      return;
    }
    if (inputChar) {
      if (inputChar.length === 1 && inputChar.charCodeAt(0) < 32) return;
      // Never type raw escape / mouse-report bytes into the box.
      if (inputChar.includes('\x1b') || isLikelyMouseInput(inputChar)) return;
      applyEdit({ type: 'insert', text: inputChar });
    }
  }, { isActive: !disabled });

  const inputBoxRef = useRef<DOMElement | null>(null);
  const { setCursorPosition } = useCursor();
  // Last cursor coords we pushed, to dedupe and avoid a re-render loop.
  const lastCursorRef = useRef<{ x: number; y: number } | null>(null);
  const [, bumpLayout] = useState(0);

  const lines = editorPreviewLinesWithCursor(value, placeholder, currentCursor, 6);
  const suggestion = value.startsWith('/') ? commandSuggestion(value) : null;
  // Border reflects the active interaction mode (Claude-code style).
  const borderColor = mode === 'plan' ? theme.planMode
    : mode === 'acceptEdits' ? theme.autoAccept
    : theme.promptBorder;

  // Caret cell within the box content (CJK-aware via string-width).
  let caretLineIndex = 0;
  let caretCol = stringWidth('> ');
  if (value) {
    const idx = lines.findIndex((l) => l.cursorColumn !== null);
    if (idx >= 0) {
      caretLineIndex = idx;
      const prefixWidth = idx === 0 ? stringWidth('> ') : 2;
      caretCol = prefixWidth + stringWidth(lines[idx].text.slice(0, lines[idx].cursorColumn ?? 0));
    }
  }

  // Park the REAL terminal cursor at the caret so the terminal's IME composes
  // inline in the box. We MEASURE the input box's absolute content origin FRESH
  // each frame (summing getComputedLeft/Top up the yoga tree) so it stays correct
  // when the box moves — e.g. the command menu opens above it, the transcript
  // grows, or the terminal resizes (the stale-coords version drifted the cursor
  // above the box in exactly those cases). useCursor applies the position on the
  // next commit, so when the target changes we bump a tick to force that commit;
  // it converges within one frame, including parking in the box right after mount
  // (before the first keystroke). A layout effect is used since coords require a
  // post-layout measurement; the dedupe ref prevents a re-render loop.
  useLayoutEffect(() => {
    const node = inputBoxRef.current;
    if (disabled || !node?.yogaNode || !process.stdout.isTTY) {
      if (lastCursorRef.current !== null) {
        lastCursorRef.current = null;
        setCursorPosition(undefined);
      }
      return;
    }
    let bx = 0;
    let by = 0;
    for (let n: DOMElement | undefined = node; n?.yogaNode; n = n.parentNode) {
      bx += n.yogaNode.getComputedLeft();
      by += n.yogaNode.getComputedTop();
    }
    const next = { x: bx + 2 + caretCol, y: by + 1 + caretLineIndex };
    const prev = lastCursorRef.current;
    if (!prev || prev.x !== next.x || prev.y !== next.y) {
      lastCursorRef.current = next;
      setCursorPosition(next);
      bumpLayout((t) => t + 1);
    }
  });

  // Lines inside the bordered input box. Empty input shows a dim ghost
  // placeholder; the visible caret is the real terminal cursor (positioned above).
  const bodyLines: Array<React.ReactElement> = (!value && placeholder)
    ? [React.createElement(Text, { key: 'placeholder' },
        React.createElement(Text, { color: theme.claude, bold: true }, '> '),
        // A leading space sits under the (block) cursor at the input start, so the
        // placeholder text itself is never covered by the caret.
        React.createElement(Text, { color: theme.textMuted }, ` ${placeholder}`),
      )]
    : lines.map((line, index) => React.createElement(
        Text,
        { key: `${index}-${line.text}`, color: theme.text },
        index === 0
          ? React.createElement(Text, { color: theme.claude, bold: true }, '> ')
          : '  ',
        line.text,
      ));

  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    menuOpen ? React.createElement(Box, { flexDirection: 'column', marginBottom: 1, paddingLeft: 1 },
      ...menuWindow.map(([command, description], i) => {
        const isSel = (menuStart + i) === clampedMenuIndex;
        const descMax = Math.max(8, termColumns - 20);
        const desc = description.length > descMax ? `${description.slice(0, descMax - 1)}…` : description;
        const marker = emojiEnabled() ? '❯ ' : '> ';
        return React.createElement(Text, { key: command, wrap: 'truncate' },
          React.createElement(Text, { color: theme.claude, bold: true }, isSel ? marker : '  '),
          React.createElement(Text, { color: theme.permission, bold: isSel, dimColor: !isSel }, command.padEnd(14)),
          React.createElement(Text, { color: theme.textMuted, dimColor: !isSel }, desc),
        );
      }),
    ) : null,
    suggestion && commandRows.length === 0 ? React.createElement(Text, { color: theme.textDim }, `  ${suggestion}`) : null,
    isMulti ? React.createElement(Text, { color: theme.textDim }, `  ${lineCount} lines`) : null,
    React.createElement(
      Box,
      { ref: inputBoxRef, borderStyle: 'round', borderColor, paddingX: 1, flexDirection: 'column' },
      ...bodyLines,
    ),
    hint ? React.createElement(Text, { color: theme.textDim }, `  ${hint}`) : null,
  );
}

export interface QueuePreviewProps {
  items: QueuedInput[];
  paused?: boolean;
  now?: number;
}

export function QueuePreview({ items, paused = false, now = Date.now() }: QueuePreviewProps): React.ReactElement | null {
  if (items.length === 0) return null;
  const visible = items.slice(0, 3);
  const hiddenCount = items.length - visible.length;
  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    React.createElement(Text, { color: theme.textMuted },
      paused
        ? `  queued ${items.length} · paused after stop · /queue resume · send a prompt to resume · /queue drop last · /queue clear all`
        : `  queued ${items.length} · next runs when current task finishes · /queue drop last · /queue clear all`),
    ...visible.map((item, index) => React.createElement(Text, {
      key: `${index}-${item.message}`,
      color: theme.textMuted,
    }, `  ${index === 0 ? 'next' : `#${index + 1}`} · ${queueItemMeta(item, now)} · ${visibleText(item.message, 1)}`)),
    hiddenCount > 0 ? React.createElement(Text, { color: theme.textMuted },
      `  ... ${hiddenCount} more queued prompt${hiddenCount === 1 ? '' : 's'}`) : null,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main TUI
// ────────────────────────────────────────────────────────────────────────────

/** SGR/legacy mouse report bytes that Ink may surface as `input` — handled by the
 *  dedicated stdin listener, so every useInput must ignore them (don't type/act). */
function isLikelyMouseInput(s: string): boolean {
  if (!s) return false;
  return s.includes('\x1b[<') || s.includes('\x1b[M') || /\[<\d+;\d+;\d+[Mm]/.test(s) || /\[M...$/.test(s);
}

const WORKING_FRAMES = ['✶', '✻', '✽', '✻'];
/**
 * Live "the agent is working" line shown above the input while busy. It is a
 * self-animating spinner + an elapsed-seconds counter, so the moving glyph makes
 * it obvious the run is alive (not frozen) — the missing signal users hit when a
 * model turn streams after a tool call and the transcript area looks blank.
 */
function WorkingIndicator(): React.ReactElement {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 200);
    return () => clearInterval(t);
  }, []);
  const glyph = emojiEnabled() ? (WORKING_FRAMES[tick % WORKING_FRAMES.length] ?? '✻') : '*';
  const secs = Math.floor((tick * 200) / 1000);
  return React.createElement(
    Box,
    { paddingX: 1 },
    React.createElement(Text, { color: theme.claude, bold: true }, `${glyph} Working `),
    React.createElement(Text, { color: theme.textDim }, `(${secs}s · esc to interrupt)`),
  );
}

export function DmossTui({ agent, skillLearner, runtime, sessionKey }: DmossTuiProps): React.ReactElement {
  const app = useApp();
  const { rows: termRows } = useTerminalSize();
  const workspace = runtime?.workspace || process.cwd();
  const checkpointRef = useRef<FileCheckpointStore | null>(null);
  if (!checkpointRef.current) {
    checkpointRef.current = new FileCheckpointStore({
      runtimeDir: runtime?.runtimeDir || `${workspace}/.dmoss-runtime`,
      sessionKey,
    });
  }
  const [input, setInput] = useState('');
  const [inputCursor, setInputCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [currentModel, setCurrentModel] = useState(agent.config.model || '');
  const [detailMode, setDetailMode] = useState(process.env.DMOSS_CLI_DETAIL || 'quiet');
  const [showThinking, setShowThinking] = useState(process.env.DMOSS_SHOW_THINKING === 'true');
  const [notice, setNotice] = useState('');
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const [interactionMode, setInteractionMode] = useState<CliInteractionMode>('default');
  const [localShellApproved, setLocalShellApproved] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  // Transcript scrolling (LINE-level, Claude-Code style). The content box is a
  // fixed-height overflow:hidden viewport; an inner box holding ALL items is shifted
  // by `scrollMargin` (computed at render). `scrollUp` = lines scrolled up from the
  // bottom (0 = pinned to the newest line). Heights are measured post-layout so the
  // margin math + max-scroll clamp track the real rendered size.
  const [scrollUp, setScrollUp] = useState(0);
  const [scrollStick, setScrollStick] = useState(true);
  const transcriptViewportRef = useRef<DOMElement | null>(null);
  const transcriptInnerRef = useRef<DOMElement | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const prevContentHeightRef = useRef(0);
  useLayoutEffect(() => {
    const vp = transcriptViewportRef.current;
    if (vp) {
      const h = measureElement(vp).height;
      setViewportHeight((prev) => (prev === h ? prev : h));
    }
    const inner = transcriptInnerRef.current;
    const h = inner ? measureElement(inner).height : 0;
    setContentHeight((prev) => (prev === h ? prev : h));
  });
  // Follow the newest line while sticking; while scrolled up, hold the user's view
  // as content grows by shifting scrollUp by the height delta (in lines).
  useEffect(() => {
    const delta = contentHeight - prevContentHeightRef.current;
    prevContentHeightRef.current = contentHeight;
    if (scrollStick) {
      if (scrollUp !== 0) setScrollUp(0);
    } else if (delta > 0) {
      const maxScroll = Math.max(0, contentHeight - viewportHeight);
      setScrollUp((u) => Math.min(maxScroll, u + delta));
    }
  }, [contentHeight, viewportHeight, scrollStick, scrollUp]);
  // Mouse-wheel scrolling: enable SGR mouse reporting and parse wheel events straight
  // from stdin (works during a run too), mapping them to the same line-scroll as
  // PageUp/PageDown. Heights come from a ref so the listener is bound once.
  const { stdin: rawStdin } = useStdin();
  const scrollMetricsRef = useRef({ contentHeight: 0, viewportHeight: 0 });
  scrollMetricsRef.current = { contentHeight, viewportHeight };
  useEffect(() => {
    if (!rawStdin || typeof rawStdin.on !== 'function') return undefined;
    enableMouse();
    const onData = (data: Buffer | string): void => {
      const ev = parseMouseEvent(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
      if (!ev) return;
      const { contentHeight: ch, viewportHeight: vh } = scrollMetricsRef.current;
      const maxScrollNow = Math.max(0, ch - vh);
      if (ev.type === 'scroll-up') {
        setScrollStick(false);
        setScrollUp((u) => Math.min(maxScrollNow, u + 3));
      } else if (ev.type === 'scroll-down') {
        setScrollUp((u) => {
          const next = Math.max(0, u - 3);
          if (next === 0) setScrollStick(true);
          return next;
        });
      }
    };
    rawStdin.on('data', onData);
    // Belt-and-suspenders: also restore the terminal on a hard exit so the user's
    // mouse isn't left in reporting mode if the process dies without unmounting.
    const restoreOnExit = (): void => disableMouse();
    process.once('exit', restoreOnExit);
    return () => {
      rawStdin.off('data', onData);
      process.off('exit', restoreOnExit);
      disableMouse();
    };
  }, [rawStdin]);
  const [flashHint, setFlashHint] = useState<string>('');
  const [ctxUsage, setCtxUsage] = useState<{ used: number; total: number } | undefined>(undefined);
  const [queuedInputs, setQueuedInputsState] = useState<QueuedInput[]>([]);
  const [queuePausedAfterCancel, setQueuePausedAfterCancelState] = useState(false);
  const answerIdRef = useRef<number | null>(null);
  const currentTurnIdRef = useRef<number | null>(null);
  const activeRunControllerRef = useRef<AbortController | null>(null);
  const localShellApprovedRef = useRef(false);
  const flashTimerRef = useRef<NodeJS.Timeout | null>(null);
  const busyRef = useRef(false);
  const queuedInputsRef = useRef<QueuedInput[]>([]);
  const queuePausedAfterCancelRef = useRef(false);
  const inputHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const historyDraftRef = useRef('');

  const setQueuedInputs = useCallback((next: QueuedInput[]): void => {
    queuedInputsRef.current = next;
    setQueuedInputsState(next);
  }, []);

  const setBusyState = useCallback((next: boolean): void => {
    busyRef.current = next;
    setBusy(next);
  }, []);

  const setQueuePausedAfterCancel = useCallback((next: boolean): void => {
    queuePausedAfterCancelRef.current = next;
    setQueuePausedAfterCancelState(next);
  }, []);

  const rememberInput = useCallback((message: string): void => {
    const trimmed = message.trim();
    if (!trimmed) return;
    const history = inputHistoryRef.current;
    if (history[history.length - 1] === trimmed) return;
    inputHistoryRef.current = [...history, trimmed].slice(-MAX_INPUT_HISTORY);
  }, []);

  const setInputFromTyping = useCallback((next: string): void => {
    historyIndexRef.current = null;
    historyDraftRef.current = '';
    setInput(next);
    setInputCursor((cursor) => clampPromptCursor(next, cursor));
  }, []);

  const recallHistoryPrevious = useCallback((): void => {
    const history = inputHistoryRef.current;
    if (history.length === 0) return;
    const currentIndex = historyIndexRef.current;
    const nextIndex = currentIndex === null ? history.length - 1 : Math.max(0, currentIndex - 1);
    if (currentIndex === null) historyDraftRef.current = input;
    historyIndexRef.current = nextIndex;
    const recalled = history[nextIndex] ?? '';
    setInput(recalled);
    setInputCursor(recalled.length);
  }, [input]);

  const recallHistoryNext = useCallback((): void => {
    const history = inputHistoryRef.current;
    const currentIndex = historyIndexRef.current;
    if (currentIndex === null) return;
    if (currentIndex >= history.length - 1) {
      historyIndexRef.current = null;
      const draft = historyDraftRef.current;
      setInput(draft);
      setInputCursor(draft.length);
      historyDraftRef.current = '';
      return;
    }
    const nextIndex = currentIndex + 1;
    historyIndexRef.current = nextIndex;
    const recalled = history[nextIndex] ?? '';
    setInput(recalled);
    setInputCursor(recalled.length);
  }, []);

  const addTranscript = useCallback((kind: TranscriptKind, text: string, extra: Partial<TranscriptItem> = {}): number => {
    const id = nextId();
    setTranscript((items) => [...items, { id, kind, text, ...extra }].slice(-MAX_TRANSCRIPT_ITEMS));
    return id;
  }, []);

  const updateTranscript = useCallback((id: number, append: string, extra: Partial<TranscriptItem> = {}): void => {
    setTranscript((items) => items.map((item) => (
      item.id === id ? { ...item, text: `${item.text}${append}`, ...extra } : item
    )));
  }, []);

  const showFlash = useCallback((message: string): void => {
    setFlashHint(message);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashHint(''), 2000);
  }, []);

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  const requestStop = useCallback((): boolean => {
    if (!activeRunControllerRef.current) return false;
    activeRunControllerRef.current.abort(new Error('aborted by user'));
    const queuedCount = queuedInputsRef.current.length;
    setQueuePausedAfterCancel(queuedCount > 0);
    addTranscript('system', stopRequestedMessage(queuedCount));
    return true;
  }, [addTranscript, setQueuePausedAfterCancel]);

  useEffect(() => {
    localShellApprovedRef.current = localShellApproved;
  }, [localShellApproved]);

  const askApproval = useCallback((question: string): Promise<string> => new Promise((resolve) => {
    setApproval({ question, resolve });
  }), []);

  useEffect(() => {
    setCliApprovalAsker((question) => new Promise((resolve) => {
      setApproval({ question, resolve });
    }));
    return () => setCliApprovalAsker(null);
  }, []);

  useEffect(() => {
    setCliInteractionMode(interactionMode);
  }, [interactionMode]);

  useEffect(() => {
    const parsePatchPaths = (patch: string): string[] => {
      const out: string[] = [];
      for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) out.push(m[1].trim());
      return out;
    };
    agent.registerPreToolHook({
      name: 'file-checkpoint',
      priority: 5,
      async check({ tool, input }) {
        for (const p of checkpointTargetPaths(tool.name, input, workspace, parsePatchPaths)) {
          checkpointRef.current?.trackBeforeWrite(p);
        }
        return null;
      },
    });
    // 写后采集指纹：/rewind 据此判断文件是否被用户在外部改过，避免静默覆盖。
    agent.registerPostToolHook({
      name: 'file-checkpoint-after',
      priority: 5,
      async process({ tool, input }) {
        for (const p of checkpointTargetPaths(tool.name, input, workspace, parsePatchPaths)) {
          checkpointRef.current?.noteAfterWrite(p);
        }
        return null;
      },
    });
  }, []);

  useEffect(() => {
    if (!runtime?.configDir) return;
    startCliUpdateCheck({
      configDir: runtime.configDir,
      currentVersion: getPackageVersion(),
      onNotice: setNotice,
    });
  }, [runtime?.configDir]);

  // Global keybinds: Ctrl+O toggles tool expansion; approval handles y/a/n/Esc
  useInput((inputChar, key) => {
    // Mouse wheel/clicks are handled by the dedicated stdin listener; ignore any
    // mouse-report bytes Ink surfaces here so they never fire keys (e.g. a stray
    // Esc from a wheel event must not cancel the run).
    if (isLikelyMouseInput(inputChar)) return;
    if (approval) {
      const decision = approvalKeyDecision(inputChar, key);
      if (decision === 'deny') {
        approval.resolve('');
        setApproval(null);
        return;
      }
      if (decision === 'allow-once') {
        approval.resolve('y');
        setApproval(null);
        return;
      }
      if (decision === 'allow-always') {
        approval.resolve('a');
        setApproval(null);
        return;
      }
      return;
    }
    const normalizedInput = inputChar.toLowerCase();
    if (key.ctrl && (normalizedInput === 'o' || inputChar === '\u000f')) {
      setToolsExpanded((prev) => {
        const next = !prev;
        showFlash(next ? 'tools expanded' : 'tools collapsed');
        return next;
      });
      return;
    }
    if (key.tab && key.shift) {
      setInteractionMode((m) => {
        const next: CliInteractionMode = m === 'plan' ? 'default' : m === 'default' ? 'acceptEdits' : 'plan';
        showFlash(`mode: ${next === 'acceptEdits' ? 'accept-edits' : next}`);
        return next;
      });
      return;
    }
    // Scroll the transcript history by lines (PageUp/PageDown) — keys the editor
    // ignores, so they never clash with typing. Reaching the bottom re-engages follow.
    if (key.pageUp) {
      const step = Math.max(1, (viewportHeight || termRows) - 2);
      const maxScroll = Math.max(0, contentHeight - viewportHeight);
      setScrollStick(false);
      setScrollUp((u) => Math.min(maxScroll, u + step));
      return;
    }
    if (key.pageDown) {
      const step = Math.max(1, (viewportHeight || termRows) - 2);
      setScrollUp((u) => {
        const next = Math.max(0, u - step);
        if (next === 0) setScrollStick(true);
        return next;
      });
      return;
    }
    if (key.escape && activeRunControllerRef.current) {
      requestStop();
    }
  });

  const handleCommand = useCallback(async (message: string): Promise<boolean> => {
    if (message === '/quit' || message === '/exit') {
      app.exit();
      return true;
    }
    if (message === '/help') {
      addTranscript('system', commandList());
      return true;
    }
    if (message === '/clear') {
      setTranscript([]);
      return true;
    }
    if (message === '/queue' || message === '/queued') {
      const queue = queuedInputsRef.current;
      const now = Date.now();
      addTranscript('system', queue.length === 0
        ? 'Queue is empty.'
        : [
            `Queued prompts (${queue.length})`,
            ...queue.map((item, index) => `  ${index === 0 ? 'next' : `#${index + 1}`} · ${queueItemMeta(item, now)} · ${item.message}`),
            '',
            queuePausedAfterCancelRef.current
              ? 'Queue is paused after stop. Use /queue resume to continue, /queue drop to discard the last prompt, or /queue clear to discard all.'
              : 'Use /queue drop to discard the last queued prompt, or /queue clear to discard all.',
          ].join('\n'));
      return true;
    }
    if (message === '/queue resume' || message === '/queue continue') {
      if (!queuePausedAfterCancelRef.current) {
        addTranscript('system', 'Queue is not paused.');
        return true;
      }
      setQueuePausedAfterCancel(false);
      addTranscript('system', queueResumedMessage(queuedInputsRef.current.length));
      return true;
    }
    if (message === '/queue drop' || message === '/queue pop') {
      const queue = queuedInputsRef.current;
      const { next, dropped } = dropLastQueuedInput(queue);
      if (!dropped) {
        addTranscript('system', 'Queue is already empty.');
        return true;
      }
      setQueuedInputs(next);
      if (next.length === 0) setQueuePausedAfterCancel(false);
      addTranscript('system', `Dropped queued prompt #${queue.length}: ${dropped.message}`);
      return true;
    }
    if (message === '/queue clear' || message === '/clearqueue') {
      const count = queuedInputsRef.current.length;
      setQueuedInputs([]);
      setQueuePausedAfterCancel(false);
      addTranscript('system', count === 0 ? 'Queue is already empty.' : `Cleared ${count} queued prompt${count === 1 ? '' : 's'}.`);
      return true;
    }
    if (message === '/stop' || message === '/abort') {
      if (!requestStop()) {
        addTranscript('system', 'No active run to stop.');
      }
      return true;
    }
    if (message === '/thinking') {
      setShowThinking((value) => {
        const next = !value;
        addTranscript('system', `Thinking display ${next ? 'enabled' : 'disabled'}.`);
        return next;
      });
      return true;
    }
    if (message === '/status') {
      addTranscript('system', renderCliStatus(agent, runtime));
      return true;
    }
    if (message === '/permissions' || message === '/config') {
      addTranscript('system', renderCliPermissions(runtime));
      return true;
    }
    if (message === '/tools') {
      addTranscript('system', renderCliTools(agent));
      return true;
    }
    if (message === '/examples') {
      addTranscript('system', renderCliExamples(agent, runtime));
      return true;
    }
    if (message === '/upgrade') {
      addTranscript('system', renderCliUpgradeHelp());
      return true;
    }
    if (message === '/memory') {
      addTranscript('system', renderMemory(workspace));
      return true;
    }
    if (message === '/skills') {
      addTranscript('system', renderSkills(workspace));
      return true;
    }
    if (message === '/sessions' || message === '/session') {
      try {
        const sessions = await agent.config.sessionStore.listSessions();
        addTranscript('system', formatTuiSessions(sessions, sessionKey));
      } catch (err) {
        addTranscript('error', `Could not list sessions: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }
    if (message === '/context' || message === '/cost') {
      try {
        const msgs = await agent.config.sessionStore.loadMessages(sessionKey);
        const chars = msgs.reduce((n, m) => {
          const c = (m as { content?: unknown }).content;
          return n + (typeof c === 'string' ? c.length : c ? JSON.stringify(c).length : 0);
        }, 0);
        const approx = Math.round(chars / 4);
        if (message === '/context') {
          const total = 1_000_000;
          const pct = Math.min(100, Math.round((approx / total) * 100));
          addTranscript('system', [
            'Context window',
            `  messages    ${msgs.length}`,
            `  est. usage  ~${approx.toLocaleString()} / ${total.toLocaleString()} tokens (${pct}%)`,
            '  (estimate ~4 chars/token; live ctx in status bar)',
          ].join('\n'));
        } else {
          addTranscript('system', [
            'Session usage (estimate)',
            `  messages    ${msgs.length}`,
            `  est. tokens ~${approx.toLocaleString()}`,
            `  model       ${currentModel}`,
            '  (provider billing varies; this is a local estimate)',
          ].join('\n'));
        }
      } catch (err) {
        addTranscript('error', `Could not read usage: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }
    if (message === '/rewind' || message.startsWith('/rewind ')) {
      const store = checkpointRef.current;
      if (!store || !store.hasCheckpoints()) {
        addTranscript('system', 'No checkpoints yet — file edits this session can be rewound here.');
        return true;
      }
      const arg = message.slice('/rewind'.length).trim();
      if (!arg) {
        addTranscript('system', [
          'Checkpoints (newest last) — /rewind <seq> to restore files:',
          ...store.list().map((c) => `  #${c.seq}  ${c.label}  (${c.fileCount} file${c.fileCount === 1 ? '' : 's'})`),
        ].join('\n'));
        return true;
      }
      const seq = Number.parseInt(arg, 10);
      if (Number.isNaN(seq)) {
        addTranscript('system', 'Usage: /rewind [seq]');
        return true;
      }
      const result = store.rewindTo(seq);
      if (!result.found) {
        addTranscript('system', `Checkpoint #${seq} not found.`);
        return true;
      }
      const lines: string[] = [];
      if (result.restored.length) lines.push(`Rewound ${result.restored.length} file(s) to checkpoint #${seq}.`);
      if (result.skipped.length) {
        lines.push(
          `Kept ${result.skipped.length} file(s) changed since the agent wrote them (edited or deleted outside this session) — not overwritten:`,
          ...result.skipped.map((p) => `  ${path.relative(workspace, p) || p}`),
        );
      }
      if (!lines.length) lines.push(`Checkpoint #${seq}: nothing to restore.`);
      addTranscript('system', lines.join('\n'));
      return true;
    }
    if (message === '/models') {
      addTranscript('system', modelExamples(currentModel));
      return true;
    }
    if (message === '/model' || message.startsWith('/model ')) {
      const nextModel = message === '/model' ? '' : message.slice(7).trim();
      if (!nextModel) {
        addTranscript('system', `Current model: ${currentModel}`);
      } else {
        agent.config.model = nextModel;
        setCurrentModel(nextModel);
        addTranscript('system', `Model switched to ${nextModel}`);
      }
      return true;
    }
    if (message.startsWith('/detail')) {
      const mode = message.slice('/detail'.length).trim().toLowerCase();
      if (mode === 'quiet' || mode === 'progress' || mode === 'verbose') {
        process.env.DMOSS_CLI_DETAIL = mode;
        setDetailMode(mode);
        addTranscript('system', `Detail mode set to ${mode}`);
      } else {
        addTranscript('system', renderCliDetailHelp());
      }
      return true;
    }
    if (message === '/init') {
      const target = path.join(workspace, 'AGENTS.md');
      if (fs.existsSync(target)) {
        addTranscript('system', `AGENTS.md already exists at ${compactPath(target)} — leaving it untouched.`);
        return true;
      }
      try {
        fs.writeFileSync(target, AGENTS_MD_TEMPLATE, 'utf8');
        addTranscript('system', `Created ${compactPath(target)} — D-Moss auto-loads it. Fill in build/test commands, layout, and conventions.`);
      } catch (err) {
        addTranscript('error', `Could not write AGENTS.md: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }
    if (message === '/diff' || message.startsWith('/diff ')) {
      try {
        const result = await runLocalShellCommand({
          command: 'git --no-pager diff --stat && git --no-pager diff',
          cwd: workspace,
        });
        addTranscript('system', result.output.trim() || '(no unstaged working-tree changes)');
      } catch (err) {
        addTranscript('error', `Could not run git diff: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }
    if (message.startsWith('/')) {
      const suggestion = commandSuggestion(message);
      addTranscript('error', [
        `Unknown command: ${message}`,
        suggestion ? `Did you mean ${suggestion}?` : 'Use /help for available commands.',
      ].join('\n'));
      return true;
    }
    return false;
  }, [addTranscript, agent, app, currentModel, requestStop, runtime, setQueuePausedAfterCancel, setQueuedInputs, workspace]);

  const runLocalShell = useCallback(async (raw: string): Promise<void> => {
    const command = raw.slice(1);
    if (!localShellApprovedRef.current) {
      const answer = await askApproval([
        'Allow LOCAL host shell commands in this TUI session?',
        'This runs on the computer where this CLI is open.',
        'It does not run on the board, OpenClaw gateway, or a remote device.',
        `First command: ${command}`,
      ].join('\n'));
      if (answer.trim().toLowerCase() !== 'y') {
        addTranscript('error', 'Local shell command denied.');
        return;
      }
      localShellApprovedRef.current = true;
      setLocalShellApproved(true);
    }

    const id = addTranscript('shell', `$ ${command}\n`);
    const controller = new AbortController();
    activeRunControllerRef.current = controller;
    setBusyState(true);
    try {
      const result = await runLocalShellCommand({
        command,
        cwd: workspace,
        signal: controller.signal,
        onChunk: (chunk) => updateTranscript(id, chunk),
      });
      const status = result.signal ? `signal ${result.signal}` : `exit ${result.exitCode ?? 0}`;
      updateTranscript(id, `\n[local] ${status}`);
    } catch (err) {
      updateTranscript(id, `\n[local] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (activeRunControllerRef.current === controller) activeRunControllerRef.current = null;
      setBusyState(false);
    }
  }, [addTranscript, askApproval, setBusyState, updateTranscript, workspace]);

  const runPrompt = useCallback(async (message: string): Promise<void> => {
    addTranscript('user', message);
    checkpointRef.current?.open(message);
    setBusyState(true);
    answerIdRef.current = null;
    const controller = new AbortController();
    activeRunControllerRef.current = controller;
    const effectiveMessage = getCliInteractionMode() === 'plan'
      ? `[计划模式] 你现在处于 plan 模式：只读探索代码库，产出清晰的实施计划（步骤 / 涉及文件 / 验证方式）。在用户批准（按 Shift+Tab 切到 default 或 accept-edits）前，不要修改文件或执行有副作用的命令。\n\n${message}`
      : message;
    try {
      for await (const event of agent.streamChat(sessionKey, effectiveMessage, { abortSignal: controller.signal })) {
        if (event.type === 'turn_start') {
          currentTurnIdRef.current = event.turn;
        }
        if (event.type === 'text_delta') {
          if (answerIdRef.current === null) {
            const id = addTranscript('assistant', '', { turnId: currentTurnIdRef.current ?? 0 });
            answerIdRef.current = id;
          }
          updateTranscript(answerIdRef.current, sanitizeRenderableText(event.delta));
        }
        if (event.type === 'thinking_delta' && showThinking) {
          if (answerIdRef.current === null) {
            const id = addTranscript('assistant', '', { turnId: currentTurnIdRef.current ?? 0 });
            answerIdRef.current = id;
          }
          updateTranscript(answerIdRef.current, sanitizeRenderableText(`\n[thinking] ${event.delta}`));
        }
        if (event.type === 'tool_start') {
          addTranscript('tool', '', {
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            toolInput: toolHeadline(event.input),
            toolInputRaw: event.input,
            status: 'running',
            startedAt: Date.now(),
            turnId: currentTurnIdRef.current ?? 0,
          });
        }
        if (event.type === 'tool_end') {
          setTranscript((items) => items.flatMap((item) => {
            if (item.kind !== 'tool' || item.toolCallId !== event.toolCallId) return [item];
            const endResult = (event as { result?: unknown }).result;
            const next: TranscriptItem = {
              ...item,
              status: event.isError || event.aborted ? 'failed' : 'ok',
              elapsedMs: event.durationMs ?? (item.startedAt ? Date.now() - item.startedAt : undefined),
              outcome: event.outcome,
              result: typeof endResult === 'string' ? endResult : item.result,
            };
            // quiet mode: collapse successful tool calls to keep the transcript tidy.
            // Failures stay visible regardless.
            if (detailMode === 'quiet' && next.status === 'ok') {
              // Keep the item but mark it lightly — Ctrl+O still expands its details.
              return [next];
            }
            return [next];
          }));
        }
        if (event.type === 'turn_end') {
          currentTurnIdRef.current = null;
        }
        if (event.type === 'error') {
          addTranscript('error', String(event.error));
        }
        // Surface context-window usage in the status bar when the agent reports it.
        const usageEvent = event as unknown as {
          type?: string;
          usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; max_tokens?: number };
        };
        if (usageEvent.type === 'usage' && usageEvent.usage) {
          const u = usageEvent.usage;
          const used = u.total_tokens ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0));
          const total = u.max_tokens ?? 0;
          if (total > 0) setCtxUsage({ used, total });
        }
        if (event.type === 'done') {
          setTranscript((items) => items.map((item) => (
            item.kind === 'assistant' && item.id === answerIdRef.current
              ? { ...item, finalized: true }
              : item
          )));
          if (skillLearner && event.result?.toolCalls && event.result.toolCalls.length >= 2) {
            try {
              const messages = await agent.config.sessionStore.loadMessages(sessionKey);
              await skillLearner.maybeLearnFromSession(sessionKey, messages);
            } catch {
              // Learning is best-effort and should not interrupt the conversation.
            }
          }
        }
        const label = detailMode === 'quiet' ? null : activityLabel(event);
        if (label) {
          addTranscript('system', label);
        }
      }
    } catch (err) {
      addTranscript('error', controller.signal.aborted ? 'Run stopped.' : String(err instanceof Error ? err.message : err));
    } finally {
      if (activeRunControllerRef.current === controller) activeRunControllerRef.current = null;
      setBusyState(false);
      answerIdRef.current = null;
      currentTurnIdRef.current = null;
    }
  }, [addTranscript, agent, detailMode, sessionKey, setBusyState, showThinking, skillLearner, updateTranscript]);

  const runInput = useCallback((raw: string): void => {
    const message = raw.trim();
    if (!message || approval) return;
    void (async () => {
      if (isLocalShellLine(raw)) {
        await runLocalShell(raw);
        return;
      }
      const handled = await handleCommand(message);
      if (!handled) await runPrompt(message);
    })();
  }, [approval, handleCommand, runLocalShell, runPrompt]);

  useEffect(() => {
    if (!shouldDrainQueue({
      busy,
      approvalActive: approval !== null,
      pausedAfterCancel: queuePausedAfterCancelRef.current,
      queueLength: queuedInputsRef.current.length,
    })) return;
    const [next, ...rest] = queuedInputsRef.current;
    setQueuedInputs(rest);
    if (next) runInput(next.raw);
  }, [approval, busy, queuePausedAfterCancel, queuedInputs.length, runInput, setQueuedInputs]);

  const submit = useCallback((value: string): void => {
    const raw = value;
    const message = raw.trim();
    setInput('');
    setInputCursor(0);
    if (!message || approval) return;
    rememberInput(message);
    historyIndexRef.current = null;
    historyDraftRef.current = '';
    const queuePaused = queuePausedAfterCancelRef.current;
    const queueControlCommand = isQueueControlCommand(message);
    const isImmediateBusyCommand = message === '/stop'
      || message === '/abort'
      || message === '/sessions'
      || message === '/session'
      || queueControlCommand;
    if (queuePaused && !queueControlCommand && !message.startsWith('/')) {
      const nextQueue = [...queuedInputsRef.current, { raw, message, enqueuedAt: Date.now() }];
      setQueuedInputs(nextQueue);
      setQueuePausedAfterCancel(false);
      addTranscript('system', `Queued #${nextQueue.length}; queue resumed: ${message}`);
      return;
    }
    if (busyRef.current && isImmediateBusyCommand) {
      runInput(raw);
      return;
    }
    if (busyRef.current) {
      const nextQueue = [...queuedInputsRef.current, { raw, message, enqueuedAt: Date.now() }];
      setQueuedInputs(nextQueue);
      addTranscript('system', `Queued #${nextQueue.length}; next runs when the current task finishes: ${message}`);
      return;
    }
    runInput(raw);
  }, [addTranscript, approval, runInput, setQueuePausedAfterCancel, setQueuedInputs]);

  const device = runtime?.device ? `${runtime.device.user || 'root'}@${runtime.device.host}` : 'no device';
  const cacheMode = promptCacheModeLabel(runtime);
  const profile = runtime?.config?.profile || 'balanced';
  const runState: TuiRunState = approval ? 'approval' : busy ? 'running' : 'ready';
  const executionPlane = executionPlaneSummary(runtime);
  const terminalRows = Math.max(12, termRows);
  // Fill the terminal (minus one row to avoid a trailing-newline scroll) so the
  // whole UI is a fixed-height frame: the content area flexes, the input is
  // bottom-anchored, and the frame NEVER overflows the terminal. Overflow was the
  // root cause of the cursor/IME drifting when the command menu opened — the frame
  // grew past the terminal, the terminal scrolled, and Ink's relative cursor math
  // (which assumes the frame fits) broke.
  const frameHeight = terminalRows - 1;
  const promptRows = promptEditorRowBudget(input, {
    placeholder: promptPlaceholder(runState),
    hint: footerHint(runState),
  });
  const queueRows = queuedInputs.length > 0 ? Math.min(5, queuedInputs.length + 2) : 0;
  const footerRows = approval ? 0 : 1;
  const headerRows = 5;
  const approvalRows = approval ? Math.min(10, approval.question.split('\n').length + 4) : 0;
  const noticeRows = notice ? 1 : 0;
  const viewportOptions = {
    transcriptLength: transcript.length,
    terminalRows,
    headerRows,
    promptRows,
    queueRows,
    footerRows,
    approvalRows,
    noticeRows,
  };
  const compactWelcome = shouldRenderCompactWelcome(viewportOptions);
  // Line-level scroll margin (verified in stock Ink: negative marginTop + overflow
  // hidden = a scroll viewport; positive marginTop pushes content down):
  //   margin = min(0, viewportH - contentH) + scrollUp
  // Content that fits is top-aligned (header + welcome visible, Claude-Code style);
  // tall content shows the newest lines; scrollUp reveals earlier lines. The header
  // lives INSIDE the scroll area so it scrolls away as the conversation grows, rather
  // than permanently eating ~8 rows — exactly like Claude Code's launch panel.
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const clampedScrollUp = Math.min(scrollUp, maxScroll);
  const scrollMargin = Math.min(0, viewportHeight - contentHeight) + clampedScrollUp;

  return React.createElement(
    Box,
    // overflow:hidden is a safety net; the real anti-crush guarantee is that the
    // bottom-chrome wrapper (input/footer) is flexShrink:0, so only the transcript
    // viewport absorbs any height deficit and clips cleanly.
    { flexDirection: 'column', paddingX: 1, paddingTop: 1, height: frameHeight, overflow: 'hidden' },
    // Transcript viewport: fixed-height (flexGrow), overflow:hidden. The inner box
    // holds the header + welcome + ALL items and is shifted by scrollMargin for
    // line-level scrolling; the header scrolls away as the conversation grows.
    React.createElement(
      Box,
      { flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden', ref: transcriptViewportRef },
      React.createElement(
        Box,
        { flexDirection: 'column', flexShrink: 0, marginTop: scrollMargin, ref: transcriptInnerRef },
        React.createElement(SessionHeader, {
          device,
          workspace,
          model: currentModel,
          state: runState,
          toolsExpanded: toolsExpanded || detailMode === 'verbose',
          version: `v${getPackageVersion()}`,
          cacheMode,
          profile,
        }),
        transcript.length === 0
          ? React.createElement(WelcomePanel, {
              workspace,
              device,
              model: currentModel,
              cacheMode,
              profile,
              executionPlane,
              tip: boardTip(runtime),
              compact: compactWelcome,
            })
          : null,
        // Each item is flexShrink:0 so Ink never squashes the list when it is tall.
        ...transcript.map((item) => React.createElement(Box, { key: item.id, flexShrink: 0 },
          React.createElement(TranscriptMessage, {
            item,
            model: currentModel,
            toolsExpanded: toolsExpanded || detailMode === 'verbose',
          }),
        )),
      ),
    ),
    // Bottom chrome wrapper: flexShrink:0 so the jump hint / queue / notices /
    // input box / footer are never squashed (overlapping lines) when the
    // transcript is tall — only the content box above shrinks.
    React.createElement(
      Box,
      { flexDirection: 'column', flexShrink: 0 },
    // Live activity line: a self-animating spinner + elapsed seconds, shown only
    // while busy, so it is always clear the agent is still running (not frozen).
    busy && !approval ? React.createElement(WorkingIndicator, { key: 'working' }) : null,
    // The scroll indicator lives in the footer line below (not its own row) so the
    // transcript viewport height stays constant — otherwise it would jump by a row
    // and make PageUp/PageDown steps asymmetric.
    React.createElement(QueuePreview, { items: queuedInputs, paused: queuePausedAfterCancel }),
    notice ? React.createElement(Text, { color: theme.warn }, notice) : null,
    flashHint ? React.createElement(Text, { color: theme.warn }, flashHint) : null,
    approval
      ? React.createElement(ApprovalPromptLine, { question: approval.question })
      : React.createElement(PromptEditor, {
          value: input,
          cursor: inputCursor,
          onChange: setInputFromTyping,
          onCursorChange: setInputCursor,
          onSubmit: submit,
          placeholder: promptPlaceholder(runState),
          disabled: false,
          mode: interactionMode,
          onHistoryPrevious: recallHistoryPrevious,
          onHistoryNext: recallHistoryNext,
          onShiftEnter: () => undefined,
        }),
    // Single Claude-code-style line under the input: the active mode when it is
    // not default, otherwise the key hints — plus a subtle context-used %.
    !approval ? React.createElement(
      Box,
      { flexDirection: 'row', paddingX: 1 },
      (!scrollStick && clampedScrollUp > 0)
        ? React.createElement(Text, { color: theme.claude },
            `${emojiEnabled() ? '↓' : 'v'} ${clampedScrollUp} line${clampedScrollUp === 1 ? '' : 's'} newer · PageDown for latest`)
        : interactionMode !== 'default'
          ? React.createElement(Text, { color: interactionMode === 'plan' ? theme.planMode : theme.autoAccept, bold: true },
              interactionMode === 'plan'
                ? `${emojiEnabled() ? '⏸' : '||'} plan mode on ${emojiEnabled() ? '(⇧⇥ to cycle)' : '(shift+tab to cycle)'}`
                : `${emojiEnabled() ? '⏵⏵' : '>>'} accept edits on ${emojiEnabled() ? '(⇧⇥ to cycle)' : '(shift+tab to cycle)'}`)
          : React.createElement(Text, { color: theme.textDim }, footerHint(runState)),
      ctxUsage ? React.createElement(Text, { color: ctxUsageBarColor(ctxUsage) },
        `   ${Math.round((ctxUsage.used / ctxUsage.total) * 100)}% context used`) : null,
    ) : null,
    ),
  );
}

function commandList(): string {
  return [
    'Commands',
    '  /examples          starter prompts',
    '  /status            runtime and device context',
    '  /permissions       safety, approval, cache, and config file policy',
    '  /config            active config file and policy commands',
    '  /tools             available tools',
    '  /stop              stop the active run',
    '  /queue [drop|clear] show, drop last, or discard queued prompts',
    '  /sessions          show current and recent saved sessions',
    '  /context           context window token usage',
    '  /cost              session token usage estimate',
    '  /rewind [seq]      list or undo file changes to a checkpoint',
    '  /diff              show git working-tree changes',
    '  /init              scaffold an AGENTS.md project memory file',
    '',
    'Conversation',
    '  /clear             clear visible transcript',
    '  /thinking          toggle thinking deltas',
    '  /detail [mode]     quiet | progress | verbose',
    '  Ctrl+O             expand/collapse tool calls',
    '',
    'Runtime',
    '  /model [name]      show or switch model',
    '  /memory            show memory count',
    '  /skills            list learned skills',
    '  /upgrade           show update commands',
    '',
    'Shell and exit',
    '  !<command>         run a LOCAL host shell command after session approval',
    '  /quit              exit',
  ].join('\n');
}

export async function runInkInteractive(
  agent: DmossAgent,
  skillLearner: SkillLearner | undefined,
  runtime: CliRuntimeStatus | undefined,
  options: { sessionKey?: string } = {},
): Promise<void> {
  const instance = render(
    React.createElement(DmossTui, {
      agent,
      skillLearner,
      runtime,
      sessionKey: options.sessionKey || 'cli',
    }),
    {
      stdout: process.stdout,
      stderr: process.stderr,
      stdin: process.stdin,
      exitOnCtrlC: true,
      patchConsole: true,
      interactive: true,
      maxFps: 20,
    },
  );
  await instance.waitUntilExit();
}

// Re-exported for legacy callers that imported transcriptColor.
export { transcriptColor };
