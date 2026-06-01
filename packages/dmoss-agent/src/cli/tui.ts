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
}

interface ApprovalState {
  question: string;
  resolve: (answer: string) => void;
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
const KNOWN_COMMANDS = [
  '/help',
  '/tools',
  '/status',
  '/examples',
  '/model',
  '/models',
  '/detail',
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
  if (state === 'running') return '/stop cancel · Ctrl+C exit';
  return 'collapsed (ctrl+o)  |  tab > plan  |  ctrl+k menu';
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

export function promptPlaceholder(state: TuiRunState): string {
  if (state === 'approval') return 'answer approval with y, n, or Esc';
  if (state === 'running') return 'running... /stop to cancel';
  return 'ask D-Moss ... (Enter send | Ctrl+J newline | Ctrl+K menu | /help)';
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
    const shown = entries.slice(0, 5).map((entry) => `  - [${entry.id}] ${entry.content.slice(0, 80)}...`);
    return [`Memory: ${entries.length} entries`, ...shown].join('\n');
  } catch {
    return 'Memory: no entries stored yet.';
  }
}

function renderSkills(workspace: string): string {
  const learnedDir = path.join(workspace, 'skills', 'learned');
  try {
    const files = fs.readdirSync(learnedDir).filter((file) => file.endsWith('.md'));
    return [`Skills: ${files.length} learned`, ...files.map((file) => `  - ${file}`)].join('\n');
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

function statusColor(state: TuiRunState): 'green' | 'cyan' | 'yellow' {
  if (state === 'approval') return 'yellow';
  if (state === 'running') return 'cyan';
  return 'green';
}

let markdownRendererConfigured = false;
function ensureMarkdownRenderer(): void {
  if (markdownRendererConfigured) return;
  marked.setOptions({ mangle: false, headerIds: false } as Parameters<typeof marked.setOptions>[0]);
  // marked-terminal's runtime extension shape is valid for marked.use(), but
  // its current .d.ts does not model the MarkedExtension intersection.
  marked.use(markedTerminal({ reflowText: false }) as unknown as Parameters<typeof marked.use>[0]);
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
}

export function StatusBar({ state, device, workspace, version, notice }: StatusBarProps): React.ReactElement {
  const segments = [
    'Default',
    statusBadge(state),
    device,
    compactPath(workspace),
    version,
  ];
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(
      Box,
      null,
      React.createElement(Text, null, ...segments.map((segment, index) => (
        React.createElement(React.Fragment, { key: index },
          index > 0 ? React.createElement(Text, { dimColor: true }, '   ') : null,
          React.createElement(Text, {
            color: index === 0 ? 'blue' : index === 1 ? statusColor(state) : undefined,
            bold: index === 1,
            dimColor: index > 1,
          }, segment),
        )
      ))),
    ),
    notice ? React.createElement(Text, { color: 'yellow' }, notice) : null,
  );
}

export interface ActivityItemLineProps {
  item: ActivityItem;
}

export function ActivityItemLine({ item }: ActivityItemLineProps): React.ReactElement {
  const glyph = item.status === 'failed' ? '!' : '·';
  const color = item.status === 'failed' ? 'yellow' : item.status === 'ok' ? 'gray' : 'cyan';
  const elapsed = item.status === 'running' ? '…' : ` ${item.elapsedMs ?? 0}ms`;
  const inputSuffix = item.inputSummary ? ` ${ui.dim(item.inputSummary)}` : '';
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
      borderColor: color,
      flexDirection: 'column',
    },
    React.createElement(
      Text,
      { color, dimColor: item.status === 'ok' },
      `${glyph} ${item.toolName}${elapsed}${inputSuffix}`,
    ),
  );
}

export interface ApprovalPromptLineProps {
  question: string;
}

export function ApprovalPromptLine({ question }: ApprovalPromptLineProps): React.ReactElement {
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, { color: 'yellow' }, `? ${visibleText(question, 8)}`),
    React.createElement(Text, { dimColor: true }, '  y approve · n/Esc deny'),
  );
}

export interface TranscriptMessageProps {
  item: TranscriptItem;
}

function decoratedLines(options: {
  id: number;
  text: string;
  marker: string;
  color: 'cyan' | 'red' | 'gray' | 'green' | 'magenta' | 'yellow';
  dim?: boolean;
}): React.ReactElement[] {
  return visibleText(options.text).split('\n').map((line, index) => (
    React.createElement(
      Text,
      {
        key: `${options.id}-${index}`,
        color: options.color,
        dimColor: options.dim,
      },
      index === 0 ? `${options.marker} ${line || ' '}` : `  ${line || ' '}`,
    )
  ));
}

function sideRuleLines(options: {
  id: number;
  text: string;
  ruleColor: 'green' | 'cyan' | 'yellow' | 'red' | 'gray';
  textColor?: 'green' | 'cyan' | 'yellow' | 'red' | 'gray' | 'magenta';
  dim?: boolean;
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
    ...lines.map((line, index) => React.createElement(Text, {
      key: `${options.id}-${index}`,
      color: options.textColor,
      dimColor: options.dim,
    }, `  ${line || ' '}`)),
  );
}

export function TranscriptMessage({ item, model }: TranscriptMessageProps & { model?: string }): React.ReactElement {
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
      },
    });
  }
  if (item.kind === 'shell') {
    return sideRuleLines({ id: item.id, text: item.text, ruleColor: 'cyan', textColor: 'gray' });
  }
  if (item.kind === 'assistant' && item.finalized) {
    const rendered = renderMarkdown(item.text);
    return React.createElement(
      Box,
      { flexDirection: 'column', marginBottom: 1 },
      React.createElement(Text, null, rendered || visibleText(item.text)),
      model ? React.createElement(Text, { dimColor: true }, model) : null,
    );
  }
  if (item.kind === 'assistant') {
    const refs = extractAttachmentRefs(item.text);
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, null, visibleText(item.text)),
      ...refs.map((ref) => React.createElement(Text, { key: `${item.id}-${ref.label}`, color: ref.kind === 'image' ? 'magenta' : 'yellow' },
        formatAttachmentChip(ref),
      )),
    );
  }
  if (item.kind === 'user') {
    return sideRuleLines({ id: item.id, text: item.text, ruleColor: 'green' });
  }
  const refs = extractAttachmentRefs(item.text);
  const color = transcriptColor(item.kind);
  const marker = item.kind === 'error' ? '!' : item.kind === 'system' ? '·' : ' ';
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    ...decoratedLines({
      id: item.id,
      text: item.text,
      marker,
      color: color ?? 'gray',
      dim: item.kind === 'system',
    }),
    ...refs.map((ref) => React.createElement(Text, { key: `${item.id}-${ref.label}`, color: ref.kind === 'image' ? 'magenta' : 'yellow' },
      formatAttachmentChip(ref),
    )),
  );
}

export interface PromptEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  onShiftEnter?: () => void;
}

export function PromptEditor({ value, onChange, onSubmit, placeholder, disabled, onShiftEnter }: PromptEditorProps): React.ReactElement {
  const lineCount = value.length > 0 ? value.split('\n').length : 0;
  const isMulti = lineCount > 1;
  useInput((inputChar, key) => {
    if (disabled) return;
    if (key.return) {
      if (key.shift || key.ctrl || inputChar === '\n') {
        onChange(`${value}\n`);
        onShiftEnter?.();
        return;
      }
      onSubmit(value);
      return;
    }
    if (key.backspace) {
      onChange(value.slice(0, -1));
      return;
    }
    if (key.delete) return;
    if (inputChar) {
      onChange(`${value}${inputChar.replace(/\r\n?/g, '\n')}`);
    }
  }, { isActive: !disabled });

  const lines = editorPreviewLines(value, placeholder, 6);
  const suggestion = value.startsWith('/') ? commandSuggestion(value) : null;
  if (disabled) {
    return React.createElement(
      Box,
      { borderStyle: 'single', borderColor: 'gray', paddingX: 1 },
      React.createElement(Text, { dimColor: true }, `> ${value || placeholder}`),
    );
  }
  return React.createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'single', borderColor: 'gray', paddingX: 1 },
    ...lines.map((line, index) => React.createElement(
      Text,
      { key: `${index}-${line}`, color: value ? undefined : 'gray' },
      index === 0 ? '> ' : '  ',
      line,
      value && index === lines.length - 1 ? React.createElement(Text, { color: 'green' }, '▌') : null,
    )),
    suggestion ? React.createElement(Text, { dimColor: true }, `  ${suggestion}`) : null,
    isMulti ? React.createElement(Text, { dimColor: true }, `  ${lineCount} lines`) : null,
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
  const [busy, setBusy] = useState(false);
  const [currentModel, setCurrentModel] = useState(agent.config.model || '');
  const [detailMode, setDetailMode] = useState(process.env.DMOSS_CLI_DETAIL || 'quiet');
  const [showThinking, setShowThinking] = useState(process.env.DMOSS_SHOW_THINKING === 'true');
  const [notice, setNotice] = useState('');
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const [localShellApproved, setLocalShellApproved] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const answerIdRef = useRef<number | null>(null);
  const currentTurnIdRef = useRef<number | null>(null);
  const activeRunControllerRef = useRef<AbortController | null>(null);
  const localShellApprovedRef = useRef(false);

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
    if (busy) return;
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
  }, [addTranscript, agent, app, currentModel, runtime, workspace]);

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
    setBusy(true);
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
      setBusy(false);
    }
  }, [addTranscript, askApproval, updateTranscript, workspace]);

  const runPrompt = useCallback(async (message: string): Promise<void> => {
    addTranscript('user', message);
    setBusy(true);
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
            toolInput: summarizeToolInput(event.input),
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
            if (detailMode === 'quiet' && next.status === 'ok') return [];
            return [next];
          }));
        }
        if (event.type === 'turn_end') {
          currentTurnIdRef.current = null;
        }
        if (event.type === 'error') {
          addTranscript('error', String(event.error));
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
      setBusy(false);
      answerIdRef.current = null;
      currentTurnIdRef.current = null;
    }
  }, [addTranscript, agent, detailMode, sessionKey, showThinking, skillLearner, updateTranscript]);

  const submit = useCallback((value: string): void => {
    const raw = value;
    const message = raw.trim();
    setInput('');
    if (!message || busy || approval) return;
    void (async () => {
      if (isLocalShellLine(raw)) {
        await runLocalShell(raw);
        return;
      }
      const handled = await handleCommand(message);
      if (!handled) await runPrompt(message);
    })();
  }, [approval, busy, handleCommand, runLocalShell, runPrompt]);

  const device = runtime?.device ? `${runtime.device.user || 'root'}@${runtime.device.host}` : 'no device';
  const runState: TuiRunState = approval ? 'approval' : busy ? 'running' : 'ready';
  const terminalRows = Math.max(12, stdout?.rows ?? 30);
  const promptRows = Math.min(6, Math.max(1, input ? input.split('\n').length : 1)) + 2;
  const footerRows = 1;
  const approvalRows = approval ? Math.min(10, approval.question.split('\n').length + 2) : 0;
  const noticeRows = notice ? 1 : 0;
  const transcriptRows = Math.max(1, terminalRows - promptRows - footerRows - approvalRows - noticeRows - 2);

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1, paddingTop: 1, paddingBottom: 1, height: terminalRows },
    notice ? React.createElement(Text, { color: 'yellow' }, notice) : null,
    React.createElement(
      Box,
      { flexDirection: 'column', height: transcriptRows, overflow: 'hidden' },
      ...transcript.map((item) => React.createElement(TranscriptMessage, { key: item.id, item, model: currentModel })),
    ),
    approval
      ? React.createElement(ApprovalPromptLine, { question: approval.question })
      : React.createElement(
          Box,
          { flexDirection: 'column' },
          React.createElement(PromptEditor, {
            value: input,
            onChange: setInput,
            onSubmit: submit,
            placeholder: promptPlaceholder(runState),
            disabled: busy,
            onShiftEnter: () => undefined,
          }),
        ),
    React.createElement(
      Box,
      { justifyContent: 'space-between' },
      React.createElement(StatusBar, {
        state: runState,
        device,
        workspace,
        version: `v${getPackageVersion()}`,
      }),
      React.createElement(Text, { dimColor: true },
        `${currentModel || 'connecting...'}  |  ${footerHint(runState)}`,
        detailMode !== 'progress' ? `  |  detail ${detailMode}` : '',
        showThinking ? '  |  thinking on' : '',
        localShellApproved ? '  |  local shell' : '',
      ),
    ),
  );
}

function commandList(): string {
  return [
    'Commands',
    '  /examples          starter prompts',
    '  /status            runtime and device context',
    '  /tools             available tools',
    '  /stop              stop the active run',
    '',
    'Conversation',
    '  /clear             clear visible transcript',
    '  /thinking          toggle thinking deltas',
    '  /detail [mode]     quiet | progress | verbose',
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
