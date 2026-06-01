import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { DmossAgent, DmossAgentEvent } from '../core/index.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import { setCliApprovalAsker } from './approval.js';
import { renderCliDetailHelp, renderCliExamples, renderCliStatus, renderCliTools, renderCliUpgradeHelp, type CliRuntimeStatus } from './onboarding.js';
import { getPackageVersion } from './package-info.js';
import { startCliUpdateCheck } from './update-check.js';
import { compactPath } from './ui.js';

type TranscriptKind = 'user' | 'assistant' | 'system' | 'error';

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

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
const LONG_TOKEN_RE = /[^\s]{33,}/g;
const COPY_SENSITIVE_TOKEN_RE = /^(?:https?:\/\/|file:\/\/|[A-Za-z]:\\|\/|\.\/|\.\.\/|[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+|[A-Za-z0-9_-]*_[A-Za-z0-9_-]*)/;
const RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LOCAL_SHELL_OUTPUT_LIMIT = 40_000;

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
      env: { ...process.env, OPENCLAW_SHELL: 'dmoss-tui-local' },
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

function visibleText(text: string, maxLines = 10): string {
  const clean = sanitizeRenderableText(text).trimEnd();
  const lines = clean.split('\n');
  if (lines.length <= maxLines) return clean;
  return [
    `... ${lines.length - maxLines} earlier lines hidden ...`,
    ...lines.slice(-maxLines),
  ].join('\n');
}

function commandList(): string {
  return [
    'Commands',
    '  /help              show commands',
    '  /tools             list available tools',
    '  /status            show runtime status',
    '  /examples          show prompt examples',
    '  /model [name]      show or switch model',
    '  /detail [mode]     quiet | progress | verbose',
    '  /memory            show memory count',
    '  /skills            list learned skills',
    '  /upgrade           show update commands',
    '  /stop              stop current run',
    '  /clear             clear visible transcript',
    '  /thinking          toggle thinking deltas',
    '  !<command>         run a local shell command after approval',
    '  /quit              exit',
  ].join('\n');
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
      text: 'Ready. Type a prompt or /help.',
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
      addTranscript('error', `Unknown command: ${message}\nUse /help for available commands.`);
      return true;
    }
    return false;
  }, [addTranscript, agent, app, currentModel, runtime, workspace]);

  const runLocalShell = useCallback(async (raw: string): Promise<void> => {
    const command = raw.slice(1);
    if (!localShellApprovedRef.current) {
      const answer = await askApproval([
        'Allow local shell commands in this TUI session?',
        'Commands run on this host, not on a remote gateway.',
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
  const provider = runtime?.baseUrl ? new URL(runtime.baseUrl).host : 'provider not configured';
  const device = runtime?.device ? `${runtime.device.user || 'root'}@${runtime.device.host}` : 'no device';

  return React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
    React.createElement(Box, { borderStyle: 'round', borderColor: busy ? 'cyan' : 'gray', paddingX: 1, flexDirection: 'column' },
      React.createElement(Box, null,
        React.createElement(Text, { bold: true }, 'D-Moss Agent '),
        React.createElement(Text, { color: 'gray' }, `v${getPackageVersion()}`),
      ),
      React.createElement(Text, null,
        React.createElement(Text, { color: 'gray' }, 'model '),
        React.createElement(Text, { color: 'cyan' }, currentModel),
        React.createElement(Text, { color: 'gray' }, '  provider '),
        provider,
        React.createElement(Text, { color: 'gray' }, '  session '),
        sessionKey,
      ),
      React.createElement(Text, null,
        React.createElement(Text, { color: 'gray' }, 'directory '),
        compactPath(workspace),
        React.createElement(Text, { color: 'gray' }, '  safety '),
        runtime?.safetyMode || 'workspace-write',
        React.createElement(Text, { color: 'gray' }, '  detail '),
        detailMode,
        React.createElement(Text, { color: 'gray' }, '  thinking '),
        showThinking ? 'on' : 'off',
      ),
      React.createElement(Text, null,
        React.createElement(Text, { color: runtime?.device ? 'green' : 'yellow' }, device),
        React.createElement(Text, { color: 'gray' }, `  ${runtime?.meshEnabled ? 'mesh enabled' : 'mesh disabled'}`),
      ),
    ),
    notice ? React.createElement(Text, { color: 'yellow' }, notice) : null,
    React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
      ...visibleTranscript.map((item) => React.createElement(Box, { key: item.id, flexDirection: 'column', marginBottom: 1 },
        React.createElement(Text, { color: item.kind === 'user' ? 'cyan' : item.kind === 'error' ? 'red' : item.kind === 'system' ? 'gray' : undefined },
          item.kind === 'user' ? `› ${item.text}` : visibleText(item.text),
        ),
      )),
    ),
    activities.length > 0 ? React.createElement(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: 'gray', paddingX: 1 },
      ...activities.map((item) => React.createElement(Text, { key: item.id, color: item.status === 'failed' ? 'yellow' : item.status === 'ok' ? 'green' : 'cyan' },
        `${item.status === 'running' ? '•' : item.status === 'ok' ? '✓' : '!'} ${item.label}`,
      )),
    ) : null,
    approval ? React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1 },
      React.createElement(Text, { color: 'yellow', bold: true }, 'Approval required'),
      React.createElement(Text, null, visibleText(approval.question, 8)),
      React.createElement(Text, { color: 'gray' }, 'Press y to approve, n or Esc to deny.'),
    ) : React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { color: busy ? 'gray' : 'cyan' }, busy ? 'running ' : '› '),
      React.createElement(TextInput, {
        value: input,
        onChange: setInput,
        onSubmit: submit,
        placeholder: busy ? 'waiting for response...' : 'type a message or /help',
        focus: !busy,
        showCursor: true,
      }),
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
