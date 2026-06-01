import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { DmossAgent, DmossAgentEvent } from '../core/index.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import { setCliApprovalAsker } from './approval.js';
import { renderCliDetailHelp, renderCliExamples, renderCliStatus, renderCliTools, renderCliUpgradeHelp, type CliRuntimeStatus } from './onboarding.js';
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
  inputRaw?: unknown;
}

interface ApprovalState {
  question: string;
  resolve: (answer: string) => void;
}

export interface QueuedInput {
  raw: string;
  message: string;
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
// Theme & icons (claude-tui inspired warm-orange dark palette)
// ────────────────────────────────────────────────────────────────────────────

const theme = {
  // semantic roles
  primary: '#c65f2a',      // warm orange — prompt/active accents
  primarySoft: '#f59e0b',
  user: '#16833a',         // green — user voice
  tool: '#0369a1',         // blue — tool calls
  warn: '#b45309',         // amber — approval/warning
  error: '#b91c1c',        // red
  success: '#16833a',
  text: undefined,
  textMuted: '#4b5563',
  textDim: '#6b7280',
  border: '#9ca3af',
} as const;

// Glyphs — emoji at line-start only (never in alignment columns).
// Falls back to bracket tags when DMOSS_TUI_NO_EMOJI=1 or terminal lacks UTF-8.
function emojiEnabled(): boolean {
  if (process.env.DMOSS_TUI_NO_EMOJI === '1') return false;
  const lang = `${process.env.LANG || ''} ${process.env.LC_ALL || ''} ${process.env.LC_CTYPE || ''}`;
  if (lang && !/utf-?8/i.test(lang)) return false;
  return true;
}

const TOOL_ICONS_EMOJI: Record<string, string> = {
  read: '📖', read_file: '📖', readfile: '📖',
  write: '✏️ ', write_file: '✏️ ', writefile: '✏️ ',
  edit: '✏️ ', edit_file: '✏️ ',
  bash: '⚡', shell: '⚡', exec: '⚡', run_shell: '⚡',
  grep: '🔍', search: '🔍', glob: '🔍', find: '🔍', list_directory: '📂',
  webfetch: '🌐', web_fetch: '🌐', fetch: '🌐', http_get: '🌐',
  task: '🤖', agent: '🤖',
  todo: '📝', todowrite: '📝', task_create: '📝',
  notebook: '📓', notebookedit: '📓',
};

function toolIcon(toolName: string): string {
  const useEmoji = emojiEnabled();
  const key = toolName.toLowerCase().replace(/[^a-z_]/g, '');
  if (useEmoji) return TOOL_ICONS_EMOJI[key] || '🔧';
  return `[${toolName.slice(0, 6)}]`;
}

function statusIcon(status: 'running' | 'ok' | 'failed' | undefined): string {
  if (!emojiEnabled()) {
    if (status === 'running') return '…';
    if (status === 'failed') return '!';
    return '·';
  }
  if (status === 'running') return '…';
  if (status === 'failed') return '!';
  return '·';
}

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
const HEADLINE_MAX = 72;
const KNOWN_COMMANDS = [
  '/help',
  '/tools',
  '/status',
  '/examples',
  '/model',
  '/models',
  '/detail',
  '/queue',
  '/clearqueue',
  '/memory',
  '/skills',
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
}): string {
  const parts = [
    'D-Moss',
    statusBadge(options.state),
    options.model || 'no model',
    options.device,
    compactPath(options.workspace),
    options.cacheMode || 'cache stable',
  ];
  return parts.filter(Boolean).join('  ');
}

export function footerHint(state: TuiRunState): string {
  if (state === 'approval') return 'y approve · n/Esc deny';
  if (state === 'running') return 'Esc cancel · Enter queue · /queue clear · Ctrl+C exit';
  return 'Ctrl+O tools · /help · Ctrl+C exit';
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
      return { value, cursor: Math.max(0, cursor - 1) };
    case 'right':
      return { value, cursor: Math.min(value.length, cursor + 1) };
    case 'home':
      return { value, cursor: 0 };
    case 'end':
      return { value, cursor: value.length };
    case 'backspace':
      if (cursor === 0) return { value, cursor };
      return { value: `${value.slice(0, cursor - 1)}${value.slice(cursor)}`, cursor: cursor - 1 };
    case 'delete':
      if (cursor >= value.length) return { value, cursor };
      return { value: `${value.slice(0, cursor)}${value.slice(cursor + 1)}`, cursor };
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

interface EditorPreviewLine {
  text: string;
  cursorColumn: number | null;
}

function editorPreviewLinesWithCursor(
  value: string,
  placeholder: string,
  cursor: number,
  maxLines = 8,
): EditorPreviewLine[] {
  if (!value) return [{ text: placeholder, cursorColumn: placeholder.length }];
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
  const scored = KNOWN_COMMANDS
    .map((known) => {
      if (known.startsWith(normalized) || normalized.startsWith(known)) return { known, score: 0 };
      let score = Math.abs(known.length - normalized.length);
      const limit = Math.min(known.length, normalized.length);
      for (let i = 0; i < limit; i += 1) {
        if (known[i] !== normalized[i]) score += 1;
      }
      return { known, score };
    })
    .sort((a, b) => a.score - b.score);
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
  if (state === 'approval') return 'answer approval with y, n, or Esc';
  if (state === 'running') return 'running... /stop to cancel';
  return '';
}

export function statusBadge(state: TuiRunState): string {
  if (state === 'approval') return 'approval needed';
  if (state === 'running') return 'running';
  return 'ready';
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

function renderSkills(workspace: string): string {
  const learnedDir = path.join(workspace, 'skills', 'learned');
  try {
    const files = fs.readdirSync(learnedDir).filter((file) => file.endsWith('.md'));
    return [`Skills: ${files.length} learned`, ...files.map((file) => `  • ${file}`)].join('\n');
  } catch {
    return 'Skills: none learned yet.';
  }
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

function activityLabel(event: DmossAgentEvent): string | null {
  if (event.type === 'compaction') return `compacted ${event.droppedMessages} messages`;
  if (event.type === 'microcompact') return `compressed ${event.compressedCount} items`;
  if (event.type === 'working_context_checkpoint') return `${event.status}`;
  return null;
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
}

export function SessionHeader({ device, workspace, model, state, toolsExpanded, version }: SessionHeaderProps): React.ReactElement {
  const stateLabel = statusBadge(state);
  return React.createElement(
    Box,
    { flexDirection: 'column', marginBottom: 1 },
    React.createElement(
      Box,
      { flexDirection: 'column', borderStyle: 'single', borderColor: theme.border, paddingX: 1, width: 64 },
      React.createElement(Text, null,
        React.createElement(Text, { color: theme.textMuted }, '>_ '),
        React.createElement(Text, { bold: true }, 'D-Moss'),
        React.createElement(Text, { color: theme.textMuted }, version ? ` (${version})` : ''),
      ),
      React.createElement(Text, null,
        React.createElement(Text, { color: theme.textMuted }, 'model:     '),
        React.createElement(Text, { bold: true }, model || 'connecting...'),
        React.createElement(Text, { color: theme.textMuted }, '    /model to change'),
      ),
      React.createElement(Text, null,
        React.createElement(Text, { color: theme.textMuted }, 'directory: '),
        compactPath(workspace),
      ),
      React.createElement(Text, null,
        React.createElement(Text, { color: theme.textMuted }, 'status:    '),
        React.createElement(Text, { color: statusBarColor(state), bold: true }, stateLabel),
        React.createElement(Text, { color: theme.textMuted }, `    ${device}  ·  tools ${toolsExpanded ? 'expanded' : 'collapsed'}`),
      ),
    ),
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
      // Mode
      React.createElement(Text, { color: theme.primary, bold: true }, 'Default'),
      React.createElement(Text, { color: theme.textMuted }, '  '),
      // Status badge
      React.createElement(Text, { color: statusBarColor(state), bold: true }, statusBadge(state)),
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
}

export function WelcomePanel({ workspace, device, model }: WelcomePanelProps): React.ReactElement {
  const commandRows: Array<[string, string]> = [
    ['/model', 'choose what model to use'],
    ['/status', 'inspect runtime, device, and workspace context'],
    ['/tools', 'list available tools and permission surface'],
    ['/examples', 'starter tasks'],
    ['/detail', 'toggle quiet, progress, or verbose detail'],
    ['/thinking', 'toggle thinking deltas'],
    ['/clear', 'clear visible transcript'],
  ];
  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1, paddingLeft: 2 },
    React.createElement(Text, null,
      React.createElement(Text, { bold: true }, 'Tip: '),
      'Ask for code, board diagnostics, shell help, or RDK workflow guidance.',
    ),
    React.createElement(Box, { marginTop: 2, flexDirection: 'column' },
      ...commandRows.map(([command, description]) => React.createElement(Text, { key: command },
        React.createElement(Text, { bold: true }, command.padEnd(12)),
        React.createElement(Text, { color: theme.textMuted }, description),
      )),
      React.createElement(Text, null,
        React.createElement(Text, { bold: true }, 'Ctrl+O'.padEnd(12)),
        React.createElement(Text, { color: theme.textMuted }, 'expand or collapse tool calls'),
      ),
    ),
    React.createElement(Text, { color: theme.textDim }, `workspace ${compactPath(workspace)} · device ${device} · model ${model || 'connecting...'}`),
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
  const icon = toolIcon(item.toolName);
  const sigil = statusIcon(item.status);
  const ruleColor = item.status === 'failed' ? theme.warn : item.status === 'running' ? theme.tool : theme.textMuted;
  const fgColor = item.status === 'failed' ? theme.warn : theme.text;
  const headline = item.inputSummary || '';
  const elapsedText = item.status === 'running'
    ? '…'
    : ` ${item.elapsedMs ?? 0}ms`;
  const failedMark = item.status === 'failed' ? ' !' : '';

  // Build the headline string. Keep the test-required tokens explicit.
  const head = [
    `${icon} `,
    item.toolName,
    headline ? `  ·  ${headline}` : '',
    elapsedText,
    failedMark,
  ].join('');

  let expandedJson: string | null = null;
  if (expanded && item.inputRaw !== undefined) {
    try {
      expandedJson = typeof item.inputRaw === 'string'
        ? item.inputRaw
        : JSON.stringify(item.inputRaw, null, 2);
    } catch {
      expandedJson = String(item.inputRaw);
    }
  }

  if (expandedJson) {
    return React.createElement(
      Box,
      {
        marginTop: 1,
        paddingX: 1,
        borderStyle: 'round',
        borderColor: ruleColor,
        flexDirection: 'column',
      },
      React.createElement(Text, { color: fgColor }, `${sigil} ${head}`),
      React.createElement(Box, { paddingLeft: 2, flexDirection: 'column' },
        ...expandedJson.split('\n').slice(0, 24).map((line, idx) => (
          React.createElement(Text, { key: idx, color: theme.textMuted }, line)
        )),
      ),
    );
  }

  return React.createElement(
    Box,
    {
      marginTop: 1,
      paddingLeft: 1,
      borderStyle: 'single',
      borderLeft: true,
      borderTop: false,
      borderBottom: false,
      borderRight: false,
      borderColor: ruleColor,
      flexDirection: 'column',
    },
    React.createElement(Text, { color: fgColor }, `${sigil} ${head}`),
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
      borderColor: theme.warn,
      paddingX: 1,
    },
    React.createElement(Text, { color: theme.warn, bold: true }, '⚠ approval needed'),
    ...visibleText(question, 8).split('\n').map((line, idx) => (
      React.createElement(Text, { key: idx, color: theme.text }, line)
    )),
    React.createElement(Text, { color: theme.textMuted }, 'y approve · n/Esc deny'),
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
        inputRaw: item.toolInputRaw,
      },
      expanded: toolsExpanded,
    });
  }
  if (item.kind === 'shell') {
    return sideRule({ id: item.id, text: item.text, ruleColor: theme.tool, textColor: theme.textMuted });
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
  if (item.kind === 'assistant') {
    const refs = extractAttachmentRefs(item.text);
    return React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      React.createElement(Text, { color: theme.text }, visibleText(item.text)),
      ...refs.map((ref) => React.createElement(Text, {
        key: `${item.id}-${ref.label}`,
        color: ref.kind === 'image' ? theme.primary : theme.warn,
      }, formatAttachmentChip(ref))),
    );
  }
  if (item.kind === 'user') {
    return sideRule({ id: item.id, text: item.text, ruleColor: theme.user });
  }
  if (item.kind === 'error') {
    const refs = extractAttachmentRefs(item.text);
    const lines = visibleText(item.text).split('\n');
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
        borderColor: theme.error,
      },
      React.createElement(Text, { color: theme.error, bold: true }, '! error'),
      ...lines.map((line, idx) => React.createElement(Text, {
        key: `${item.id}-${idx}`,
        color: theme.text,
      }, `  ${line || ' '}`)),
      ...refs.map((ref) => React.createElement(Text, {
        key: `${item.id}-${ref.label}`,
        color: ref.kind === 'image' ? theme.primary : theme.warn,
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
}

function commandRowsForInput(value: string): Array<[string, string]> {
  if (!value.startsWith('/')) return [];
  const normalized = value.trim().toLowerCase();
  const rows: Array<[string, string]> = [
    ['/model', 'choose what model to use'],
    ['/status', 'inspect runtime, device, and workspace context'],
    ['/tools', 'list available tools and permission surface'],
    ['/examples', 'starter tasks'],
    ['/detail', 'toggle quiet, progress, or verbose detail'],
    ['/queue', 'show or clear queued prompts'],
    ['/thinking', 'toggle thinking deltas'],
    ['/clear', 'clear visible transcript'],
    ['/quit', 'exit D-Moss'],
  ];
  if (normalized === '/') return rows;
  return rows.filter(([command]) => command.startsWith(normalized));
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
  model,
}: PromptEditorProps): React.ReactElement {
  const lineCount = value.length > 0 ? value.split('\n').length : 0;
  const isMulti = lineCount > 1;
  const currentCursor = clampPromptCursor(value, cursor ?? value.length);
  const applyEdit = (intent: PromptEditIntent): void => {
    const next = applyPromptEdit({ value, cursor: currentCursor }, intent);
    onChange(next.value);
    onCursorChange?.(next.cursor);
  };
  useInput((inputChar, key) => {
    if (disabled) return;
    if (key.upArrow) {
      onHistoryPrevious?.();
      return;
    }
    if (key.downArrow) {
      onHistoryNext?.();
      return;
    }
    if (key.tab || inputChar === '\t') {
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
      if (key.shift || key.ctrl || inputChar === '\n') {
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
      applyEdit({ type: 'insert', text: inputChar });
    }
  }, { isActive: !disabled });

  const lines = editorPreviewLinesWithCursor(value, placeholder, currentCursor, 6);
  const suggestion = value.startsWith('/') ? commandSuggestion(value) : null;
  const commandRows = commandRowsForInput(value);

  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    !value && (hint || model) ? React.createElement(Text, { color: theme.textMuted },
      `  ${[model || '', hint || ''].filter(Boolean).join('  ·  ')}`,
    ) : null,
    commandRows.length > 0 ? React.createElement(Box, { flexDirection: 'column', marginBottom: 1, paddingLeft: 2 },
      ...commandRows.map(([command, description]) => React.createElement(Text, { key: command },
        React.createElement(Text, { bold: true }, command.padEnd(14)),
        React.createElement(Text, { color: theme.textMuted }, description),
      )),
    ) : null,
    suggestion && commandRows.length === 0 ? React.createElement(Text, { color: theme.textDim }, `  ${suggestion}`) : null,
    isMulti ? React.createElement(Text, { color: theme.textDim }, `  ${lineCount} lines`) : null,
    ...lines.map((line, index) => React.createElement(
      Text,
      { key: `${index}-${line.text}`, color: value ? theme.text : theme.textMuted },
      index === 0
        ? React.createElement(Text, { bold: true }, '> ')
        : '  ',
      line.cursorColumn !== null
        ? line.text.slice(0, line.cursorColumn)
        : line.text,
      !disabled && line.cursorColumn !== null
        ? React.createElement(Text, { color: theme.textMuted }, '▌')
        : null,
      line.cursorColumn !== null
        ? line.text.slice(line.cursorColumn)
        : null,
    )),
  );
}

export interface QueuePreviewProps {
  items: QueuedInput[];
}

export function QueuePreview({ items }: QueuePreviewProps): React.ReactElement | null {
  if (items.length === 0) return null;
  const visible = items.slice(0, 3);
  const hiddenCount = items.length - visible.length;
  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    React.createElement(Text, { color: theme.textMuted },
      `  queued ${items.length} · /queue clear to discard`),
    ...visible.map((item, index) => React.createElement(Text, {
      key: `${index}-${item.message}`,
      color: theme.textMuted,
    }, `  ${index + 1}. ${visibleText(item.message, 1)}`)),
    hiddenCount > 0 ? React.createElement(Text, { color: theme.textMuted },
      `  ... ${hiddenCount} more queued prompt${hiddenCount === 1 ? '' : 's'}`) : null,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main TUI
// ────────────────────────────────────────────────────────────────────────────

function DmossTui({ agent, skillLearner, runtime, sessionKey }: DmossTuiProps): React.ReactElement {
  const app = useApp();
  const { stdout } = useStdout();
  const workspace = runtime?.workspace || process.cwd();
  const [input, setInput] = useState('');
  const [inputCursor, setInputCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [currentModel, setCurrentModel] = useState(agent.config.model || '');
  const [detailMode, setDetailMode] = useState(process.env.DMOSS_CLI_DETAIL || 'quiet');
  const [showThinking, setShowThinking] = useState(process.env.DMOSS_SHOW_THINKING === 'true');
  const [notice, setNotice] = useState('');
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const [localShellApproved, setLocalShellApproved] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [flashHint, setFlashHint] = useState<string>('');
  const [ctxUsage, setCtxUsage] = useState<{ used: number; total: number } | undefined>(undefined);
  const [queuedInputs, setQueuedInputsState] = useState<QueuedInput[]>([]);
  const answerIdRef = useRef<number | null>(null);
  const currentTurnIdRef = useRef<number | null>(null);
  const activeRunControllerRef = useRef<AbortController | null>(null);
  const localShellApprovedRef = useRef(false);
  const flashTimerRef = useRef<NodeJS.Timeout | null>(null);
  const busyRef = useRef(false);
  const queuedInputsRef = useRef<QueuedInput[]>([]);
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
    if (!runtime?.configDir) return;
    startCliUpdateCheck({
      configDir: runtime.configDir,
      currentVersion: getPackageVersion(),
      onNotice: setNotice,
    });
  }, [runtime?.configDir]);

  // Global keybinds: Ctrl+O toggles tool expansion; approval handles y/n/Esc
  useInput((inputChar, key) => {
    if (approval) {
      if (key.escape || inputChar.toLowerCase() === 'n') {
        approval.resolve('');
        setApproval(null);
        return;
      }
      if (inputChar.toLowerCase() === 'y') {
        approval.resolve('y');
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
    if (key.escape && activeRunControllerRef.current) {
      activeRunControllerRef.current.abort(new Error('aborted by user'));
      addTranscript('system', 'Stop requested for the current run.');
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
      addTranscript('system', queue.length === 0
        ? 'Queue is empty.'
        : [
            `Queued prompts (${queue.length})`,
            ...queue.map((item, index) => `  ${index + 1}. ${item.message}`),
            '',
            'Use /queue clear to discard queued prompts.',
          ].join('\n'));
      return true;
    }
    if (message === '/queue clear' || message === '/clearqueue') {
      const count = queuedInputsRef.current.length;
      setQueuedInputs([]);
      addTranscript('system', count === 0 ? 'Queue is already empty.' : `Cleared ${count} queued prompt${count === 1 ? '' : 's'}.`);
      return true;
    }
    if (message === '/stop' || message === '/abort') {
      if (activeRunControllerRef.current) {
        activeRunControllerRef.current.abort(new Error('aborted by user'));
        addTranscript('system', 'Stop requested for the current run.');
      } else {
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
    if (message.startsWith('/')) {
      const suggestion = commandSuggestion(message);
      addTranscript('error', [
        `Unknown command: ${message}`,
        suggestion ? `Did you mean ${suggestion}?` : 'Use /help for available commands.',
      ].join('\n'));
      return true;
    }
    return false;
  }, [addTranscript, agent, app, currentModel, runtime, setQueuedInputs, workspace]);

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
    setBusyState(true);
    answerIdRef.current = null;
    const controller = new AbortController();
    activeRunControllerRef.current = controller;
    try {
      for await (const event of agent.streamChat(sessionKey, message, { abortSignal: controller.signal })) {
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
            const next: TranscriptItem = {
              ...item,
              status: event.isError || event.aborted ? 'failed' : 'ok',
              elapsedMs: item.startedAt ? Date.now() - item.startedAt : undefined,
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
    if (busy || approval || queuedInputsRef.current.length === 0) return;
    const [next, ...rest] = queuedInputsRef.current;
    setQueuedInputs(rest);
    if (next) runInput(next.raw);
  }, [approval, busy, queuedInputs.length, runInput, setQueuedInputs]);

  const submit = useCallback((value: string): void => {
    const raw = value;
    const message = raw.trim();
    setInput('');
    setInputCursor(0);
    if (!message || approval) return;
    rememberInput(message);
    historyIndexRef.current = null;
    historyDraftRef.current = '';
    const isImmediateBusyCommand = message === '/stop'
      || message === '/abort'
      || message === '/queue'
      || message === '/queued'
      || message === '/queue clear'
      || message === '/clearqueue';
    if (busyRef.current && isImmediateBusyCommand) {
      runInput(raw);
      return;
    }
    if (busyRef.current) {
      const nextQueue = [...queuedInputsRef.current, { raw, message }];
      setQueuedInputs(nextQueue);
      addTranscript('system', `Queued #${nextQueue.length}: ${message}`);
      return;
    }
    runInput(raw);
  }, [addTranscript, approval, runInput, setQueuedInputs]);

  const device = runtime?.device ? `${runtime.device.user || 'root'}@${runtime.device.host}` : 'no device';
  const runState: TuiRunState = approval ? 'approval' : busy ? 'running' : 'ready';
  const terminalRows = Math.max(12, stdout?.rows ?? 30);
  const promptRows = Math.min(6, Math.max(1, input ? input.split('\n').length : 1)) + 2 + (input.startsWith('/') ? 8 : 0);
  const queueRows = queuedInputs.length > 0 ? Math.min(5, queuedInputs.length + 2) : 0;
  const footerRows = 0;
  const headerRows = 6;
  const approvalRows = approval ? Math.min(10, approval.question.split('\n').length + 4) : 0;
  const noticeRows = notice ? 1 : 0;
  const transcriptRows = Math.max(1, terminalRows - headerRows - promptRows - queueRows - footerRows - approvalRows - noticeRows - 2);

  // Compose footer hint based on state (drives footerHint text used in tests).
  const footerHintText = footerHint(runState)
    + (queuedInputs.length > 0 ? `  ·  queued ${queuedInputs.length}` : '')
    + (detailMode !== 'progress' ? `  ·  detail ${detailMode}` : '')
    + (showThinking ? '  ·  thinking on' : '')
    + (localShellApproved ? '  ·  local shell' : '');

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1, paddingTop: 1, height: terminalRows },
    React.createElement(SessionHeader, {
      device,
      workspace,
      model: currentModel,
      state: runState,
      toolsExpanded: toolsExpanded || detailMode === 'verbose',
      version: `v${getPackageVersion()}`,
    }),
    React.createElement(
      Box,
      { flexDirection: 'column', height: transcriptRows, overflow: 'hidden' },
      transcript.length === 0
        ? React.createElement(WelcomePanel, { workspace, device, model: currentModel })
        : null,
      ...transcript.map((item) => React.createElement(TranscriptMessage, {
          key: item.id,
          item,
          model: currentModel,
          toolsExpanded: toolsExpanded || detailMode === 'verbose',
        })),
    ),
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
          onHistoryPrevious: recallHistoryPrevious,
          onHistoryNext: recallHistoryNext,
          onShiftEnter: () => undefined,
          model: currentModel,
          hint: footerHintText,
        }),
    React.createElement(QueuePreview, { items: queuedInputs }),
    notice ? React.createElement(Text, { color: theme.warn }, notice) : null,
    flashHint ? React.createElement(Text, { color: theme.warn }, flashHint) : null,
    ctxUsage ? React.createElement(Text, { color: theme.textMuted },
      `ctx ${humanTokens(ctxUsage.used)}/${humanTokens(ctxUsage.total)}`,
    ) : null,
  );
}

function commandList(): string {
  return [
    'Commands',
    '  /examples          starter prompts',
    '  /status            runtime and device context',
    '  /tools             available tools',
    '  /stop              stop the active run',
    '  /queue [clear]     show or discard queued prompts',
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
