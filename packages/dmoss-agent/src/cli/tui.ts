import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useCursor, measureElement, Static, type DOMElement } from 'ink';
import stringWidth from 'string-width';
import type {
  MossAsyncTaskCompletion,
  MossAsyncTaskRegistry,
  MossAsyncTaskSnapshot,
} from '@rdk-moss/core/contracts/async-task';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { StreamingSpinner } from './components/StreamingSpinner.js';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { DmossAgent, DmossAgentEvent, GoalState, Tool, ToolResultOutcome } from '../core/index.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import type { SessionMeta } from '../core/session/session.js';
import { SkillRegistry, type SkillMeta } from '../skills/index.js';
import { setCliApprovalAsker, setCliInteractionMode, getCliInteractionMode, type CliInteractionMode } from './approval.js';
import {
  parseAttachArgs,
  preparePromptAttachments,
  renderPendingAttachmentSummary,
  type PreparedPromptAttachment,
  type PromptAttachmentBlock,
} from './attachments.js';
import { prepareClipboardAttachment } from './clipboard-image.js';
import { handleCompactCommand } from './compact-command.js';
import { formatCommunityAuthLoginError, formatCommunityAuthStatus } from './community-auth.js';
import { disconnectDeviceForSession } from './device-connect.js';
import { runRegistryCommand, unknownSlashCommandLines, type CommandSpec } from './commands/registry.js';
import { loadCustomCommands, reservedBuiltinNames } from './commands/custom-commands.js';
import { FileCheckpointStore, checkpointTargetPaths } from './file-checkpoint.js';
import { INTERACTIVE_COMPLETION_COMMANDS, commandRowsForSlashInput } from './interactive-commands.js';
import {
  describeModelListSource,
  formatCustomModelConfigInstructions,
  loadModelChoicesForRuntime,
  parseCustomModelConfigInput,
  resolveModelSelection,
  type ModelChoiceList,
} from './model-catalog.js';
import { loadConfigFile, resolveConfigDir, resolveConfigPath, saveConfigFileAtPath } from './config.js';
import { createCliProvider } from './providers.js';
import { renderCliDetailHelp, type CliRuntimeStatus } from './onboarding.js';
import { getPackageVersion } from './package-info.js';
import { createCliSessionKey } from './session.js';
import { startCliUpdateCheck } from './update-check.js';
import { compactPath, ui } from './ui.js';
import { handleGoalCommand } from '../goal.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';

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

interface ModelPickerState {
  list: ModelChoiceList;
  selectedIndex: number;
}

interface ApprovalState {
  question: string;
  selectedIndex: number;
  resolve: (answer: string) => void;
}

interface GoalActivityState {
  objective: string;
  startedAt: number;
  runCount: number;
  /** Live counters so long goal runs read as structured progress, not a spinner. */
  turns?: number;
  toolCalls?: number;
  lastCheckpoint?: { status: string; nextAction: string };
}

interface RunPromptOptions {
  echoUser?: boolean;
  autoGoal?: boolean;
  ephemeralTools?: Tool[];
}

interface GoalAutoRefState {
  running: boolean;
  suspended: boolean;
  scheduled: boolean;
  startedAt: number;
  runCount: number;
  objective: string;
}

export interface QueuedInput {
  raw: string;
  message: string;
  enqueuedAt?: number;
  attachments?: PreparedPromptAttachment[];
  attachmentBlocks?: PromptAttachmentBlock[];
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
// Theme & icons (headless agent-inspired warm, low-noise terminal palette)
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

// Tool-call rows use agent UI `⏺` bullet and `⎿` result connector
// (see ActivityItemLine). The old per-tool emoji map and status glyphs were
// retired in favor of that single, consistent marker style.

// ────────────────────────────────────────────────────────────────────────────
// Sanitizers & helpers (unchanged public surface)
// ────────────────────────────────────────────────────────────────────────────

let lastTranscriptId = 0;

export function createTranscriptId(now = Date.now()): number {
  const timestamp = Number.isFinite(now) ? Math.trunc(now) : Date.now();
  lastTranscriptId = Math.max(lastTranscriptId + 1, timestamp);
  return lastTranscriptId;
}

function nextId(): number {
  return createTranscriptId();
}

const ANSI_RE = new RegExp(
  String.raw`\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))`,
  'g',
);
const CONTROL_CHAR_RE = new RegExp(String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]`, 'g');
const LONG_TOKEN_RE = /[^\s]{33,}/g;
// CJK (incl. fullwidth punctuation) — these wrap naturally at every character,
// so the long-token breaker must leave them alone.
const CJK_CHAR_RE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const COPY_SENSITIVE_TOKEN_RE = /^(?:https?:\/\/|file:\/\/|[A-Za-z]:\\|\/|\.\/|\.\.\/|[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+|[A-Za-z0-9_-]*_[A-Za-z0-9_-]*|\[[^\]\n]{1,160}\]\((?:https?:\/\/|file:\/\/)[^)]+\))/;
const RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LOCAL_SHELL_OUTPUT_LIMIT = 40_000;
const MAX_INPUT_HISTORY = 100;
const WELCOME_PANEL_ROWS_ESTIMATE = 18;
const HEADLINE_MAX = 72;
const DEFAULT_MARKDOWN_TABLE_WIDTH = 96;
const MIN_MARKDOWN_TABLE_WIDTH = 40;
const MAX_MARKDOWN_TABLE_WIDTH = 160;
const MARKDOWN_TABLE_CELL = '\u001F';
const MARKDOWN_TABLE_ROW = '\u001E';

const AGENTS_MD_TEMPLATE = `# AGENTS.md

Project memory for Moss and coding agents. Auto-loaded at the start of every session.

## Overview
<!-- What this project is, in one or two sentences. -->

## Build / test / run
<!-- The exact commands an agent should use, e.g. install / build / test / lint. -->

## Layout
<!-- Top-level directories and what lives in each. -->

## Conventions
<!-- Code style, naming, patterns to follow, and things NOT to touch. -->
`;

const KNOWN_COMMANDS = INTERACTIVE_COMPLETION_COMMANDS;

function cliLocale(): string | undefined {
  return process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG;
}

function sanitizeTextForTerminal(text: string, options: { breakLongTokens: boolean }): string {
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
  const tokenSafe = options.breakLongTokens
    ? binarySafe.replace(LONG_TOKEN_RE, (token) => {
        if (COPY_SENSITIVE_TOKEN_RE.test(token)) return token;
        // Chinese/Japanese/Korean prose contains no ASCII spaces, so whole
        // sentences match LONG_TOKEN_RE — injecting spaces every 24 chars
        // mangled them mid-word ("apply_pa tch", "read_f ile"). CJK has a
        // natural wrap point at every character; only space-free ASCII blobs
        // (base64, hashes, long URLs) actually need soft breaks.
        if (CJK_CHAR_RE.test(token)) return token;
        return token.replace(/(.{24})/g, '$1 ');
      })
    : binarySafe;
  return tokenSafe
    .split('\n')
    .map((line) => (RTL_RE.test(line) ? `\u2067${line}\u2069` : line))
    .join('\n');
}

export function sanitizeRenderableText(text: string): string {
  return sanitizeTextForTerminal(text, { breakLongTokens: true });
}

function sanitizePromptEditorText(text: string): string {
  return sanitizeTextForTerminal(text, { breakLongTokens: false });
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
  const attachmentCount = item.attachments?.length ?? 0;
  return [
    queueItemKind(item),
    wait ? `waiting ${wait}` : null,
    `${lineCount} line${lineCount === 1 ? '' : 's'}`,
    `${charCount} chars`,
    attachmentCount > 0 ? `${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}` : null,
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

export function isImmediateGoalCommand(message: string): boolean {
  return message === '/goal clear'
    || message === '/goal pause'
    || message === '/goal complete'
    || message.startsWith('/goal complete ')
    || message === '/goal block'
    || message.startsWith('/goal block ');
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
  lines.push('Shell: moss resume --last');
  lines.push('Shell: moss resume --session <key>');
  lines.push('Shell: moss fork --fork-from <key>');
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

function attachmentRefIndexes(text: string): Set<number> {
  return new Set(extractAttachmentRefs(text).map((ref) => ref.index));
}

function removeAttachmentRefsFromInput(value: string): string {
  return value
    .replace(/\s*\[(?:Image|File)(?: #\d*)?\]?/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trimEnd();
}

function inputWithAttachmentRefs(value: string, attachments: PreparedPromptAttachment[]): string {
  const refs = attachments.map((item) => `[${item.kind === 'image' ? 'Image' : 'File'} #${item.index}]`).join(' ');
  if (!refs) return value;
  const trimmed = value.trimEnd();
  return `${trimmed ? `${trimmed} ` : ''}${refs} `;
}

function blockCountForAttachment(item: PreparedPromptAttachment): number {
  return item.kind === 'image' ? 2 : 1;
}

function selectReferencedPromptAttachments(
  text: string,
  attachments: PreparedPromptAttachment[],
  blocks: PromptAttachmentBlock[],
): { attachments: PreparedPromptAttachment[]; blocks: PromptAttachmentBlock[] } {
  const keep = attachmentRefIndexes(text);
  if (keep.size === 0) return { attachments: [], blocks: [] };
  const nextAttachments: PreparedPromptAttachment[] = [];
  const nextBlocks: PromptAttachmentBlock[] = [];
  let blockOffset = 0;
  for (const item of attachments) {
    const blockCount = blockCountForAttachment(item);
    const itemBlocks = blocks.slice(blockOffset, blockOffset + blockCount);
    blockOffset += blockCount;
    if (!keep.has(item.index)) continue;
    nextAttachments.push(item);
    nextBlocks.push(...itemBlocks);
  }
  return { attachments: nextAttachments, blocks: nextBlocks };
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
    'Moss',
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
const GETTING_STARTED_WORKFLOWS = [
  { title: 'Host Code', description: 'inspect files, explain architecture, edit safely, review changes' },
  { title: 'Host Commands', description: 'build, typecheck, lint, test, reproduce failures, collect logs' },
  { title: 'Board Diagnostics', description: 'connect over SSH, check OS, NPU, memory, services, network' },
  { title: 'Board Workflows', description: 'deploy model, bring up sensors, debug ROS/tros, gather evidence' },
] as const;

function isLikelyBoardRuntime(): boolean {
  if (process.env.DMOSS_BOARD_RUNTIME === '1') return true;
  if (process.env.RDK_BOARD || process.env.RDK_MODEL || process.env.TROS_DISTRO) return true;
  if (process.platform !== 'linux') return false;
  // arch alone is NOT evidence of a board: generic arm64 Linux (Apple-silicon
  // Docker/WSL, AWS Graviton, arm64 dev containers) must stay 'pc-host'.
  // Require a positive device-tree match instead.
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
  if (provider === 'deepseek' || provider === 'qwen' || provider === 'openai' || provider === 'anthropic') return `cloud routed (${provider})`;
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
  return 'Develop on this host now; connect an RDK board when you need hardware verification.';
}

function compactWelcomeTip(tip: string): string {
  if (tip.startsWith('Develop on this host')) return 'Develop on this host; connect a board for hardware verification.';
  if (tip.startsWith('PC Host Moss uses SSH')) return 'SSH tools target the board; ! stays on this host.';
  if (tip.startsWith('Hybrid Moss')) return 'Hybrid routes host work to board runtime with approval.';
  if (tip.startsWith('On-board Moss')) return 'On-board Moss proves changes with device evidence.';
  return tip;
}

export function footerHint(state: TuiRunState): string {
  if (state === 'approval') return '←/→ choose · Enter submit · y approve · a trust scope · n/Esc deny';
  if (state === 'running') return 'Esc cancel · Enter queue · /queue clear · Ctrl+C exit';
  return `${process.platform === 'darwin' ? 'Ctrl+V attach · ' : ''}paste file path + Enter · Tab complete · Up/Down history · Ctrl+O details · Ctrl+C exit`;
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

interface GraphemeSegment {
  index: number;
  segment: string;
}

type GraphemeSegmenter = {
  segment(input: string): Iterable<GraphemeSegment>;
};

type GraphemeSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: 'grapheme' },
) => GraphemeSegmenter;

const NativeSegmenter = (Intl as typeof Intl & { Segmenter?: GraphemeSegmenterConstructor }).Segmenter;
const graphemeSegmenter = NativeSegmenter ? new NativeSegmenter(undefined, { granularity: 'grapheme' }) : null;

function codePointSegments(value: string): GraphemeSegment[] {
  const segments: GraphemeSegment[] = [];
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);
    const length = codePoint && codePoint > 0xffff ? 2 : 1;
    segments.push({ index, segment: value.slice(index, index + length) });
    index += length;
  }
  return segments;
}

function graphemeSegments(value: string): GraphemeSegment[] {
  if (!value) return [];
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(value)) : codePointSegments(value);
}

function previousGraphemeStart(value: string, cursor: number): number {
  const index = clampPromptCursor(value, cursor);
  if (index <= 0) return 0;
  let previous = 0;
  for (const segment of graphemeSegments(value)) {
    if (segment.index >= index) break;
    previous = segment.index;
  }
  return previous;
}

function nextGraphemeEnd(value: string, cursor: number): number {
  const index = clampPromptCursor(value, cursor);
  if (index >= value.length) return value.length;
  for (const segment of graphemeSegments(value)) {
    const end = segment.index + segment.segment.length;
    if (end > index) return end;
  }
  return value.length;
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
      return { value, cursor: previousGraphemeStart(value, cursor) };
    case 'right':
      return { value, cursor: nextGraphemeEnd(value, cursor) };
    case 'home':
      return { value, cursor: 0 };
    case 'end':
      return { value, cursor: value.length };
    case 'backspace':
      if (cursor === 0) return { value, cursor };
      {
        const start = previousGraphemeStart(value, cursor);
        return { value: `${value.slice(0, start)}${value.slice(cursor)}`, cursor: start };
      }
    case 'delete':
      if (cursor >= value.length) return { value, cursor };
      return { value: `${value.slice(0, cursor)}${value.slice(nextGraphemeEnd(value, cursor))}`, cursor };
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
  /** Terminal display cells from line start to cursor, not a UTF-16 index. */
  cursorColumn: number | null;
}

interface LineViewportResult {
  text: string;
  cursorColumn: number;
}

interface DisplaySegment {
  segment: string;
  startColumn: number;
  endColumn: number;
}

function displaySegments(value: string): DisplaySegment[] {
  const segments: DisplaySegment[] = [];
  let column = 0;
  for (const { segment } of graphemeSegments(value)) {
    const width = stringWidth(segment);
    segments.push({ segment, startColumn: column, endColumn: column + width });
    column += width;
  }
  return segments;
}

function lineViewportAroundCursor(text: string, cursorColumn: number, maxWidth?: number): LineViewportResult {
  if (!maxWidth || !Number.isFinite(maxWidth)) return { text, cursorColumn };
  const width = Math.max(1, Math.trunc(maxWidth));
  const lineWidth = stringWidth(text);
  const safeCursor = Math.max(0, Math.min(lineWidth, cursorColumn));
  if (lineWidth <= width) return { text, cursorColumn: safeCursor };

  const startTarget = safeCursor > width ? safeCursor - width : 0;
  const segments = displaySegments(text);
  let startIndex = segments.findIndex((segment) => segment.startColumn >= startTarget);
  if (startIndex < 0) startIndex = Math.max(0, segments.length - 1);
  const visibleStart = segments[startIndex]?.startColumn ?? 0;
  let visibleWidth = 0;
  let visibleText = '';
  for (const segment of segments.slice(startIndex)) {
    const segmentWidth = segment.endColumn - segment.startColumn;
    if (visibleText && visibleWidth + segmentWidth > width) break;
    if (!visibleText && segmentWidth > width) break;
    visibleText += segment.segment;
    visibleWidth += segmentWidth;
  }

  return {
    text: visibleText,
    cursorColumn: Math.max(0, Math.min(width, safeCursor - visibleStart)),
  };
}

function editorPreviewLinesWithCursor(
  value: string,
  _placeholder: string,
  cursor: number,
  maxLines = 8,
  maxLineWidth?: number,
): EditorPreviewLine[] {
  if (!value) return [{ text: '', cursorColumn: 0 }];
  const normalized = sanitizePromptEditorText(value).replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const normalizedCursor = clampPromptCursor(value, cursor);
  const normalizedBeforeCursor = sanitizePromptEditorText(value.slice(0, normalizedCursor)).replace(/\r\n?/g, '\n');
  const cursorLineIndex = normalizedBeforeCursor.split('\n').length - 1;
  const cursorColumn = stringWidth(normalizedBeforeCursor.slice(normalizedBeforeCursor.lastIndexOf('\n') + 1));
  const fitLine = (line: string, lineCursorColumn: number | null): EditorPreviewLine => {
    const viewport = lineViewportAroundCursor(
      line,
      lineCursorColumn ?? stringWidth(line),
      maxLineWidth,
    );
    return {
      text: viewport.text,
      cursorColumn: lineCursorColumn === null ? null : viewport.cursorColumn,
    };
  };
  if (lines.length <= maxLines) {
    return lines.map((line, index) => fitLine(line, index === cursorLineIndex ? cursorColumn : null));
  }
  const hiddenCount = lines.length - maxLines;
  return [
    { text: `... ${hiddenCount} earlier input lines ...`, cursorColumn: null },
    ...lines.slice(-maxLines).map((line, index) => {
      const originalIndex = hiddenCount + index;
      return fitLine(line, originalIndex === cursorLineIndex ? cursorColumn : null);
    }),
  ];
}

export function commandSuggestion(command: string): string | null {
  const normalized = command.trim().toLowerCase();
  if (!normalized.startsWith('/')) return null;
  const firstMeaningfulChar = normalized.replace(/^\//, '')[0] ?? '';
  const preferSubcommand = normalized.includes(' ');
  const scored = KNOWN_COMMANDS
    .map((known, index) => {
      const prefixMatch = known.startsWith(normalized) || normalized.startsWith(known);
      if (prefixMatch) return { known, score: 0, prefixMatch, index };
      const knownToken = known.replace(/^\//, '');
      const inputToken = normalized.replace(/^\//, '');
      const knownFirstChar = knownToken[0] ?? '';
      const knownPrefix = knownToken.slice(0, Math.min(2, knownToken.length, inputToken.length));
      const inputPrefix = inputToken.slice(0, knownPrefix.length);
      if (!firstMeaningfulChar || knownFirstChar !== firstMeaningfulChar || (knownPrefix.length >= 2 && knownPrefix !== inputPrefix)) {
        return { known, score: Number.POSITIVE_INFINITY, prefixMatch, index };
      }
      const score = editDistance(known, normalized);
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
  return best && best.score <= 2 ? best.known : null;
}

function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j += 1) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + cost,
      );
    }
  }
  return rows[a.length]![b.length]!;
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
  if (!beforeCursor.startsWith('/')) return null;
  if (afterCursor && !/^\s/.test(afterCursor)) return null;

  const normalized = beforeCursor.toLowerCase();
  const exactCandidates = KNOWN_COMMANDS.filter((command) => command.startsWith(normalized));
  if (/\s/.test(beforeCursor) && exactCandidates.length === 0) return null;
  const prefixCompletion = exactCandidates.length > 0 ? commonPrefix(exactCandidates) : '';
  const completion = prefixCompletion && prefixCompletion !== beforeCursor
    ? prefixCompletion
    : beforeCursor.length >= 4
      ? commandSuggestion(normalized)
      : prefixCompletion;
  if (!completion || completion === beforeCursor) return null;
  return {
    value: `${completion}${afterCursor}`,
    cursor: completion.length,
  };
}

export function commandArgumentHint(value: string): string | null {
  const normalized = value.trimStart().toLowerCase();
  if (!normalized.startsWith('/')) return null;
  if (normalized === '/auth login') return '[--manual]';
  const [command, ...rest] = normalized.split(/\s+/);
  const hasArg = rest.some(Boolean);
  if (command === '/goal') return hasArg ? null : '[<condition> | clear]';
  if (command === '/connect') return hasArg ? null : '<[user@]board-ip> [--port 22 --key <path> --password <pw>]';
  if (command === '/attach') return hasArg ? null : '<image-or-text-file>';
  if (command === '/model') return hasArg ? null : '<model-name-or-number>';
  if (command === '/auth') return hasArg ? null : '[login | status | logout]';
  if (command === '/status') return hasArg ? null : '[--verbose]';
  return null;
}

export function promptPlaceholder(state: TuiRunState): string {
  if (state === 'approval') return 'choose approval with arrows, Enter, y, a, n, or Esc';
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
  const paths = getMossWorkspacePaths(workspace);
  const memDir = fs.existsSync(paths.memoryDir) ? paths.memoryDir : paths.legacyMemoryDir;
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

function listMarkdownFilenames(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter((file) => file.endsWith('.md'))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function listLearnedSkillFiles(workspace: string): string[] {
  const paths = getMossWorkspacePaths(workspace);
  return [
    ...new Set([
      ...listMarkdownFilenames(paths.learnedSkillsDir),
      ...listMarkdownFilenames(paths.legacyLearnedSkillsDir),
    ]),
  ].sort((left, right) => left.localeCompare(right));
}

interface SkillCandidateListing {
  id: string;
  name: string;
  confidence: string;
}

export function listSkillCandidates(workspace: string): SkillCandidateListing[] {
  const paths = getMossWorkspacePaths(workspace);
  try {
    return fs.readdirSync(paths.skillCandidatesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        let name = entry.name;
        let confidence = '?';
        try {
          const draft = fs.readFileSync(path.join(paths.skillCandidatesDir, entry.name, 'SKILL.draft.md'), 'utf8');
          const nameMatch = draft.match(/^name:\s*"?([^"\n]+)"?/m);
          const confMatch = draft.match(/^confidence:\s*([0-9.]+)/m);
          if (nameMatch) name = nameMatch[1].trim();
          if (confMatch) confidence = confMatch[1];
        } catch {
          /* candidate without a draft still shows by id */
        }
        return { id: entry.name, name, confidence };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  } catch {
    return [];
  }
}

export function renderSkills(workspace: string): string {
  const learned = listLearnedSkillFiles(workspace);
  const candidates = listSkillCandidates(workspace);
  let registered: SkillMeta[] = [];
  try {
    registered = new SkillRegistry({ workspaceDir: workspace }).list();
  } catch {
    registered = [];
  }
  const lines = [
    `Skills: ${registered.length} available, ${learned.length} learned, ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`,
  ];
  if (registered.length > 0) {
    lines.push('Available SKILL.md entries:');
    lines.push(...registered.slice(0, 8).map(formatSkillLine));
    if (registered.length > 8) lines.push(`  ... ${registered.length - 8} more available skill${registered.length - 8 === 1 ? '' : 's'}`);
  } else {
    lines.push('Available SKILL.md entries: none found in .moss/skills/.');
  }
  if (learned.length > 0) {
    lines.push('Learned skills:');
    lines.push(...learned.slice(0, 8).map((file) => `  • ${file}`));
    if (learned.length > 8) lines.push(`  ... ${learned.length - 8} more learned skill${learned.length - 8 === 1 ? '' : 's'}`);
    lines.push('  Manage: /skills forget <file>');
  } else {
    lines.push('Learned skills: none yet.');
  }
  if (candidates.length > 0) {
    lines.push('Skill candidates (auto-distilled, not active yet):');
    lines.push(...candidates.slice(0, 8).map((c) => `  • ${c.id}  ${c.name} (confidence ${c.confidence})`));
    if (candidates.length > 8) lines.push(`  ... ${candidates.length - 8} more candidate${candidates.length - 8 === 1 ? '' : 's'}`);
    lines.push('  Manage: /skills promote <candidate-id> · /skills discard <candidate-id>');
  }
  return lines.join('\n');
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
let activeMarkdownRenderWidth: number | undefined;

function resolveMarkdownTableWidth(): number {
  const rawWidth = activeMarkdownRenderWidth ?? process.stdout.columns ?? DEFAULT_MARKDOWN_TABLE_WIDTH;
  const width = Number.isFinite(rawWidth) ? Math.floor(rawWidth) : DEFAULT_MARKDOWN_TABLE_WIDTH;
  return Math.max(MIN_MARKDOWN_TABLE_WIDTH, Math.min(MAX_MARKDOWN_TABLE_WIDTH, width));
}

function markdownTableCellText(content: unknown, context: unknown): string {
  if (content && typeof content === 'object') {
    const maybeTokens = (content as { tokens?: unknown[] }).tokens;
    const parser = (context as { parser?: { parseInline?: (tokens: unknown[]) => string } }).parser;
    if (Array.isArray(maybeTokens) && typeof parser?.parseInline === 'function') {
      return parser.parseInline(maybeTokens);
    }
    if ('text' in content) return String((content as { text?: unknown }).text ?? '');
  }
  return String(content ?? '');
}

function markdownTableTokenRows(content: unknown, context: unknown): string {
  if (!Array.isArray(content)) return '';
  const rows = Array.isArray(content[0]) ? content : [content];
  return rows
    .map((row) => {
      if (!Array.isArray(row)) return '';
      const cells = row.map((cell) => `${markdownTableCellText(cell, context)}${MARKDOWN_TABLE_CELL}`);
      return `${MARKDOWN_TABLE_ROW}${cells.join('')}${MARKDOWN_TABLE_ROW}`;
    })
    .filter(Boolean)
    .join('\n');
}

function renderMarkdownTableFromRendererArgs(args: unknown[], context: unknown): string {
  const [first, second] = args;
  if (args.length === 1 && first && typeof first === 'object') {
    const token = first as { header?: unknown; rows?: unknown };
    if ('header' in token || 'rows' in token) {
      return renderTerminalFriendlyMarkdownTable(
        markdownTableTokenRows(token.header, context),
        markdownTableTokenRows(token.rows, context),
      );
    }
  }
  return renderTerminalFriendlyMarkdownTable(String(first ?? ''), String(second ?? ''));
}

function cleanMarkdownTableCell(cell: string): string {
  const withoutAnsi = cell.includes('\x1B') ? cell.replace(ANSI_RE, '') : cell;
  return CONTROL_CHAR_RE.test(withoutAnsi)
    ? withoutAnsi.replace(CONTROL_CHAR_RE, '').trim()
    : withoutAnsi.trim();
}

function splitMarkdownTableRows(text: string): string[][] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const unwrapped = line.split(MARKDOWN_TABLE_ROW).join('');
      const cells = unwrapped.split(MARKDOWN_TABLE_CELL);
      if (cells[cells.length - 1] === '') cells.pop();
      return cells.map(cleanMarkdownTableCell);
    })
    .filter((row) => row.length > 0);
}

function splitWideWord(word: string, width: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const char of Array.from(word)) {
    const next = `${current}${char}`;
    if (current && stringWidth(next) > width) {
      parts.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function wrapMarkdownTableCell(value: string, width: number): string[] {
  const text = value.replace(/、\s*/g, '、 ').replace(/\s+/g, ' ').trim();
  if (!text) return [''];

  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    const pieceWidth = COPY_SENSITIVE_TOKEN_RE.test(word) ? width : Math.min(width, 32);
    const pieces = stringWidth(word) > pieceWidth ? splitWideWord(word, pieceWidth) : [word];
    for (const piece of pieces) {
      if (!current) {
        current = piece;
      } else if (stringWidth(`${current} ${piece}`) <= width) {
        current = `${current} ${piece}`;
      } else {
        lines.push(current);
        current = piece;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function padMarkdownTableCell(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - stringWidth(value)))}`;
}

function markdownTableColumnWidths(rows: string[][], tableWidth: number): number[] {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const separatorWidth = Math.max(0, columnCount - 1) * 3;
  const available = Math.max(columnCount * 3, tableWidth - separatorWidth);
  const fairWidth = Math.max(3, Math.floor(available / columnCount));
  const desired = Array.from({ length: columnCount }, (_, index) => (
    Math.max(3, ...rows.map((row) => stringWidth(row[index] ?? '')))
  ));
  const widths = desired.map((width) => Math.min(width, fairWidth));
  let remaining = available - widths.reduce((sum, width) => sum + width, 0);

  while (remaining > 0) {
    let bestIndex = -1;
    let bestDeficit = 0;
    for (let index = 0; index < desired.length; index += 1) {
      const deficit = desired[index] - widths[index];
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    widths[bestIndex] += 1;
    remaining -= 1;
  }

  return widths;
}

function renderMarkdownTableRows(rows: string[][], widths: number[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    const wrapped = widths.map((width, index) => wrapMarkdownTableCell(row[index] ?? '', width));
    const rowHeight = Math.max(1, ...wrapped.map((cell) => cell.length));
    for (let lineIndex = 0; lineIndex < rowHeight; lineIndex += 1) {
      lines.push(widths.map((width, columnIndex) => (
        padMarkdownTableCell(wrapped[columnIndex][lineIndex] ?? '', width)
      )).join(' | ').trimEnd());
    }
  }
  return lines;
}

function renderTerminalFriendlyMarkdownTable(headerText: string, bodyText: string): string {
  const headerRows = splitMarkdownTableRows(headerText);
  const bodyRows = splitMarkdownTableRows(bodyText);
  const rows = [...headerRows, ...bodyRows];
  if (rows.length === 0) return '';

  const widths = markdownTableColumnWidths(rows, resolveMarkdownTableWidth());
  const separator = widths.map(() => '---').join(' | ');
  return [
    ...renderMarkdownTableRows(headerRows, widths),
    separator,
    ...renderMarkdownTableRows(bodyRows, widths),
  ].join('\n');
}

function ensureMarkdownRenderer(): void {
  if (markdownRendererConfigured) return;
  marked.setOptions({ mangle: false, headerIds: false } as Parameters<typeof marked.setOptions>[0]);
  // marked-terminal's runtime extension shape is valid for marked.use(), but
  // its current .d.ts does not model the MarkedExtension intersection.
  // Tone down the default colors so the outer theme drives accent — code/quote
  // become dim, headings keep bold so they remain scannable.
  const terminalMarkdown = markedTerminal({
    reflowText: false,
    code: ui.dim,
    blockquote: ui.dim,
    codespan: ui.cyan,
  }) as unknown as Parameters<typeof marked.use>[0] & {
    renderer: Record<string, (this: unknown, ...args: unknown[]) => string>;
  };
  const terminalRenderer = terminalMarkdown.renderer as Record<
    string,
    (this: unknown, ...args: unknown[]) => string
  >;
  // Lists use marked-terminal's native rendering ("* item", numbered ordered
  // lists, correct nesting). Do NOT try to swap the bullet glyph: a `listitem`
  // OPTION is a style hook applied INSIDE the default "* " prefix (the old
  // double-bullet bug, "*   • item"), and rewriting at the list/listitem
  // renderer level breaks ordered numbering or nested-list line structure
  // because outer lists re-process inner lists' already-rendered text.
  terminalRenderer.tablecell = function tablecell(content: unknown) {
    return `${markdownTableCellText(content, this)}${MARKDOWN_TABLE_CELL}`;
  };
  terminalRenderer.tablerow = function tablerow(content: unknown) {
    const text = markdownTableCellText(content, this);
    return `${MARKDOWN_TABLE_ROW}${text}${MARKDOWN_TABLE_ROW}\n`;
  };
  terminalRenderer.table = function table(...args: unknown[]) {
    return renderMarkdownTableFromRendererArgs(args, this);
  };
  marked.use(terminalMarkdown);
  markdownRendererConfigured = true;
}

export function renderMarkdown(text: string, options: { width?: number } = {}): string {
  ensureMarkdownRenderer();
  const previousWidth = activeMarkdownRenderWidth;
  activeMarkdownRenderWidth = options.width;
  try {
    return sanitizeRenderableText(marked.parse(text) as string).trimEnd();
  } finally {
    activeMarkdownRenderWidth = previousWidth;
  }
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
  // compact agent-style welcome card: one rounded box holding the Moss mark, a help
  // hint, cwd and model — the same shape as agent UI launch panel.
  const cursor = emojiEnabled() ? '▪' : '#';
  return React.createElement(
    Box,
    // flexShrink:0 so the bordered card is NEVER squashed when the transcript is
    // tall — without it Yoga shrinks this multi-line box and its lines overlap
    // (the garbled "model: …cwd…" header in the bug report).
    { flexDirection: 'column', flexShrink: 0, borderStyle: 'round', borderColor: theme.accent, paddingX: 1, marginBottom: 1 },
    React.createElement(Text, null,
      React.createElement(Text, { color: BRAND_ORANGE, bold: true }, '>_'),
      React.createElement(Text, { color: BRAND_CYAN }, ` ${cursor}  `),
      React.createElement(Text, { color: theme.accent, bold: true }, 'Moss'),
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
      // Run mode label (kept subtle, compact agent low-noise status line)
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
  // compact agent-style minimal welcome: one slim context line, a compact "Try"
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
    ...GETTING_STARTED_WORKFLOWS.map((workflow, i) => React.createElement(Text, { key: workflow.title },
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
  const bulletColor = item.status === 'failed' ? theme.error : theme.accent;
  const headline = item.inputSummary || '';
  const elapsedText = item.status === 'running'
    ? '…'
    : ` ${toolOutcomeLabel(item)}${item.elapsedMs ?? 0}ms`;
  const failedMark = item.status === 'failed' ? ' !' : '';

  // compact agent headline: `⏺ Tool (summary)  <elapsed>`. Keep the test-required
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
          : (line.startsWith('@@') || line.startsWith('***')) ? theme.accent
          : theme.textDim,
      }, line));
    } else if (item.toolName === 'write_file' && typeof content === 'string') {
      detailLines = content.split('\n').slice(0, 80).map((line, idx) =>
        React.createElement(Text, { key: idx, color: theme.diffAddedWord }, `+ ${line}`));
    } else if (typeof item.result === 'string' && item.result.trim()) {
      detailLines = item.result.split('\n').slice(0, 40).map((line, idx) =>
        React.createElement(Text, { key: idx, color: theme.textMuted }, line));
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
  selectedIndex?: number;
}

interface ApprovalChoice {
  label: string;
  shortcut: string;
  decision: 'allow-once' | 'allow-always' | 'deny';
  description: string;
}

const APPROVAL_CHOICES: ApprovalChoice[] = [
  {
    label: 'Approve once',
    shortcut: 'y',
    decision: 'allow-once',
    description: 'Allow only this tool call.',
  },
  {
    label: 'Always this scope',
    shortcut: 'a',
    decision: 'allow-always',
    description: 'Trust this scope for the current Moss session.',
  },
  {
    label: 'Deny',
    shortcut: 'n',
    decision: 'deny',
    description: 'Block the request and return control to the conversation.',
  },
];

function clampApprovalChoiceIndex(index: number): number {
  return Math.max(0, Math.min(APPROVAL_CHOICES.length - 1, index));
}

function approvalAnswerFromDecision(decision: 'allow-once' | 'allow-always' | 'deny'): string {
  if (decision === 'allow-once') return 'y';
  if (decision === 'allow-always') return 'a';
  return '';
}

function approvalAnswerForIndex(index: number): string {
  return approvalAnswerFromDecision(APPROVAL_CHOICES[clampApprovalChoiceIndex(index)].decision);
}

function approvalChoicesForQuestion(question: string): ApprovalChoice[] {
  const workspaceScoped = /Scope:\s+workspace\b/i.test(question);
  return APPROVAL_CHOICES.map((choice) => {
    if (choice.decision !== 'allow-always') return choice;
    return workspaceScoped
      ? {
          ...choice,
          label: 'Always this workspace',
          description: 'Trust local operations in this workspace for the current Moss session.',
        }
      : choice;
  });
}

function approvalPromptBodyLines(question: string): string[] {
  // 26 lines leaves room for the inline diff / device-action preview.
  return visibleText(question, 26)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/^\s*Allow once, (?:allow this tool|trust this workspace|allow this scope) for the session, or deny\./.test(line));
}

function approvalBodyLineColor(line: string): string | undefined {
  if (line.startsWith('+') && !line.startsWith('+++')) return theme.diffAddedWord;
  if (line.startsWith('-') && !line.startsWith('---')) return theme.diffRemovedWord;
  return theme.text;
}

export function ApprovalPromptLine({ question, selectedIndex = 0 }: ApprovalPromptLineProps): React.ReactElement {
  const selected = clampApprovalChoiceIndex(selectedIndex);
  const choices = approvalChoicesForQuestion(question);
  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: theme.permission,
      borderLeft: false,
      borderRight: false,
      borderBottom: false,
      marginTop: 1,
      paddingX: 1,
    },
    React.createElement(Text, { color: theme.permission, bold: true }, 'Permission required'),
    ...approvalPromptBodyLines(question).map((line, idx) => (
      React.createElement(Text, { key: idx, color: approvalBodyLineColor(line) }, line)
    )),
    React.createElement(
      Text,
      { color: theme.textDim },
      '←/→ or ↑/↓ choose · Enter submit · y approve · a trust scope · n/Esc deny',
    ),
    ...choices.map((choice, index) => {
      const isSelected = index === selected;
      return React.createElement(Text, {
        key: choice.decision,
        color: isSelected ? theme.permission : theme.textMuted,
        bold: isSelected,
      },
      `${isSelected ? '› ' : '  '}${index + 1}. [${isSelected ? 'x' : ' '}] ${choice.label} (${choice.shortcut})`,
      React.createElement(Text, { color: isSelected ? theme.text : theme.textDim }, ` — ${choice.description}`));
    }),
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
    return sideRule({ id: item.id, text: item.text, ruleColor: theme.tool, textColor: theme.text });
  }
  if (item.kind === 'assistant' && !item.finalized) {
    const refs = extractAttachmentRefs(item.text);
    return React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      React.createElement(Text, { color: theme.text }, visibleText(item.text)),
      React.createElement(Text, { color: theme.accent }, '●'),
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
    // compact agent-style echo: plain text on a subtle grey block, no border.
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
        color: ref.kind === 'image' ? theme.accent : theme.warn,
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
  onPasteAttachmentShortcut?: () => void;
  hint?: string;
  model?: string;
  mode?: string;
  /** File-based custom commands to merge into the slash-command menu. */
  extraCommandRows?: ReadonlyArray<readonly [string, string]>;
}

function commandRowsForInput(
  value: string,
  extra: ReadonlyArray<readonly [string, string]> = [],
): Array<[string, string]> {
  return commandRowsForSlashInput(value, extra);
}

export function promptEditorRowBudget(
  value: string,
  options: {
    hint?: string;
    model?: string;
    placeholder?: string;
    maxPreviewLines?: number;
    extraCommandRows?: ReadonlyArray<readonly [string, string]>;
  } = {},
): number {
  const maxPreviewLines = options.maxPreviewLines ?? 6;
  let rows = 1; // PromptEditor marginTop.
  const commandRows = commandRowsForInput(value, options.extraCommandRows ?? []);
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
  onPasteAttachmentShortcut,
  hint,
  model: _model,
  mode,
  extraCommandRows,
}: PromptEditorProps): React.ReactElement {
  const lineCount = value.length > 0 ? value.split('\n').length : 0;
  const isMulti = lineCount > 1;
  const currentCursor = clampPromptCursor(value, cursor ?? value.length);
  const applyEdit = (intent: PromptEditIntent): void => {
    const next = applyPromptEdit({ value, cursor: currentCursor }, intent);
    onChange(next.value);
    onCursorChange?.(next.cursor);
  };

  // ── Slash-command menu: navigable + responsive window (compact agent style) ──
  const { rows: termRows, columns: termColumns } = useTerminalSize();
  const commandRows = commandRowsForInput(value, extraCommandRows ?? []);
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
    if (key.ctrl && (normalizedInput === 'v' || inputChar === '\u0016')) {
      onPasteAttachmentShortcut?.();
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

  const maxLineTextWidth = Math.max(2, termColumns - 8);
  const lines = editorPreviewLinesWithCursor(value, placeholder, currentCursor, 6, maxLineTextWidth);
  const suggestion = value.startsWith('/') ? commandSuggestion(value) : null;
  const argumentHint = commandArgumentHint(value);
  // Border reflects the active interaction mode (compact agent style).
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
      caretCol = prefixWidth + (lines[idx].cursorColumn ?? 0);
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
        React.createElement(Text, { color: theme.accent, bold: true }, '> '),
        // A leading space sits under the (block) cursor at the input start, so the
        // placeholder text itself is never covered by the caret.
        React.createElement(Text, { color: theme.textMuted }, ` ${placeholder}`),
      )]
    : lines.map((line, index) => React.createElement(
        Text,
        { key: `${index}-${line.text}`, color: theme.text },
        index === 0
          ? React.createElement(Text, { color: theme.accent, bold: true }, '> ')
          : '  ',
        line.text,
        argumentHint && index === lines.length - 1
          ? React.createElement(Text, { color: theme.textDim }, ` ${argumentHint}`)
          : null,
      ));

  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    menuOpen ? React.createElement(Box, { flexDirection: 'column', marginBottom: 1, paddingLeft: 1 },
      ...menuWindow.map(([command, description], i) => {
        const isSel = (menuStart + i) === clampedMenuIndex;
        const descMax = Math.max(8, termColumns - 20);
        const desc = description.length > descMax ? `${description.slice(0, descMax - 1)}…` : description;
        const marker = '› ';
        return React.createElement(Text, { key: command, wrap: 'truncate' },
          React.createElement(Text, { color: theme.accent, bold: true }, isSel ? marker : '  '),
          React.createElement(Text, { color: isSel ? theme.permission : theme.textMuted, bold: isSel }, command.padEnd(14)),
          React.createElement(Text, { color: isSel ? theme.text : theme.textDim }, desc),
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

type SubagentTaskSnapshot = MossAsyncTaskSnapshot<Record<string, unknown>>;

function taskPayloadValue(snapshot: MossAsyncTaskSnapshot, key: string): unknown {
  const payload = snapshot.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

function taskLabel(snapshot: MossAsyncTaskSnapshot): string {
  const label = snapshot.label || String(taskPayloadValue(snapshot, 'task') ?? snapshot.taskId);
  return visibleText(label, 1);
}

function taskElapsed(snapshot: MossAsyncTaskSnapshot, now: number): string {
  const start = snapshot.startedAt ?? snapshot.createdAt;
  const end = snapshot.completedAt ?? now;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function statusIcon(status: MossAsyncTaskSnapshot['status']): string {
  if (status === 'running') return emojiEnabled() ? '⏺' : '*';
  if (status === 'queued') return '·';
  if (status === 'completed') return '✓';
  if (status === 'failed' || status === 'timed_out') return '×';
  return '!';
}

function statusColor(status: MossAsyncTaskSnapshot['status']): string {
  if (status === 'running' || status === 'queued') return theme.accent;
  if (status === 'completed') return theme.success;
  return theme.error;
}

function completionSummary(
  snapshot: MossAsyncTaskSnapshot,
  completion?: MossAsyncTaskCompletion,
): string | undefined {
  const text = completion?.summary || completion?.error || snapshot.error || snapshot.progress?.lastError;
  if (!text) return undefined;
  const oneLine = visibleText(text, 1);
  return oneLine.length > 120 ? `${oneLine.slice(0, 119)}…` : oneLine;
}

function taskMeta(snapshot: MossAsyncTaskSnapshot, now: number): string {
  const progress = snapshot.progress;
  const maxTurns = progress?.maxTurns ?? Number(taskPayloadValue(snapshot, 'maxTurns') ?? 0);
  const parts = [
    snapshot.status,
    taskElapsed(snapshot, now),
    progress?.currentTurn ? `turn ${progress.currentTurn}${maxTurns ? `/${maxTurns}` : ''}` : '',
    progress?.toolCalls !== undefined ? `${progress.toolCalls} tools` : '',
    progress?.lastTool ? `last ${progress.lastTool}` : '',
    typeof taskPayloadValue(snapshot, 'scope') === 'string' ? String(taskPayloadValue(snapshot, 'scope')) : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

export interface SubagentTaskPanelProps {
  tasks: MossAsyncTaskSnapshot[];
  completions?: Map<string, MossAsyncTaskCompletion>;
  now?: number;
}

export function SubagentTaskPanel({
  tasks,
  completions = new Map(),
  now = Date.now(),
}: SubagentTaskPanelProps): React.ReactElement | null {
  if (tasks.length === 0) return null;
  const visible = [...tasks]
    .sort((left, right) => (right.startedAt ?? right.createdAt) - (left.startedAt ?? left.createdAt))
    .slice(0, 6);
  const running = tasks.filter((task) => task.status === 'running').length;
  const queued = tasks.filter((task) => task.status === 'queued').length;
  const failed = tasks.filter((task) => task.status === 'failed' || task.status === 'timed_out').length;
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const summary = [
    running ? `${running} running` : '',
    queued ? `${queued} queued` : '',
    completed ? `${completed} done` : '',
    failed ? `${failed} failed` : '',
  ].filter(Boolean).join(' · ') || `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1, paddingX: 1 },
    React.createElement(Text, null,
      React.createElement(Text, { color: theme.accent, bold: true }, 'Sub-agents '),
      React.createElement(Text, { color: theme.textDim }, `${summary} · /subagents`),
    ),
    ...visible.map((task) => {
      const completion = completions.get(task.taskId);
      const summaryLine = completionSummary(task, completion);
      return React.createElement(Text, { key: task.taskId, wrap: 'truncate' },
        React.createElement(Text, { color: statusColor(task.status), bold: true }, `${statusIcon(task.status)} `),
        React.createElement(Text, { color: theme.text, bold: task.status === 'running' }, taskLabel(task)),
        React.createElement(Text, { color: theme.textDim }, ` · ${taskMeta(task, now)}`),
        summaryLine ? React.createElement(Text, { color: task.status === 'completed' ? theme.textDim : theme.error }, ` · ${summaryLine}`) : null,
      );
    }),
    tasks.length > visible.length
      ? React.createElement(Text, { color: theme.textDim }, `  ... ${tasks.length - visible.length} more sub-agent task${tasks.length - visible.length === 1 ? '' : 's'}`)
      : null,
  );
}

function formatSubagentTaskList(
  tasks: MossAsyncTaskSnapshot[],
  completions: Map<string, MossAsyncTaskCompletion>,
  now = Date.now(),
): string {
  if (tasks.length === 0) return 'No background sub-agents in this session.';
  return [
    `Sub-agents (${tasks.length})`,
    ...[...tasks]
      .sort((left, right) => (right.startedAt ?? right.createdAt) - (left.startedAt ?? left.createdAt))
      .map((task) => {
        const completion = completions.get(task.taskId);
        const summary = completionSummary(task, completion);
        return [
          `  ${statusIcon(task.status)} ${taskLabel(task)} · ${taskMeta(task, now)}`,
          `    id: ${task.taskId}`,
          summary ? `    ${summary}` : '',
        ].filter(Boolean).join('\n');
      }),
    '',
    'Use subagent_status with a task id for the raw completion, or subagent_stop to cancel a running task.',
  ].join('\n');
}

function ModelPicker({ state }: { state: ModelPickerState }): React.ReactElement {
  const maxVisible = 7;
  const choices = state.list.choices;
  const selected = Math.max(0, Math.min(choices.length - 1, state.selectedIndex));
  const start = Math.min(
    Math.max(0, selected - Math.floor(maxVisible / 2)),
    Math.max(0, choices.length - maxVisible),
  );
  const visible = choices.slice(start, start + maxVisible);
  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1, marginBottom: 1 },
    React.createElement(Text, { color: theme.accent, bold: true }, 'Select model'),
    React.createElement(Text, { color: theme.textMuted },
      `${state.list.providerLabel} (${state.list.provider})${state.list.usingBundledDefault ? ' · built-in Moss gateway' : state.list.configPath && state.list.configPathExists !== false ? ` · config ${state.list.configPath}` : ''}`),
    // Name the SOURCE of the entries — live gateway list vs config vs examples —
    // so a deleted config or built-in gateway models never look contradictory.
    React.createElement(Text, { color: theme.textMuted }, describeModelListSource(state.list)),
    React.createElement(Text, { color: theme.textMuted }, 'Choose for this session:'),
    ...visible.map((choice, offset) => {
      const index = start + offset;
      const isSelected = index === selected;
      const current = choice.model === state.list.currentModel ? ' current' : '';
      const modelLabel = choice.label ? ` - ${choice.label}` : '';
      return React.createElement(Text, {
        key: `${choice.provider}-${choice.model}-${index}`,
        color: isSelected ? theme.permission : theme.text,
        bold: isSelected,
      }, `${isSelected ? '› ' : '  '}${String(index + 1).padStart(2, ' ')}. ${choice.model}${modelLabel}${current}`);
    }),
    React.createElement(Text, { color: theme.textDim },
      'Enter choose · Up/Down move · Esc cancel · /model <number> · /model config base_url=<url> key=<api-key> model_name=<model>'),
  );
}

function formatPromptEcho(message: string, attachments: PreparedPromptAttachment[]): string {
  if (attachments.length === 0) return message;
  return `${message}\n${renderPendingAttachmentSummary(attachments)}`;
}

function hasImageAttachment(items: PreparedPromptAttachment[]): boolean {
  return items.some((item) => item.kind === 'image');
}

const IMAGE_INPUT_DISABLED_NOTICE_LINES = [
  'Image input is disabled; image content will not be sent.',
  'Enable image_input=true only for a vision-capable gateway.',
];

function imageInputDisabledNotice(): string {
  return IMAGE_INPUT_DISABLED_NOTICE_LINES.join('\n');
}

type FinishGoalStatus = 'completed' | 'blocked';

interface FinishGoalInput {
  status?: FinishGoalStatus;
  reason?: string;
}

function resolveGoalAutoMaxRuns(): number | undefined {
  const rawText = process.env.DMOSS_GOAL_AUTO_MAX_RUNS?.trim();
  if (!rawText) return undefined;
  const raw = Number.parseInt(rawText, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function cleanGoalReason(value: unknown): string | undefined {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return undefined;
  return text.length > 500 ? text.slice(0, 500) : text;
}

function formatGoalContinuationPrompt(goal: GoalState, runCount: number): string {
  return [
    `/continue active /goal run ${runCount}. Keep working until this goal condition is actually satisfied.`,
    `Goal: ${goal.objective}`,
    'Do the next concrete step now. Do not stop with only a progress summary while the goal remains unfinished.',
    'When the goal is complete, call finish_goal with status "completed" and a short reason.',
    'If the goal is genuinely blocked by missing user input, unavailable credentials, or an external state change after trying the useful next steps, call finish_goal with status "blocked" and a short reason.',
  ].join('\n');
}

function formatGoalSettledMessage(goal: GoalState | undefined, status: FinishGoalStatus, reason?: string): string {
  const label = status === 'completed' ? 'Goal completed' : 'Goal blocked';
  const objective = goal?.objective ? `: ${goal.objective}` : '';
  return `${label}${objective}${reason ? `\nReason: ${reason}` : ''}`;
}

function createFinishGoalTool(params: {
  agent: DmossAgent;
  sessionKey: string;
  onSettled: (goal: GoalState | undefined, status: FinishGoalStatus, reason?: string) => void;
}): Tool<FinishGoalInput> {
  return {
    name: 'finish_goal',
    description: 'Finish the active /goal autonomous run when the goal is completed or genuinely blocked.',
    metadata: {
      permissionBoundary: 'Runtime goal state only',
      sideEffectClass: 'runtime_state',
      requiresApproval: false,
      ui: { surface: 'silent' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['completed', 'blocked'],
          description: 'Use completed when the goal is done; blocked when progress requires user input or an external state change.',
        },
        reason: {
          type: 'string',
          description: 'Concise evidence or blocker summary.',
        },
      },
      required: ['status'],
    },
    async execute(input) {
      const status = input?.status;
      if (status !== 'completed' && status !== 'blocked') {
        return 'finish_goal requires status "completed" or "blocked".';
      }
      const reason = cleanGoalReason(input.reason);
      const goal = status === 'completed'
        ? await params.agent.completeGoal(params.sessionKey, reason)
        : await params.agent.blockGoal(params.sessionKey, reason);
      params.onSettled(goal, status, reason);
      return formatGoalSettledMessage(goal, status, reason);
    },
  };
}

function PendingAttachmentPreview({
  items,
  imageInputEnabled,
}: {
  items: PreparedPromptAttachment[];
  imageInputEnabled?: boolean;
}): React.ReactElement | null {
  if (items.length === 0) return null;
  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    React.createElement(Text, { color: theme.textMuted },
      `  attached ${items.length} for next prompt · Esc clears`),
    imageInputEnabled === false && hasImageAttachment(items)
      ? IMAGE_INPUT_DISABLED_NOTICE_LINES.map((line) =>
          React.createElement(Text, { key: line, color: theme.warn }, `  ${line}`),
        )
      : null,
    ...items.slice(0, 3).map((item) => React.createElement(Text, {
      key: `${item.index}-${item.path}`,
      color: item.kind === 'image' ? theme.primary : theme.warn,
    }, `  [${item.kind === 'image' ? 'Image' : 'File'} #${item.index}] ${item.label}`)),
    items.length > 3 ? React.createElement(Text, { color: theme.textMuted },
      `  ... ${items.length - 3} more attachment${items.length - 3 === 1 ? '' : 's'}`) : null,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main TUI
// ────────────────────────────────────────────────────────────────────────────

/** SGR/legacy mouse report bytes. We never enable mouse reporting ourselves (so the
 *  terminal's own wheel/trackpad scrolls native scrollback — see the render notes),
 *  but a multiplexer/terminal with mouse mode on globally can still forward them; every
 *  useInput must ignore them so a stray wheel never types bytes or fires keys. */
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
    React.createElement(Text, { color: theme.accent, bold: true }, `${glyph} Working `),
    React.createElement(Text, { color: theme.textDim }, `(${secs}s · esc to interrupt)`),
  );
}

export function DmossTui({ agent, skillLearner, runtime, sessionKey }: DmossTuiProps): React.ReactElement {
  const app = useApp();
  const { rows: termRows } = useTerminalSize();
  const workspace = runtime?.workspace || process.cwd();
  const checkpointRef = useRef<FileCheckpointStore | null>(null);
  if (!checkpointRef.current) {
    const paths = getMossWorkspacePaths(workspace);
    checkpointRef.current = new FileCheckpointStore({
      runtimeDir: runtime?.runtimeDir || paths.runtimeDir,
      sessionKey,
    });
  }
  // File-based custom commands (.moss/commands/*.md) join the registry dispatch.
  // Loaded once per session; submitPromptRef bridges to runInput (defined below)
  // without a render-time TDZ on the const.
  const customCommandsRef = useRef<CommandSpec[] | null>(null);
  if (!customCommandsRef.current) {
    customCommandsRef.current = loadCustomCommands({
      workspace,
      configDir: runtime?.configDir ?? resolveConfigDir(),
      reservedNames: reservedBuiltinNames(),
    });
  }
  const submitPromptRef = useRef<(text: string) => void>(() => {});
  // Slash-menu rows for the loaded custom commands (stable for the session).
  const customCommandRows: ReadonlyArray<readonly [string, string]> = (customCommandsRef.current ?? []).map(
    (command) => [command.name, command.summary] as [string, string],
  );
  const [input, setInput] = useState('');
  const [inputCursor, setInputCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [currentModel, setCurrentModel] = useState(agent.config.model || '');
  const [modelPicker, setModelPicker] = useState<ModelPickerState | null>(null);
  const [detailMode, setDetailMode] = useState(process.env.DMOSS_CLI_DETAIL || 'quiet');
  const [showThinking, setShowThinking] = useState(process.env.DMOSS_SHOW_THINKING === 'true');
  const [notice, setNotice] = useState('');
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const [interactionMode, setInteractionMode] = useState<CliInteractionMode>('default');
  const [localShellApproved, setLocalShellApproved] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  // Bumped by /clear to remount <Static>, which resets Ink's committed-output index
  // and accumulator (onStaticChange) so cleared history is not replayed.
  const [staticEpoch, setStaticEpoch] = useState(0);
  // The conversation history flows into the terminal's OWN scrollback via <Static>
  // (each finalized item is written to stdout once and never redrawn), so the user
  // scrolls it with the normal wheel/trackpad/scrollbar — exactly like any terminal
  // program. We deliberately do NOT enable mouse reporting (that captures the wheel
  // and leaks report bytes into the input box) and keep NO in-app scroll viewport.
  // The only measured region is the LIVE tail (the in-flight turn): it is clamped
  // below the terminal height and bottom-anchored so the dynamic frame never reaches
  // full-screen height — at which point Ink clears the screen and rewrites everything,
  // clobbering scrollback (see renderInteractiveFrame/shouldClearTerminalForFrame).
  const liveInnerRef = useRef<DOMElement | null>(null);
  const [liveContentHeight, setLiveContentHeight] = useState(0);
  useLayoutEffect(() => {
    const inner = liveInnerRef.current;
    const h = inner ? measureElement(inner).height : 0;
    setLiveContentHeight((prev) => (prev === h ? prev : h));
  });
  const [flashHint, setFlashHint] = useState<string>('');
  const [ctxUsage, setCtxUsage] = useState<{ used: number; total: number } | undefined>(undefined);
  const [pendingAttachments, setPendingAttachments] = useState<PreparedPromptAttachment[]>([]);
  const [pendingAttachmentBlocks, setPendingAttachmentBlocks] = useState<PromptAttachmentBlock[]>([]);
  const suppressedAutoAttachInputRef = useRef<string | null>(null);
  const [queuedInputs, setQueuedInputsState] = useState<QueuedInput[]>([]);
  const [queuePausedAfterCancel, setQueuePausedAfterCancelState] = useState(false);
  const [subagentTasks, setSubagentTasks] = useState<SubagentTaskSnapshot[]>([]);
  const [subagentCompletions, setSubagentCompletions] = useState<Map<string, MossAsyncTaskCompletion>>(new Map());
  const [goalActivity, setGoalActivity] = useState<GoalActivityState | null>(null);
  const [goalNow, setGoalNow] = useState(Date.now());
  const answerIdRef = useRef<number | null>(null);
  const currentTurnIdRef = useRef<number | null>(null);
  const activeRunControllerRef = useRef<AbortController | null>(null);
  const localShellApprovedRef = useRef(false);
  const flashTimerRef = useRef<NodeJS.Timeout | null>(null);
  const busyRef = useRef(false);
  const approvalRef = useRef<ApprovalState | null>(null);
  const queuedInputsRef = useRef<QueuedInput[]>([]);
  const queuePausedAfterCancelRef = useRef(false);
  const goalAutoRef = useRef<GoalAutoRefState>({
    running: false,
    suspended: false,
    scheduled: false,
    startedAt: 0,
    runCount: 0,
    objective: '',
  });
  const goalAutoTimerRef = useRef<NodeJS.Timeout | null>(null);
  const scheduleGoalContinuationRef = useRef<() => void>(() => {});
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

  useEffect(() => {
    approvalRef.current = approval;
  }, [approval]);

  useEffect(() => {
    if (!goalActivity) return undefined;
    setGoalNow(Date.now());
    const timer = setInterval(() => setGoalNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [goalActivity]);

  const clearGoalActivity = useCallback((): void => {
    goalAutoRef.current = {
      running: false,
      suspended: false,
      scheduled: false,
      startedAt: 0,
      runCount: 0,
      objective: '',
    };
    setGoalActivity(null);
  }, []);

  const activateGoalActivity = useCallback((goal: GoalState): void => {
    const startedAt = Date.now();
    goalAutoRef.current = {
      running: false,
      suspended: false,
      scheduled: false,
      startedAt,
      runCount: 0,
      objective: goal.objective,
    };
    setGoalNow(startedAt);
    setGoalActivity({ objective: goal.objective, startedAt, runCount: 0 });
  }, []);

  const updateGoalActivityFromRef = useCallback((): void => {
    const state = goalAutoRef.current;
    if (!state.objective || state.startedAt <= 0 || state.suspended) {
      setGoalActivity(null);
      return;
    }
    // Preserve live progress counters (turns/tools/checkpoint) across goal
    // run iterations — replacing the whole object reset them every run.
    setGoalActivity((previous) => ({
      ...(previous ?? {}),
      objective: state.objective,
      startedAt: state.startedAt,
      runCount: state.runCount,
    }));
  }, []);

  const refreshSubagentTasks = useCallback((): void => {
    const registry = (agent as unknown as { asyncTasks?: MossAsyncTaskRegistry }).asyncTasks;
    if (!registry) {
      setSubagentTasks([]);
      setSubagentCompletions(new Map());
      return;
    }
    const tasks = registry
      .list()
      .filter((task): task is SubagentTaskSnapshot => task.kind === 'subagent');
    setSubagentTasks(tasks);
    setSubagentCompletions(new Map(
      tasks
        .map((task) => [task.taskId, registry.readCompletion(task.taskId)] as const)
        .filter((entry): entry is readonly [string, MossAsyncTaskCompletion] => entry[1] !== undefined),
    ));
  }, [agent]);

  useEffect(() => {
    refreshSubagentTasks();
    const interval = setInterval(refreshSubagentTasks, busy ? 500 : 2_000);
    return () => clearInterval(interval);
  }, [busy, refreshSubagentTasks]);

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
    const normalizedNext = next.trim();
    const suppressedAutoAttachInput = suppressedAutoAttachInputRef.current;
    if (
      suppressedAutoAttachInput
      && suppressedAutoAttachInput !== normalizedNext
      && !normalizedNext.startsWith(suppressedAutoAttachInput)
    ) {
      suppressedAutoAttachInputRef.current = null;
    }
    if (pendingAttachments.length > 0) {
      const selected = selectReferencedPromptAttachments(next, pendingAttachments, pendingAttachmentBlocks);
      if (selected.attachments.length !== pendingAttachments.length) {
        suppressedAutoAttachInputRef.current = removeAttachmentRefsFromInput(next).trim() || null;
        setPendingAttachments(selected.attachments);
        setPendingAttachmentBlocks(selected.blocks);
      }
    }
    setInput(next);
    setInputCursor((cursor) => clampPromptCursor(next, cursor));
  }, [pendingAttachmentBlocks, pendingAttachments]);

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
    // Append-only: finalized items flow into the terminal's scrollback via <Static>,
    // which needs a stable, never-truncated prefix — front-slicing would desync Ink's
    // static index and corrupt history. Old items are cheap: Static writes each once
    // and never redraws it. /clear remounts Static to reclaim everything.
    setTranscript((items) => [...items, { id, kind, text, ...extra }]);
    return id;
  }, []);

  const createGoalFinishTool = useCallback((): Tool<FinishGoalInput> => createFinishGoalTool({
    agent,
    sessionKey,
    onSettled: (settledGoal, status, reason) => {
      clearGoalActivity();
      addTranscript('system', formatGoalSettledMessage(settledGoal, status, reason));
    },
  }), [addTranscript, agent, clearGoalActivity, sessionKey]);

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

  const switchModelForSession = useCallback((model: string, provider: string, custom = false): void => {
    agent.config.model = model;
    (agent.config as { provider?: string }).provider = provider;
    if (runtime?.config) {
      runtime.config.model = model;
      runtime.config.modelSource = 'cli';
    }
    setCurrentModel(model);
    addTranscript('system', custom
      ? `Model switched to custom model ${model} (${provider})`
      : `Model switched to ${model} (${provider})`);
  }, [addTranscript, agent, runtime]);

  const applyCustomModelConfig = useCallback((rawConfig: string): void => {
    const configPath = runtime?.config?.configPath ?? resolveConfigPath();
    const parsed = parseCustomModelConfigInput(rawConfig);
    if (!parsed.ok) {
      addTranscript('system', `${parsed.message}\n\n${formatCustomModelConfigInstructions(configPath)}`);
      return;
    }

    const nextConfig = parsed.config;
    try {
      const currentConfig = loadConfigFile(configPath);
      saveConfigFileAtPath({
        ...currentConfig,
        provider: nextConfig.provider,
        model: nextConfig.model,
        baseUrl: nextConfig.baseUrl,
        apiKey: nextConfig.apiKey,
        ...(nextConfig.imageInput === undefined ? {} : { imageInput: nextConfig.imageInput }),
      }, configPath);
    } catch (err) {
      addTranscript('error', `Could not save model config: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (runtime?.config) {
      runtime.config.provider = nextConfig.provider;
      runtime.config.providerSource = 'config';
      runtime.config.model = nextConfig.model;
      runtime.config.modelSource = 'config';
      runtime.config.baseUrl = nextConfig.baseUrl;
      runtime.config.baseUrlSource = 'config';
      runtime.config.apiKey = nextConfig.apiKey;
      runtime.config.apiKeySource = 'config';
      runtime.config.usingBundledDefault = false;
      if (nextConfig.imageInput !== undefined) {
        runtime.config.imageInput = nextConfig.imageInput;
        runtime.config.imageInputSource = 'config';
      }
    }

    agent.config.model = nextConfig.model;
    (agent.config as { provider?: string; baseUrl?: string }).provider = nextConfig.provider;
    (agent.config as { provider?: string; baseUrl?: string }).baseUrl = nextConfig.baseUrl;
    agent.config.llmProvider = createCliProvider({
      provider: nextConfig.provider,
      apiKey: nextConfig.apiKey,
      model: nextConfig.model,
      baseUrl: nextConfig.baseUrl,
      imageInput: nextConfig.imageInput,
    });
    setCurrentModel(nextConfig.model);
    setModelPicker(null);
    addTranscript('system', [
      `Custom model configured: ${nextConfig.model} (${nextConfig.provider})`,
      `Saved to ${configPath}`,
      nextConfig.imageInput === false
        ? 'Image input disabled for this provider — omit image_input (or set it true) to send images.'
        : 'Image input enabled for this provider.',
    ].join('\n'));
  }, [addTranscript, agent, runtime]);

  const appendPreparedAttachments = useCallback((prepared: {
    attachments: PreparedPromptAttachment[];
    blocks: PromptAttachmentBlock[];
    warnings: string[];
  }, options: { appendRefsToInput?: boolean; inputPrefix?: string } = {}): void => {
    if (prepared.attachments.length > 0) {
      suppressedAutoAttachInputRef.current = null;
      const nextAttachments = [...pendingAttachments, ...prepared.attachments];
      setPendingAttachments(nextAttachments);
      setPendingAttachmentBlocks([...pendingAttachmentBlocks, ...prepared.blocks]);
      if (options.appendRefsToInput !== false) {
        const nextInput = inputWithAttachmentRefs(options.inputPrefix ?? input, prepared.attachments);
        setInput(nextInput);
        setInputCursor(nextInput.length);
      }
      addTranscript('system', renderPendingAttachmentSummary(nextAttachments));
    }
    for (const warning of prepared.warnings) {
      addTranscript('error', warning);
    }
    if (prepared.attachments.length === 0 && prepared.warnings.length === 0) {
      addTranscript('system', 'No attachments added.');
    }
  }, [addTranscript, input, pendingAttachmentBlocks, pendingAttachments]);

  const prepareStandaloneAttachmentInput = useCallback((message: string): {
    attachments: PreparedPromptAttachment[];
    blocks: PromptAttachmentBlock[];
    warnings: string[];
  } | null => {
    const trimmed = message.trim();
    const singlePath = preparePromptAttachments([trimmed], {
      cwd: workspace,
      startIndex: pendingAttachments.length + 1,
    });
    if (singlePath.attachments.length > 0 && singlePath.warnings.length === 0) return singlePath;

    const values = parseAttachArgs(trimmed);
    if (values.length === 0) return null;
    const prepared = preparePromptAttachments(values, {
      cwd: workspace,
      startIndex: pendingAttachments.length + 1,
    });
    if (prepared.attachments.length === 0 || prepared.warnings.length > 0) return null;
    return prepared;
  }, [pendingAttachments.length, workspace]);

  const pasteClipboardAttachment = useCallback(async (): Promise<void> => {
    try {
      const prepared = await prepareClipboardAttachment({
        runtimeDir: runtime?.runtimeDir || getMossWorkspacePaths(workspace).runtimeDir,
        cwd: workspace,
        startIndex: pendingAttachments.length + 1,
      });
      appendPreparedAttachments(prepared);
      if (prepared.attachments.length > 0) showFlash(`attached ${prepared.attachments.length} clipboard item${prepared.attachments.length === 1 ? '' : 's'}`);
    } catch (err) {
      addTranscript('error', [
        `Could not paste clipboard attachment: ${err instanceof Error ? err.message : String(err)}`,
        'Copy an image, a file in Finder, or a file path, then press Ctrl+V again. You can also paste a file path and press Enter.',
      ].join('\n'));
    }
  }, [addTranscript, appendPreparedAttachments, pendingAttachments.length, runtime?.runtimeDir, showFlash, workspace]);

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    if (goalAutoTimerRef.current) clearTimeout(goalAutoTimerRef.current);
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
    setApproval({ question, selectedIndex: 0, resolve });
  }), []);

  useEffect(() => {
    setCliApprovalAsker((question) => new Promise((resolve) => {
      setApproval({ question, selectedIndex: 0, resolve });
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
    if (modelPicker) {
      const choices = modelPicker.list.choices;
      if (key.escape) {
        setModelPicker(null);
        showFlash('model selection cancelled');
        return;
      }
      if (key.upArrow || (key.ctrl && inputChar.toLowerCase() === 'p')) {
        setModelPicker((picker) => picker ? {
          ...picker,
          selectedIndex: picker.selectedIndex <= 0 ? picker.list.choices.length - 1 : picker.selectedIndex - 1,
        } : picker);
        return;
      }
      if (key.downArrow || (key.ctrl && inputChar.toLowerCase() === 'n')) {
        setModelPicker((picker) => picker ? {
          ...picker,
          selectedIndex: picker.selectedIndex >= picker.list.choices.length - 1 ? 0 : picker.selectedIndex + 1,
        } : picker);
        return;
      }
      if (/^\d$/.test(inputChar)) {
        const selected = Number.parseInt(inputChar, 10) - 1;
        const choice = choices[selected];
        if (choice) {
          setModelPicker(null);
          switchModelForSession(choice.model, modelPicker.list.provider);
        }
        return;
      }
      if (key.return) {
        const choice = choices[Math.max(0, Math.min(choices.length - 1, modelPicker.selectedIndex))];
        if (choice) {
          setModelPicker(null);
          switchModelForSession(choice.model, modelPicker.list.provider);
        }
        return;
      }
      return;
    }
    if (approval) {
      if (key.escape) {
        approval.resolve('');
        setApproval(null);
        return;
      }
      if (key.upArrow || key.leftArrow || (key.ctrl && inputChar.toLowerCase() === 'p')) {
        setApproval((current) => current ? {
          ...current,
          selectedIndex: current.selectedIndex <= 0 ? APPROVAL_CHOICES.length - 1 : current.selectedIndex - 1,
        } : current);
        return;
      }
      if (key.downArrow || key.rightArrow || (key.ctrl && inputChar.toLowerCase() === 'n')) {
        setApproval((current) => current ? {
          ...current,
          selectedIndex: current.selectedIndex >= APPROVAL_CHOICES.length - 1 ? 0 : current.selectedIndex + 1,
        } : current);
        return;
      }
      if (key.return) {
        approval.resolve(approvalAnswerForIndex(approval.selectedIndex));
        setApproval(null);
        return;
      }
      if (/^[1-3]$/.test(inputChar)) {
        approval.resolve(approvalAnswerForIndex(Number.parseInt(inputChar, 10) - 1));
        setApproval(null);
        return;
      }
      const decision = approvalKeyDecision(inputChar, key);
      if (decision === 'deny') {
        approval.resolve(approvalAnswerFromDecision(decision));
        setApproval(null);
        return;
      }
      if (decision === 'allow-once') {
        approval.resolve(approvalAnswerFromDecision(decision));
        setApproval(null);
        return;
      }
      if (decision === 'allow-always') {
        approval.resolve(approvalAnswerFromDecision(decision));
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
    // ssh-style exit: Ctrl+D on an empty idle prompt leaves the board session
    // and restores local tools (quitting moss stays Ctrl+C / /quit).
    if (
      key.ctrl && (normalizedInput === 'd' || inputChar === '\u0004')
      && input === '' && !activeRunControllerRef.current && runtime?.deviceSession
    ) {
      addTranscript('system', disconnectDeviceForSession(agent, runtime));
      showFlash('disconnected from board');
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
    // History scrollback is the terminal's job now (native wheel/trackbar over the
    // <Static> output) — no in-app PageUp/PageDown, so those keys stay free and the
    // view matches normal terminal usage. Esc still interrupts the active run,
    // and clears accidental pending attachments while idle.
    if (key.escape && activeRunControllerRef.current) {
      requestStop();
    } else if (key.escape && pendingAttachments.length > 0) {
      const count = pendingAttachments.length;
      setPendingAttachments([]);
      setPendingAttachmentBlocks([]);
      const nextInput = removeAttachmentRefsFromInput(input);
      suppressedAutoAttachInputRef.current = nextInput.trim() || null;
      setInput(nextInput);
      setInputCursor((cursor) => clampPromptCursor(nextInput, cursor));
      addTranscript('system', `Cleared ${count} pending attachment${count === 1 ? '' : 's'}.`);
      showFlash('attachments cleared');
    }
  });

  const handleCommand = useCallback(async (message: string): Promise<boolean> => {
    // Registry-first dispatch (docs/slash-command-architecture.md): shared
    // commands live in the registry; the legacy chain below shrinks with
    // each migration phase.
    if (message.startsWith('/')) {
      const handled = await runRegistryCommand(message, {
        agent,
        runtime,
        sessionKey,
        workspace,
        locale: cliLocale(),
        surface: 'tui',
        say: (kind, text) => addTranscript(kind, text),
        prefillInput: (text) => {
          setInput(text);
          setInputCursor(text.length);
          showFlash(/^zh/i.test(cliLocale() ?? '') ? '已预填重试命令，补上密码回车' : 'retry command pre-filled — add the password and press Enter');
        },
        submitPrompt: (text) => submitPromptRef.current(text),
      }, customCommandsRef.current ?? []);
      if (handled) return true;
    }
    if (message === '/quit' || message === '/exit') {
      app.exit();
      return true;
    }
    if (message === '/help') {
      addTranscript('system', commandList(customCommandsRef.current ?? []));
      return true;
    }
    if (message === '/paste') {
      await pasteClipboardAttachment();
      return true;
    }
    if (message === '/clear') {
      // History lives in the terminal's scrollback now, so clearing means wiping the
      // screen AND scrollback (2J + 3J), then remounting <Static> (epoch bump) so Ink
      // forgets the committed output it already emitted.
      if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      setTranscript([]);
      setStaticEpoch((n) => n + 1);
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
    if (message === '/attach' || message.startsWith('/attach ')) {
      const arg = message.slice('/attach'.length).trim();
      if (!arg || arg === 'list') {
        addTranscript('system', [
          renderPendingAttachmentSummary(pendingAttachments),
          '',
          'Usage: /attach <image-or-text-file> [more files...]',
          'Supported images: png, jpg, jpeg, gif, webp (max 5 MB, content-verified). Text files up to 200 KB are included as prompt context.',
        ].join('\n'));
        return true;
      }
      if (arg === 'clear') {
        const count = pendingAttachments.length;
        setPendingAttachments([]);
        setPendingAttachmentBlocks([]);
        const nextInput = removeAttachmentRefsFromInput(input);
        suppressedAutoAttachInputRef.current = nextInput.trim() || null;
        setInput(nextInput);
        setInputCursor((cursor) => clampPromptCursor(nextInput, cursor));
        addTranscript('system', count === 0 ? 'No pending attachments.' : `Cleared ${count} pending attachment${count === 1 ? '' : 's'}.`);
        return true;
      }
      const parsed = parseAttachArgs(arg);
      if (parsed.length === 0) {
        addTranscript('system', 'Usage: /attach <image-or-text-file> [more files...]');
        return true;
      }
      const prepared = preparePromptAttachments(parsed, {
        cwd: workspace,
        startIndex: pendingAttachments.length + 1,
      });
      appendPreparedAttachments(prepared, { inputPrefix: '' });
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
    if (message === '/subagents' || message === '/agents') {
      const registry = (agent as unknown as { asyncTasks?: MossAsyncTaskRegistry }).asyncTasks;
      if (!registry) {
        addTranscript('system', 'Background sub-agent registry is unavailable in this session.');
        return true;
      }
      const tasks = registry.list().filter((task) => task.kind === 'subagent');
      const completions = new Map(
        tasks
          .map((task) => [task.taskId, registry.readCompletion(task.taskId)] as const)
          .filter((entry): entry is readonly [string, MossAsyncTaskCompletion] => entry[1] !== undefined),
      );
      setSubagentTasks(tasks as SubagentTaskSnapshot[]);
      setSubagentCompletions(completions);
      addTranscript('system', formatSubagentTaskList(tasks, completions));
      return true;
    }
    // /connect and /disconnect are handled by the command registry above.
    if (message === '/auth' || message.startsWith('/auth ') || message === '/logout') {
      const auth = runtime?.communityAuth;
      if (!auth) {
        addTranscript('error', 'Community auth runtime is unavailable in this session.');
        return true;
      }
      if (message === '/auth' || message === '/auth status') {
        addTranscript('system', `[auth] ${formatCommunityAuthStatus(auth.getStatus())}`);
        return true;
      }
      if (message === '/auth login' || message.startsWith('/auth login ')) {
        const manual = message.split(/\s+/).includes('--manual');
        setBusyState(true);
        try {
          const context = await auth.login((line) => addTranscript('system', line), { manual, openBrowser: !manual });
          addTranscript('system', `[auth] Ready. Logged in as ${context.user.name || context.user.email || context.user.id}.`);
        } catch (err) {
          addTranscript('error', `[auth] ${formatCommunityAuthLoginError(err)}`);
        } finally {
          setBusyState(false);
        }
        return true;
      }
      if (message === '/logout' || message === '/auth logout') {
        const removed = auth.logout();
        addTranscript('system', removed
          ? '[auth] Logged out of the D-Robotics developer community.'
          : '[auth] No D-Robotics developer community session is stored.');
        return true;
      }
      addTranscript('system', 'Usage: /auth <login|status|logout>');
      return true;
    }
    if (message === '/goal' || message.startsWith('/goal ')) {
      const result = await handleGoalCommand({ agent, sessionKey, input: message, locale: cliLocale() });
      addTranscript(result.error ? 'error' : 'system', result.message);
      if (!result.error && result.goal?.status === 'active' && (result.action === 'set' || result.action === 'resume')) {
        activateGoalActivity(result.goal);
        scheduleGoalContinuationRef.current();
      } else if (!result.error && result.action && ['pause', 'complete', 'block', 'clear'].includes(result.action)) {
        clearGoalActivity();
        if (busyRef.current && isImmediateGoalCommand(message)) {
          requestStop();
        }
      }
      return true;
    }
    if (message === '/compact') {
      setBusyState(true);
      try {
        addTranscript('system', await handleCompactCommand(agent, sessionKey));
      } catch (err) {
        addTranscript('error', [
          `Could not compact conversation: ${err instanceof Error ? err.message : String(err)}`,
          'You can keep chatting; try /status --verbose to inspect context, or ask Moss to summarize the current session manually.',
        ].join('\n'));
      } finally {
        setBusyState(false);
      }
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
    if (message.startsWith('/skills promote ')) {
      const promoteArg = message.slice('/skills promote '.length).trim();
      const force = /\s--force$/.test(promoteArg);
      const candidateId = promoteArg.replace(/\s--force$/, '').trim();
      // Low-confidence candidates need an explicit override: promotion makes
      // the skill auto-matchable in future sessions, and the draft itself
      // says it has not been verified by a successful run.
      const listing = listSkillCandidates(workspace).find((c) => c.id === candidateId);
      const confidence = Number.parseFloat(listing?.confidence ?? '');
      if (!force && Number.isFinite(confidence) && confidence < 0.5) {
        addTranscript('error', [
          `Candidate "${candidateId}" has low confidence (${confidence}) — its source run was not a verified success.`,
          `Re-run the workflow successfully first, or promote anyway with: /skills promote ${candidateId} --force`,
        ].join('\n'));
        return true;
      }
      try {
        const { promoteSkillCandidate } = await import('@rdk-moss/skills');
        const result = await promoteSkillCandidate({ workspaceDir: workspace, candidateId });
        if (result) {
          addTranscript('system', `Promoted skill candidate to ${compactPath(result.skillPath)} — it is active for future sessions.`);
        } else {
          addTranscript('error', `Candidate "${candidateId}" was not found or failed validation. /skills lists candidate ids.`);
        }
      } catch (err) {
        addTranscript('error', `Could not promote candidate: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }
    if (message.startsWith('/skills discard ')) {
      const candidateId = message.slice('/skills discard '.length).trim();
      // '.' would make path.join() resolve to the candidates root itself and
      // rmSync(recursive) would wipe EVERY candidate — reject it explicitly.
      if (!candidateId || candidateId === '.' || /[/\\]/.test(candidateId) || candidateId.includes('..')) {
        addTranscript('error', 'Usage: /skills discard <candidate-id>');
        return true;
      }
      const candidateDir = path.join(getMossWorkspacePaths(workspace).skillCandidatesDir, candidateId);
      if (!fs.existsSync(candidateDir)) {
        addTranscript('error', `Candidate "${candidateId}" was not found. /skills lists candidate ids.`);
        return true;
      }
      try {
        fs.rmSync(candidateDir, { recursive: true, force: true });
      } catch (err) {
        addTranscript('error', `Failed to discard candidate "${candidateId}": ${err instanceof Error ? err.message : String(err)}`);
        return true;
      }
      addTranscript('system', `Discarded skill candidate "${candidateId}".`);
      return true;
    }
    if (message.startsWith('/skills forget ')) {
      const fileName = message.slice('/skills forget '.length).trim();
      // '.' aliases the learned-skills directory itself — reject it explicitly.
      if (!fileName || fileName === '.' || /[/\\]/.test(fileName) || fileName.includes('..')) {
        addTranscript('error', 'Usage: /skills forget <learned-skill-file.md>');
        return true;
      }
      const paths = getMossWorkspacePaths(workspace);
      const target = [paths.learnedSkillsDir, paths.legacyLearnedSkillsDir]
        .map((dir) => path.join(dir, fileName))
        .find((candidate) => fs.existsSync(candidate));
      if (!target) {
        addTranscript('error', `Learned skill "${fileName}" was not found. /skills lists learned files.`);
        return true;
      }
      try {
        fs.rmSync(target, { force: true });
      } catch (err) {
        addTranscript('error', `Failed to forget skill "${fileName}": ${err instanceof Error ? err.message : String(err)}`);
        return true;
      }
      addTranscript('system', `Forgot learned skill "${fileName}".`);
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
    // /version is handled by the command registry above.
    if (message === '/model' || message.startsWith('/model ')) {
      const nextModel = message === '/model' ? '' : message.slice(7).trim();
      if (nextModel === 'config' || nextModel.startsWith('config ')) {
        const rawConfig = nextModel === 'config' ? '' : nextModel.slice('config'.length).trim();
        applyCustomModelConfig(rawConfig);
        return true;
      }
      if (!nextModel) {
        const modelChoices = await loadModelChoicesForRuntime(runtime?.config, currentModel, {
          fallbackProvider: (agent.config as { provider?: string }).provider,
        });
        setModelPicker({ list: modelChoices, selectedIndex: 0 });
      } else {
        const modelChoices = await loadModelChoicesForRuntime(runtime?.config, currentModel, {
          fallbackProvider: (agent.config as { provider?: string }).provider,
        });
        const selected = resolveModelSelection(nextModel, modelChoices.choices);
        const model = selected?.model ?? nextModel;
        switchModelForSession(model, modelChoices.provider, !selected);
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
        addTranscript('system', `Created ${compactPath(target)} — Moss auto-loads it. Fill in build/test commands, layout, and conventions.`);
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
        if (result.exitCode !== 0) {
          // Outside a git repo, git dumps a usage screen — show one line instead.
          const notRepo = /not a git repository/i.test(result.output);
          addTranscript('error', notRepo
            ? `Not a git repository: ${workspace} — /diff needs a git workspace.`
            : `git diff failed (exit ${result.exitCode}): ${result.output.trim().split('\n')[0] || 'unknown error'}`);
        } else {
          addTranscript('system', result.output.trim() || '(no unstaged working-tree changes)');
        }
      } catch (err) {
        addTranscript('error', `Could not run git diff: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }
    if (message.startsWith('/')) {
      addTranscript(
        'error',
        unknownSlashCommandLines(message, { suggestion: commandSuggestion(message), locale: cliLocale() }).join('\n'),
      );
      return true;
    }
    return false;
  }, [activateGoalActivity, addTranscript, agent, app, applyCustomModelConfig, clearGoalActivity, currentModel, input, pasteClipboardAttachment, pendingAttachmentBlocks, pendingAttachments, requestStop, runtime, sessionKey, setBusyState, setQueuePausedAfterCancel, setQueuedInputs, switchModelForSession, workspace]);

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

  const runPrompt = useCallback(async (
    message: string,
    attachments: PreparedPromptAttachment[] = [],
    attachmentBlocks: PromptAttachmentBlock[] = [],
    options: RunPromptOptions = {},
  ): Promise<boolean> => {
    let ok = true;
    if (options.echoUser !== false) {
      addTranscript('user', formatPromptEcho(message, attachments));
    }
    if (runtime?.config?.imageInput === false && hasImageAttachment(attachments)) {
      addTranscript('system', imageInputDisabledNotice());
    }
    checkpointRef.current?.open(message);
    setBusyState(true);
    answerIdRef.current = null;
    const controller = new AbortController();
    activeRunControllerRef.current = controller;
    const effectiveMessage = getCliInteractionMode() === 'plan'
      ? `[计划模式] 你现在处于 plan 模式：只读探索代码库，产出清晰的实施计划（步骤 / 涉及文件 / 验证方式）。在用户批准（按 Shift+Tab 切到 default 或 accept-edits）前，不要修改文件或执行有副作用的命令。\n\n${message}`
      : message;
    try {
      let ephemeralTools = options.ephemeralTools ?? [];
      if (!ephemeralTools.some((tool) => tool.name === 'finish_goal')) {
        const activeGoal = await agent.getGoal(sessionKey).catch(() => undefined);
        if (activeGoal?.status === 'active') {
          ephemeralTools = [...ephemeralTools, createGoalFinishTool()];
        }
      }
      for await (const event of agent.streamChat(sessionKey, effectiveMessage, {
        abortSignal: controller.signal,
        ...(attachmentBlocks.length > 0 ? { attachments: attachmentBlocks } : {}),
        ...(ephemeralTools.length > 0 ? { ephemeralTools } : {}),
      })) {
        if (event.type === 'turn_start') {
          currentTurnIdRef.current = event.turn;
          setGoalActivity((goal) => (goal ? { ...goal, turns: (goal.turns ?? 0) + 1 } : goal));
        }
        if (event.type === 'working_context_checkpoint') {
          const rawNextAction = String(event.nextAction ?? '').replace(/\s+/g, ' ').trim();
          const nextAction = sanitizeRenderableText(
            rawNextAction.length > 120 ? `${rawNextAction.slice(0, 119)}…` : rawNextAction,
          );
          setGoalActivity((goal) => (goal
            ? { ...goal, lastCheckpoint: { status: String(event.status), nextAction } }
            : goal));
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
          setGoalActivity((goal) => (goal ? { ...goal, toolCalls: (goal.toolCalls ?? 0) + 1 } : goal));
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
          // Finalize this turn's assistant message now (not only at run end) so it —
          // and the turn's already-ended tool calls — leave the live tail and commit
          // into the <Static> scrollback immediately. The user can then scroll up to
          // read earlier turns mid-run, and the live (redrawn) frame stays bounded to
          // a single turn so Ink never flips into full-screen redraw.
          if (answerIdRef.current !== null) {
            const finishedId = answerIdRef.current;
            setTranscript((items) => items.map((item) => (
              item.id === finishedId ? { ...item, finalized: true } : item
            )));
            answerIdRef.current = null;
          }
          currentTurnIdRef.current = null;
        }
        if (event.type === 'error') {
          ok = false;
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
      ok = false;
      addTranscript('error', controller.signal.aborted ? 'Run stopped.' : String(err instanceof Error ? err.message : err));
    } finally {
      if (activeRunControllerRef.current === controller) activeRunControllerRef.current = null;
      setBusyState(false);
      answerIdRef.current = null;
      currentTurnIdRef.current = null;
      if (!options.autoGoal && ok) scheduleGoalContinuationRef.current();
    }
    return ok;
  }, [addTranscript, agent, createGoalFinishTool, detailMode, runtime, sessionKey, setBusyState, showThinking, skillLearner, updateTranscript]);

  const runGoalContinuation = useCallback(async (): Promise<void> => {
    const state = goalAutoRef.current;
    if (
      state.running
      || state.suspended
      || busyRef.current
      || approvalRef.current
      || queuePausedAfterCancelRef.current
      || queuedInputsRef.current.length > 0
    ) {
      return;
    }

    let goal: GoalState | undefined;
    try {
      goal = await agent.getGoal(sessionKey);
    } catch (err) {
      goalAutoRef.current = { ...goalAutoRef.current, suspended: true };
      setGoalActivity(null);
      addTranscript('error', `Could not read active goal: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!goal || goal.status !== 'active') {
      clearGoalActivity();
      return;
    }

    const maxRuns = resolveGoalAutoMaxRuns();
    const current = goalAutoRef.current.objective === goal.objective ? goalAutoRef.current : {
      ...goalAutoRef.current,
      startedAt: Date.now(),
      runCount: 0,
      objective: goal.objective,
    };
    if (maxRuns !== undefined && current.runCount >= maxRuns) {
      goalAutoRef.current = { ...current, running: false, suspended: true, scheduled: false };
      setGoalActivity(null);
      addTranscript('error', [
        `Goal auto-run paused after ${maxRuns} continuation run${maxRuns === 1 ? '' : 's'}.`,
        'Use /goal resume to continue, /goal clear to stop, or raise/remove DMOSS_GOAL_AUTO_MAX_RUNS for this session.',
      ].join('\n'));
      return;
    }

    const nextRunCount = current.runCount + 1;
    goalAutoRef.current = {
      ...current,
      running: true,
      suspended: false,
      scheduled: false,
      runCount: nextRunCount,
    };
    updateGoalActivityFromRef();

    const finishGoalTool = createGoalFinishTool();
    const ok = await runPrompt(
      formatGoalContinuationPrompt(goal, nextRunCount),
      [],
      [],
      {
        echoUser: false,
        autoGoal: true,
        ephemeralTools: [finishGoalTool],
      },
    );

    const latest = await agent.getGoal(sessionKey).catch(() => undefined);
    if (!latest || latest.status !== 'active') {
      clearGoalActivity();
      return;
    }

    const afterRun = goalAutoRef.current;
    goalAutoRef.current = {
      ...afterRun,
      running: false,
      objective: latest.objective,
      startedAt: afterRun.objective === latest.objective && afterRun.startedAt > 0
        ? afterRun.startedAt
        : Date.now(),
    };
    if (!ok) {
      goalAutoRef.current = { ...goalAutoRef.current, suspended: true };
      setGoalActivity(null);
      addTranscript('system', 'Goal auto-run paused after the current run was stopped or errored. Use /goal resume to continue or /goal clear to stop.');
      return;
    }
    updateGoalActivityFromRef();
    scheduleGoalContinuationRef.current();
  }, [addTranscript, agent, clearGoalActivity, createGoalFinishTool, runPrompt, sessionKey, updateGoalActivityFromRef]);

  const scheduleGoalContinuation = useCallback((): void => {
    const state = goalAutoRef.current;
    if (state.running || state.suspended || state.scheduled) return;
    if (busyRef.current || approvalRef.current || queuePausedAfterCancelRef.current || queuedInputsRef.current.length > 0) return;
    goalAutoRef.current = { ...state, scheduled: true };
    goalAutoTimerRef.current = setTimeout(() => {
      goalAutoTimerRef.current = null;
      goalAutoRef.current = { ...goalAutoRef.current, scheduled: false };
      void runGoalContinuation();
    }, 0);
  }, [runGoalContinuation]);

  useEffect(() => {
    scheduleGoalContinuationRef.current = scheduleGoalContinuation;
  }, [scheduleGoalContinuation]);

  const runInput = useCallback((
    raw: string,
    attachments: PreparedPromptAttachment[] = [],
    attachmentBlocks: PromptAttachmentBlock[] = [],
  ): void => {
    const message = raw.trim();
    if (!message || approval) return;
    void (async () => {
      try {
        if (isLocalShellLine(raw)) {
          await runLocalShell(raw);
          return;
        }
        const handled = await handleCommand(message);
        if (!handled) await runPrompt(message, attachments, attachmentBlocks);
      } catch (err) {
        // One failing command must never take down the whole TUI session.
        addTranscript('error', `Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }, [approval, handleCommand, runLocalShell, runPrompt, addTranscript]);

  // Bridge for custom commands: submit their expanded body as a normal turn.
  submitPromptRef.current = (text: string) => runInput(text);

  useEffect(() => {
    if (!shouldDrainQueue({
      busy,
      approvalActive: approval !== null,
      pausedAfterCancel: queuePausedAfterCancelRef.current,
      queueLength: queuedInputsRef.current.length,
    })) return;
    const [next, ...rest] = queuedInputsRef.current;
    setQueuedInputs(rest);
    if (next) runInput(next.raw, next.attachments ?? [], next.attachmentBlocks ?? []);
  }, [approval, busy, queuePausedAfterCancel, queuedInputs.length, runInput, setQueuedInputs]);

  const submit = useCallback((value: string): void => {
    const raw = value;
    const message = raw.trim();
    setInput('');
    setInputCursor(0);
    if (!message || approval) return;
    historyIndexRef.current = null;
    historyDraftRef.current = '';
    const queuePaused = queuePausedAfterCancelRef.current;
    const queueControlCommand = isQueueControlCommand(message);
    const immediateGoalCommand = isImmediateGoalCommand(message);
    const isImmediateBusyCommand = message === '/stop'
      || message === '/abort'
      || message === '/sessions'
      || message === '/session'
      || queueControlCommand
      || immediateGoalCommand;
    const attachesToPrompt = !message.startsWith('/') && !isLocalShellLine(raw);
    if (
      attachesToPrompt
      && pendingAttachments.length === 0
      && suppressedAutoAttachInputRef.current !== message
    ) {
      const pastedAttachment = prepareStandaloneAttachmentInput(message);
      if (pastedAttachment) {
        appendPreparedAttachments(pastedAttachment, { inputPrefix: message });
        return;
      }
    }
    if (suppressedAutoAttachInputRef.current === message) suppressedAutoAttachInputRef.current = null;
    if (attachesToPrompt) rememberInput(message);
    const selectedAttachments = attachesToPrompt
      ? selectReferencedPromptAttachments(message, pendingAttachments, pendingAttachmentBlocks)
      : { attachments: [], blocks: [] };
    const attachmentsForSubmit = selectedAttachments.attachments;
    const attachmentBlocksForSubmit = selectedAttachments.blocks;
    if (attachesToPrompt && pendingAttachments.length > 0) {
      setPendingAttachments([]);
      setPendingAttachmentBlocks([]);
      suppressedAutoAttachInputRef.current = null;
    }
    if (queuePaused && !queueControlCommand && !message.startsWith('/')) {
      const nextQueue = [...queuedInputsRef.current, {
        raw,
        message,
        enqueuedAt: Date.now(),
        attachments: attachmentsForSubmit,
        attachmentBlocks: attachmentBlocksForSubmit,
      }];
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
      const nextQueue = [...queuedInputsRef.current, {
        raw,
        message,
        enqueuedAt: Date.now(),
        attachments: attachmentsForSubmit,
        attachmentBlocks: attachmentBlocksForSubmit,
      }];
      setQueuedInputs(nextQueue);
      addTranscript('system', `Queued #${nextQueue.length}; next runs when the current task finishes: ${message}`);
      return;
    }
    runInput(raw, attachmentsForSubmit, attachmentBlocksForSubmit);
  }, [
    addTranscript,
    appendPreparedAttachments,
    approval,
    pendingAttachmentBlocks,
    pendingAttachments,
    prepareStandaloneAttachmentInput,
    rememberInput,
    runInput,
    setQueuePausedAfterCancel,
    setQueuedInputs,
  ]);

  const device = runtime?.device
    ? `${runtime.deviceSession?.boardMode ? 'BOARD ' : ''}${runtime.device.user || 'root'}@${runtime.device.host}`
    : 'no device';
  const cacheMode = promptCacheModeLabel(runtime);
  const profile = runtime?.config?.profile || 'balanced';
  const runState: TuiRunState = approval ? 'approval' : busy ? 'running' : 'ready';
  const goalElapsedSeconds = goalActivity
    ? Math.max(0, Math.floor((goalNow - goalActivity.startedAt) / 1000))
    : 0;
  // Structured long-run progress: objective + run/turn/tool counters on one
  // line, the latest working-context checkpoint on its own line (a single
  // long line gets truncated on narrow terminals and hides the checkpoint).
  const goalStatusLines = goalActivity
    ? [
        `${emojiEnabled() ? '◎' : 'o'} goal: ${goalActivity.objective.slice(0, 60)}${goalActivity.objective.length > 60 ? '…' : ''}` +
          `  ·  run ${goalActivity.runCount + 1} · turns ${goalActivity.turns ?? 0} · tools ${goalActivity.toolCalls ?? 0} · ${goalElapsedSeconds}s`,
        ...(goalActivity.lastCheckpoint
          ? [`   next: ${goalActivity.lastCheckpoint.nextAction}`]
          : []),
      ]
    : [];
  const goalStatusText = goalStatusLines[0] ?? '';
  const executionPlane = executionPlaneSummary(runtime);
  const terminalRows = Math.max(12, termRows);
  const promptRows = promptEditorRowBudget(input, {
    placeholder: promptPlaceholder(runState),
    hint: footerHint(runState),
    extraCommandRows: customCommandRows,
  });
  const modelPickerRows = modelPicker ? Math.min(10, modelPicker.list.choices.length + 5) : 0;
  const queueRows = queuedInputs.length > 0 ? Math.min(5, queuedInputs.length + 2) : 0;
  const subagentRows = subagentTasks.length > 0 ? Math.min(8, subagentTasks.length + 2) : 0;
  const footerRows = approval ? 0 : 1;
  const headerRows = 5;
  const approvalRows = approval ? Math.min(12, approvalPromptBodyLines(approval.question).length + 7) : 0;
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
  const expanded = toolsExpanded || detailMode === 'verbose';

  // ── Native-scrollback split ─────────────────────────────────────────────────
  // Finalized history flows into the terminal's OWN scrollback via <Static> (each
  // item is written to stdout once and never redrawn, so the normal wheel/trackbar
  // scrolls it — just like any terminal program); only the in-flight turn is redrawn.
  // An item is committable once it can never change again: user/system/error are
  // immutable on creation; an assistant item once `finalized`; a tool item once it
  // stops running. We commit the maximal DONE PREFIX so <Static> stays append-only.
  const isItemDone = (it: TranscriptItem): boolean =>
    it.kind === 'assistant' ? it.finalized === true
      : it.kind === 'tool' ? it.status !== 'running'
        : true;
  let committedCount = 0;
  for (const it of transcript) {
    if (!isItemDone(it)) break;
    committedCount += 1;
  }
  const committedItems = transcript.slice(0, committedCount);
  const liveItems = transcript.slice(committedCount);

  // Static entries: the launch header + welcome print once at the very top of
  // scrollback (entry 0), then each committed item. Stable keys so <Static> only ever
  // appends new output and never reprints or reorders earlier lines.
  type StaticEntry = { key: string; header: true } | { key: string; header?: false; item: TranscriptItem };
  const staticEntries: StaticEntry[] = [
    { key: 'launch-header', header: true },
    ...committedItems.map((item) => ({ key: `item-${item.id}`, item })),
  ];
  const renderStaticEntry = (entry: StaticEntry): React.ReactElement => entry.header
    ? React.createElement(
        Box,
        { key: entry.key, flexDirection: 'column', paddingX: 1, paddingTop: 1 },
        React.createElement(SessionHeader, {
          device,
          workspace,
          model: currentModel,
          state: runState,
          toolsExpanded: expanded,
          version: `v${getPackageVersion()}`,
          cacheMode,
          profile,
        }),
        React.createElement(WelcomePanel, {
          workspace,
          device,
          model: currentModel,
          cacheMode,
          profile,
          executionPlane,
          tip: boardTip(runtime),
          compact: compactWelcome,
        }),
      )
    : React.createElement(
        Box,
        { key: entry.key, flexShrink: 0, paddingX: 1 },
        React.createElement(TranscriptMessage, { item: entry.item, model: currentModel, toolsExpanded: expanded }),
      );

  // Keep the dynamic (live) frame strictly below the terminal height: the moment it
  // reaches full height Ink clears the screen and rewrites everything, destroying
  // scrollback (see renderInteractiveFrame/shouldClearTerminalForFrame). Reserve rows
  // for the chrome beneath the tail; clamp + bottom-anchor the in-flight turn to the rest.
  const liveChromeRows =
    1 /* paddingTop */
    + (busy && !approval ? 1 : 0) /* working indicator */
    + modelPickerRows
    + subagentRows
    + queueRows
    + noticeRows
    + (flashHint ? 1 : 0)
    + (approval ? approvalRows : promptRows)
    + footerRows
    + 2 /* slack for the one-frame height-measurement lag */;
  const liveBudget = Math.max(3, terminalRows - liveChromeRows);
  const liveClamped = liveContentHeight > liveBudget;
  const liveMargin = liveClamped ? liveBudget - liveContentHeight : 0; // negative → show newest lines

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    // Committed history → terminal scrollback (written once; native scroll shows it all).
    React.createElement(Static<StaticEntry>, { key: `history-${staticEpoch}`, items: staticEntries, children: renderStaticEntry }),
    // Live region: the in-flight turn (clamped + bottom-anchored) and the input chrome.
    // flexShrink:0 keeps it un-squashed; its height stays < terminalRows by construction
    // so Ink writes the history above into scrollback instead of clearing the screen.
    React.createElement(
      Box,
      { flexDirection: 'column', flexShrink: 0, paddingX: 1, paddingTop: 1 },
      liveItems.length > 0
        ? React.createElement(
            Box,
            liveClamped
              ? { flexDirection: 'column', height: liveBudget, overflow: 'hidden' }
              : { flexDirection: 'column' },
            React.createElement(
              Box,
              { flexDirection: 'column', flexShrink: 0, marginTop: liveMargin, ref: liveInnerRef },
              ...liveItems.map((item) => React.createElement(Box, { key: item.id, flexShrink: 0 },
                React.createElement(TranscriptMessage, { item, model: currentModel, toolsExpanded: expanded }),
              )),
            ),
          )
        : null,
      // Live activity line: a self-animating spinner + elapsed seconds while busy, so it
      // is always clear the agent is alive (not frozen) even between visible output.
      busy && !approval ? React.createElement(WorkingIndicator, { key: 'working' }) : null,
      modelPicker ? React.createElement(ModelPicker, { state: modelPicker }) : null,
      React.createElement(SubagentTaskPanel, {
        tasks: subagentTasks,
        completions: subagentCompletions,
      }),
      React.createElement(QueuePreview, { items: queuedInputs, paused: queuePausedAfterCancel }),
      React.createElement(PendingAttachmentPreview, {
        items: pendingAttachments,
        imageInputEnabled: runtime?.config?.imageInput !== false,
      }),
      notice ? React.createElement(Text, { color: theme.warn }, notice) : null,
      flashHint ? React.createElement(Text, { color: theme.warn }, flashHint) : null,
      approval
        ? React.createElement(ApprovalPromptLine, { question: approval.question, selectedIndex: approval.selectedIndex })
        : React.createElement(PromptEditor, {
            value: input,
            cursor: inputCursor,
            onChange: setInputFromTyping,
            onCursorChange: setInputCursor,
            onSubmit: submit,
            placeholder: promptPlaceholder(runState),
            disabled: modelPicker !== null,
            mode: interactionMode,
            onHistoryPrevious: recallHistoryPrevious,
            onHistoryNext: recallHistoryNext,
            onShiftEnter: () => undefined,
            onPasteAttachmentShortcut: () => { void pasteClipboardAttachment(); },
            extraCommandRows: customCommandRows,
          }),
      // Structured goal progress gets its own full-width line so the latest
      // checkpoint is never truncated away by the footer row.
      !approval && goalStatusLines[1] ? React.createElement(
        Box,
        { flexDirection: 'column', paddingX: 1 },
        React.createElement(Text, { color: theme.accent }, goalStatusLines[1]),
      ) : null,
      // One compact agent-style line under the input: the active non-default mode, else
      // the key hints — plus a subtle context-used %.
      !approval ? React.createElement(
        Box,
        { flexDirection: 'row', paddingX: 1 },
        interactionMode !== 'default'
          ? React.createElement(Text, { color: interactionMode === 'plan' ? theme.planMode : theme.autoAccept, bold: true },
              interactionMode === 'plan'
                ? `${emojiEnabled() ? '⏸' : '||'} plan mode on ${emojiEnabled() ? '(⇧⇥ to cycle)' : '(shift+tab to cycle)'}`
                : `${emojiEnabled() ? '⏵⏵' : '>>'} accept edits on ${emojiEnabled() ? '(⇧⇥ to cycle)' : '(shift+tab to cycle)'}`)
          : React.createElement(Text, { color: theme.textDim }, footerHint(runState)),
        goalStatusText ? React.createElement(Text, { color: theme.accent, bold: true },
          `   ${goalStatusText}`) : null,
        ctxUsage ? React.createElement(Text, { color: ctxUsageBarColor(ctxUsage) },
          `   ${Math.round((ctxUsage.used / ctxUsage.total) * 100)}% context used`) : null,
      ) : null,
    ),
  );
}

function commandList(customCommands: readonly CommandSpec[] = []): string {
  const customSection = customCommands.length
    ? [
        '',
        'Custom commands (.moss/commands/*.md)',
        ...customCommands.map((command) => `  ${command.name.padEnd(18)} ${command.summary}`),
      ]
    : [];
  return [
    'Core commands',
    '  /status            view model, workspace, device, and tool state',
    '  /subagents         show background sub-agent status and progress',
    '  /model [name|#]    choose or switch the active model',
    '  /model config ...  save base_url/key/model_name and use it now',
    '  /goal <condition>  run until this goal condition is met',
    '  /compact           compress older conversation history into a summary',
    '  /auth login        optional: link a D-Robotics developer community account',
    '  /connect <ip>      connect an RDK board for this session',
    '  /sessions          list saved conversations you can resume',
    '  /diff              show git working-tree changes',
    '',
    'Shortcuts',
    '  Ctrl+V             attach a copied image, Finder file, or file path',
    '  paste path + Enter attach a local image or text file path',
    '  Esc                stop the active run',
    '  Ctrl+O             expand/collapse tool calls',
    '  Shift+Tab          cycle plan/default/accept-edits modes',
    '  Tab                complete slash command',
    '  Ctrl+C             exit',
    '  !<command>         run a LOCAL host shell command after session approval',
    ...customSection,
    '',
    'Advanced commands still work when needed: /status --verbose, /context, /cost, /rewind, /permissions, /tools, /memory, /skills, /upgrade, /detail, /queue.',
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
      sessionKey: options.sessionKey || createCliSessionKey(),
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
