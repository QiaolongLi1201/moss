import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import type { DmossAgent, DmossAgentEvent } from '../core/index.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import { setCliApprovalAsker } from './approval.js';
import { renderCliDetailHelp, renderCliExamples, renderCliStatus, renderCliTools, renderCliUpgradeHelp, type CliRuntimeStatus } from './onboarding.js';
import { getPackageVersion } from './package-info.js';
import { startCliUpdateCheck } from './update-check.js';
import { compactPath } from './ui.js';

type TranscriptKind = 'user' | 'assistant' | 'system' | 'error';
type TuiRunState = 'ready' | 'running' | 'approval';

interface TranscriptItem {
  id: number;
  kind: TranscriptKind;
  text: string;
}

interface ActivityItem {
  id: string;
  label: string;
  status: 'running' | 'ok' | 'failed';
}

interface ApprovalState {
  question: string;
  resolve: (answer: string) => void;
}

interface DmossTuiProps {
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

function initialTranscriptText(): string {
  return [
    'Ready. Ask a task or use /examples.',
    '!<command> is local shell only.',
  ].join('\n');
}

export interface AttachmentRef {
  index: number;
  kind: 'image' | 'file';
  label: string;
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
  return 'Enter send · Shift+Enter newline · /help · /status · !cmd local';
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
  return 'message, /examples, /status, or !pwd';
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

function activityLabel(event: DmossAgentEvent): string | null {
  if (event.type === 'turn_start') return `thinking turn ${event.turn}`;
  if (event.type === 'tool_start') return `${event.toolName} running`;
  if (event.type === 'compaction') return `compacted ${event.droppedMessages} messages`;
  if (event.type === 'microcompact') return `compressed ${event.compressedCount} items`;
  if (event.type === 'working_context_checkpoint') return `${event.status}`;
  return null;
}

function transcriptLabel(kind: TranscriptKind): string {
  if (kind === 'user') return 'User';
  if (kind === 'assistant') return 'Assistant';
  if (kind === 'error') return 'Error';
  return 'System';
}

function transcriptColor(kind: TranscriptKind): 'cyan' | 'red' | 'gray' | undefined {
  if (kind === 'user') return 'cyan';
  if (kind === 'error') return 'red';
  if (kind === 'system') return 'gray';
  return undefined;
}

function MultilineInput(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder: string;
  disabled: boolean;
}): React.ReactElement {
  useInput((inputChar, key) => {
    if (props.disabled) return;
    if (key.return) {
      if (key.shift || key.ctrl || inputChar === '\n') {
        props.onChange(`${props.value}\n`);
        return;
      }
      props.onSubmit(props.value);
      return;
    }
    if (key.backspace) {
      props.onChange(props.value.slice(0, -1));
      return;
    }
    if (key.delete) return;
    if (inputChar) {
      props.onChange(`${props.value}${inputChar.replace(/\r\n?/g, '\n')}`);
    }
  }, { isActive: !props.disabled });

  const lines = editorPreviewLines(props.value, props.placeholder, 8);
  return React.createElement(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: props.disabled ? 'gray' : 'cyan', paddingX: 1 },
    ...lines.map((line, index) => React.createElement(Text, { key: `${index}-${line}`, color: props.value ? undefined : 'gray' },
      index === 0 ? '> ' : '  ',
      line,
      props.value && index === lines.length - 1 ? React.createElement(Text, { color: 'cyan' }, '▌') : null,
    )),
  );
}

function DmossTui({ agent, skillLearner, runtime, sessionKey }: DmossTuiProps): React.ReactElement {
  const app = useApp();
  const workspace = runtime?.workspace || process.cwd();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [currentModel, setCurrentModel] = useState(agent.config.model || '');
  const [detailMode, setDetailMode] = useState(process.env.DMOSS_CLI_DETAIL || 'progress');
  const [showThinking, setShowThinking] = useState(process.env.DMOSS_SHOW_THINKING === 'true');
  const [notice, setNotice] = useState('');
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [localShellApproved, setLocalShellApproved] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([
    {
      id: nextId(),
      kind: 'system',
      text: initialTranscriptText(),
    },
  ]);
  const answerIdRef = useRef<number | null>(null);
  const activeRunControllerRef = useRef<AbortController | null>(null);
  const localShellApprovedRef = useRef(false);

  const addTranscript = useCallback((kind: TranscriptKind, text: string): number => {
    const id = nextId();
    setTranscript((items) => [...items, { id, kind, text }].slice(-24));
    return id;
  }, []);

  const updateTranscript = useCallback((id: number, append: string): void => {
    setTranscript((items) => items.map((item) => (
      item.id === id ? { ...item, text: `${item.text}${append}` } : item
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
    if (!approval) return;
    if (key.escape || inputChar.toLowerCase() === 'n') {
      approval.resolve('');
      setApproval(null);
    }
    if (inputChar.toLowerCase() === 'y') {
      approval.resolve('y');
      setApproval(null);
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
        'It does not run on the board, a board gateway, or a remote device.',
        `First command: ${command}`,
      ].join('\n'));
      if (answer.trim().toLowerCase() !== 'y') {
        addTranscript('error', 'Local shell command denied.');
        return;
      }
      localShellApprovedRef.current = true;
      setLocalShellApproved(true);
    }

    const id = addTranscript('system', `$ ${command}\n`);
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
    setActivities([]);
    answerIdRef.current = null;
    const controller = new AbortController();
    activeRunControllerRef.current = controller;
    try {
      for await (const event of agent.streamChat(sessionKey, message, { abortSignal: controller.signal })) {
        const label = activityLabel(event);
        if (label) {
          setActivities((items) => [{ id: `${event.type}-${Date.now()}`, label, status: 'running' as const }, ...items].slice(0, 4));
        }
        if (event.type === 'tool_end') {
          setActivities((items) => [
            { id: `${event.toolCallId}-done`, label: event.toolName, status: event.isError || event.aborted ? 'failed' as const : 'ok' as const },
            ...items.filter((item) => !item.label.startsWith(event.toolName)),
          ].slice(0, 4));
        }
        if (event.type === 'text_delta') {
          if (answerIdRef.current === null) {
            answerIdRef.current = addTranscript('assistant', '');
          }
          updateTranscript(answerIdRef.current, sanitizeRenderableText(event.delta));
        }
        if (event.type === 'thinking_delta' && showThinking) {
          if (answerIdRef.current === null) {
            answerIdRef.current = addTranscript('assistant', '');
          }
          updateTranscript(answerIdRef.current, sanitizeRenderableText(`\n[thinking] ${event.delta}`));
        }
        if (event.type === 'error') {
          addTranscript('error', String(event.error));
        }
        if (event.type === 'done') {
          if (skillLearner && event.result?.toolCalls && event.result.toolCalls.length >= 2) {
            try {
              const messages = await agent.config.sessionStore.loadMessages(sessionKey);
              await skillLearner.maybeLearnFromSession(sessionKey, messages);
            } catch {
              // Learning is best-effort and should not interrupt the conversation.
            }
          }
        }
      }
    } catch (err) {
      addTranscript('error', controller.signal.aborted ? 'Run stopped.' : String(err instanceof Error ? err.message : err));
    } finally {
      if (activeRunControllerRef.current === controller) activeRunControllerRef.current = null;
      setBusy(false);
      setActivities([]);
    }
  }, [addTranscript, agent, sessionKey, showThinking, skillLearner, updateTranscript]);

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

  const visibleTranscript = useMemo(() => transcript.slice(-10), [transcript]);
  const device = runtime?.device ? `${runtime.device.user || 'root'}@${runtime.device.host}` : 'no device';
  const runState: TuiRunState = approval ? 'approval' : busy ? 'running' : 'ready';
  const runStateColor = runState === 'approval' ? 'yellow' : runState === 'running' ? 'cyan' : 'green';
  const topLine = statusLine({
    state: runState,
    model: currentModel,
    device,
    workspace,
  });

  return React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
    React.createElement(Box, null,
      React.createElement(Text, { color: runStateColor, bold: true }, topLine),
      React.createElement(Text, { color: 'gray' }, `  v${getPackageVersion()}`),
    ),
    notice ? React.createElement(Text, { color: 'yellow' }, notice) : null,

    React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
      ...visibleTranscript.map((item) => {
        const refs = extractAttachmentRefs(item.text);
        return React.createElement(Box, { key: item.id, flexDirection: 'column', marginBottom: 1 },
          React.createElement(Text, { color: transcriptColor(item.kind), bold: item.kind !== 'system' }, transcriptLabel(item.kind)),
          React.createElement(Text, { color: transcriptColor(item.kind) }, visibleText(item.text)),
          ...refs.map((ref) => React.createElement(Text, { key: `${item.id}-${ref.label}`, color: ref.kind === 'image' ? 'magenta' : 'yellow' },
            formatAttachmentChip(ref),
          )),
        );
      }),
    ),

    activities.length > 0 ? React.createElement(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: 'cyan', paddingX: 1 },
      React.createElement(Text, { color: 'cyan', bold: true }, 'Activity'),
      ...activities.map((item) => React.createElement(Text, { key: item.id, color: item.status === 'failed' ? 'yellow' : item.status === 'ok' ? 'green' : 'cyan' },
        `${item.status === 'running' ? '•' : item.status === 'ok' ? '✓' : '!'} ${item.label}`,
      )),
    ) : null,
    approval ? React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1 },
      React.createElement(Text, { color: 'yellow', bold: true }, 'Approval required'),
      React.createElement(Text, null, visibleText(approval.question, 8)),
      React.createElement(Text, { color: 'gray' }, 'Press y to approve, n or Esc to deny.'),
    ) : React.createElement(Box, { marginTop: 1, flexDirection: 'column' },
      React.createElement(MultilineInput, {
        value: input,
        onChange: setInput,
        onSubmit: submit,
        placeholder: promptPlaceholder(runState),
        disabled: busy,
      }),
    ),
    React.createElement(Box, { paddingX: 1 },
      React.createElement(Text, { color: 'gray' }, footerHint(runState)),
      React.createElement(Text, { color: 'gray' }, `  detail ${detailMode}`),
      showThinking ? React.createElement(Text, { color: 'gray' }, '  thinking on') : null,
      localShellApproved ? React.createElement(Text, { color: 'yellow' }, '  local shell approved') : null,
    ),
  );
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
