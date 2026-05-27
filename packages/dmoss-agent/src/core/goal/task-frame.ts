import type { LLMMessage } from '../llm/llm-provider.js';
import type { Message } from '../session/session-jsonl.js';

export type TaskFrameStatus =
  | 'active'
  | 'paused_resumable'
  | 'completed'
  | 'error'
  | 'aborted';

export type TaskFrameSource =
  | 'user'
  | 'tool'
  | 'assistant'
  | 'compaction'
  | 'guard'
  | 'max_turns'
  | 'error'
  | 'abort';

export interface TaskFrameToolFinding {
  toolName: string;
  summary: string;
  isError: boolean;
  at: number;
}

export interface TaskFrame {
  schemaVersion: 1;
  sessionKey: string;
  runId?: string;
  goal: string;
  constraints: string[];
  currentStep: string;
  completedSteps: string[];
  pendingSteps: string[];
  artifacts: string[];
  importantPaths: string[];
  toolFindings: TaskFrameToolFinding[];
  lastError?: string;
  nextAction: string;
  status: TaskFrameStatus;
  source: TaskFrameSource;
  updatedAt: number;
}

export interface TaskFrameLoadResult {
  frame?: TaskFrame;
  messages: Message[];
}

export interface ContinuationIntent {
  isContinuation: boolean;
  isArchiveLookup: boolean;
}

const CHECKPOINT_START = '<dmoss_working_context_checkpoint';
const CHECKPOINT_END = '</dmoss_working_context_checkpoint>';
const MAX_TEXT = 900;
const MAX_SHORT_TEXT = 260;
const MAX_LIST = 12;
const MAX_FINDINGS = 10;

function cleanText(value: unknown, max = MAX_TEXT): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function uniquePush(list: string[], value: unknown, maxList = MAX_LIST, maxText = MAX_SHORT_TEXT): void {
  const text = cleanText(value, maxText);
  if (!text) return;
  if (list.includes(text)) return;
  list.push(text);
  if (list.length > maxList) {
    list.splice(0, list.length - maxList);
  }
}

function clipList(values: unknown, maxList = MAX_LIST): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const item of values) uniquePush(out, item, maxList);
  return out;
}

function normalizeFrame(raw: unknown): TaskFrame | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const sessionKey = cleanText(obj.sessionKey, 160);
  const goal = cleanText(obj.goal);
  if (!sessionKey || !goal) return undefined;
  const statusRaw = cleanText(obj.status, 40) as TaskFrameStatus;
  const status: TaskFrameStatus =
    statusRaw === 'paused_resumable' ||
    statusRaw === 'completed' ||
    statusRaw === 'error' ||
    statusRaw === 'aborted' ||
    statusRaw === 'active'
      ? statusRaw
      : 'active';
  const sourceRaw = cleanText(obj.source, 40) as TaskFrameSource;
  const source: TaskFrameSource =
    sourceRaw === 'tool' ||
    sourceRaw === 'assistant' ||
    sourceRaw === 'compaction' ||
    sourceRaw === 'guard' ||
    sourceRaw === 'max_turns' ||
    sourceRaw === 'error' ||
    sourceRaw === 'abort' ||
    sourceRaw === 'user'
      ? sourceRaw
      : 'user';
  const toolFindings: TaskFrameToolFinding[] = Array.isArray(obj.toolFindings)
    ? obj.toolFindings
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const finding = item as Record<string, unknown>;
          const toolName = cleanText(finding.toolName, 80);
          const summary = cleanText(finding.summary, MAX_SHORT_TEXT);
          if (!toolName || !summary) return null;
          return {
            toolName,
            summary,
            isError: Boolean(finding.isError),
            at: Number(finding.at) || Date.now(),
          };
        })
        .filter((item): item is TaskFrameToolFinding => Boolean(item))
        .slice(-MAX_FINDINGS)
    : [];
  return {
    schemaVersion: 1,
    sessionKey,
    runId: cleanText(obj.runId, 160) || undefined,
    goal,
    constraints: clipList(obj.constraints),
    currentStep: cleanText(obj.currentStep) || 'Understand the current request',
    completedSteps: clipList(obj.completedSteps),
    pendingSteps: clipList(obj.pendingSteps),
    artifacts: clipList(obj.artifacts),
    importantPaths: clipList(obj.importantPaths),
    toolFindings,
    lastError: cleanText(obj.lastError) || undefined,
    nextAction: cleanText(obj.nextAction) || 'Continue from the latest saved task state.',
    status,
    source,
    updatedAt: Number(obj.updatedAt) || Date.now(),
  };
}

function extractTextContent(message: Message | LLMMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((block) => {
      if (block.type === 'text') return block.text ?? '';
      if (block.type === 'tool_result') return block.content ?? '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function parseCheckpoint(text: string): TaskFrame | undefined {
  const start = text.indexOf(CHECKPOINT_START);
  if (start < 0) return undefined;
  const openEnd = text.indexOf('>', start);
  const end = text.indexOf(CHECKPOINT_END, openEnd + 1);
  if (openEnd < 0 || end < 0) return undefined;
  const rawJson = text.slice(openEnd + 1, end).trim();
  try {
    return normalizeFrame(JSON.parse(rawJson));
  } catch {
    return undefined;
  }
}

export function isTaskFrameCheckpointMessage(message: Message | LLMMessage): boolean {
  const text = extractTextContent(message);
  return text.includes(CHECKPOINT_START) && text.includes(CHECKPOINT_END);
}

export function splitTaskFrameCheckpointMessages(messages: Message[]): TaskFrameLoadResult {
  let frame: TaskFrame | undefined;
  const kept: Message[] = [];
  for (const message of messages) {
    if (isTaskFrameCheckpointMessage(message)) {
      frame = parseCheckpoint(extractTextContent(message)) ?? frame;
      continue;
    }
    kept.push(message);
  }
  return { frame, messages: kept };
}

export function detectContinuationIntent(userMessage: string): ContinuationIntent {
  const raw = String(userMessage || '').trim();
  const compact = raw.replace(/\s+/g, '');
  const isArchiveLookup =
    /(其他|别的|另一?个|上一?个|上个|历史|过去|之前).{0,8}(会话|对话|聊天|thread|session)|(?:会话|对话|聊天).{0,8}(历史|记录|归档|其他|别的|上一?个|上个)|other\s+(thread|session|conversation)|previous\s+(thread|session|conversation)|chat\s+history|conversation\s+history/iu.test(
      raw,
    );
  if (isArchiveLookup) {
    return { isContinuation: false, isArchiveLookup: true };
  }

  // 口语里常见「请继续 / 麻烦继续」，去空格后不再是 ^继续$，否则会把检查点帧丢掉并生成空壳 working context。
  if (
    /不要继续|别再继续|不想继续|请勿继续|先别继续|别继续了|停止继续/iu.test(raw) ||
    /(?:^|[\s，,])(?:不|别|勿)(?:要|想|能)?\s*继续/iu.test(raw)
  ) {
    return { isContinuation: false, isArchiveLookup: false };
  }

  const exactPhrase =
      /^(继续|接着|接着来|继续吧|继续跑|继续执行|继续处理|继续生成|继续做|往下|下一步|然后呢|刚才那个|刚才的|按刚才|接上|续上|继续上面|继续前面|继续这个)$/iu.test(
      compact,
    );
  const englishPhrase =
    /^(continue|resume|go on|carry on|next step|keep going|please continue|pls continue)$/iu.test(
      raw,
    );
  const politeContinue =
    /^(请|麻烦|帮我|劳烦|辛苦)(你|您)?(请)?(继续|接着|往下|执行|处理|生成)/iu.test(compact) ||
    /^请(你|您)?继续/iu.test(compact);

  const isContinuation = exactPhrase || englishPhrase || politeContinue;
  return { isContinuation, isArchiveLookup: false };
}

export function createOrUpdateTaskFrame(params: {
  previous?: TaskFrame;
  sessionKey: string;
  runId: string;
  userMessage: string;
  now?: number;
}): TaskFrame {
  const now = params.now ?? Date.now();
  const intent = detectContinuationIntent(params.userMessage);
  if (intent.isContinuation && params.previous) {
    return {
      ...params.previous,
      runId: params.runId,
      status: params.previous.status === 'completed' ? 'active' : params.previous.status,
      source: 'user',
      updatedAt: now,
      nextAction: params.previous.nextAction || 'Continue from the latest saved task state.',
    };
  }

  const goal = cleanText(params.userMessage) || params.previous?.goal || 'Continue the current task.';
  return {
    schemaVersion: 1,
    sessionKey: params.sessionKey,
    runId: params.runId,
    goal,
    constraints: [],
    currentStep: intent.isContinuation
      ? 'Resume the latest active task from saved working context'
      : 'Understand the current request',
    completedSteps: [],
    pendingSteps: [],
    artifacts: [],
    importantPaths: [],
    toolFindings: [],
    nextAction: 'Inspect current context and decide the next concrete action.',
    status: 'active',
    source: 'user',
    updatedAt: now,
  };
}

function extractPathCandidates(input: unknown): string[] {
  const out = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^(?:\/|~\/|[A-Za-z]:[\\/])/.test(trimmed)) out.add(cleanText(trimmed, 220));
      for (const match of trimmed.matchAll(/(?:\/Users|\/home|\/tmp|\/var|\/opt|\/workspace)\/[^\s"'`),;]+/g)) {
        out.add(cleanText(match[0], 220));
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (/path|file|dir|cwd|workdir|output|out/i.test(key)) visit(child);
      }
    }
  };
  visit(input);
  return [...out].filter(Boolean);
}

export function recordTaskFrameToolStart(
  frame: TaskFrame,
  toolName: string,
  input: Record<string, unknown>,
  now = Date.now(),
): TaskFrame {
  const next = { ...frame, updatedAt: now, source: 'tool' as const, status: 'active' as const };
  next.currentStep = `Running ${toolName}`;
  next.nextAction = `Review ${toolName} result and continue the task.`;
  next.importantPaths = [...frame.importantPaths];
  for (const path of extractPathCandidates(input)) uniquePush(next.importantPaths, path);
  return next;
}

export function recordTaskFrameToolEnd(
  frame: TaskFrame,
  params: {
    toolName: string;
    input?: Record<string, unknown>;
    result: string;
    isError: boolean;
    aborted?: { by: 'user' | 'timeout' };
    now?: number;
  },
): TaskFrame {
  const now = params.now ?? Date.now();
  const next: TaskFrame = {
    ...frame,
    source: params.isError ? 'error' : 'tool',
    updatedAt: now,
    toolFindings: [...frame.toolFindings],
    importantPaths: [...frame.importantPaths],
    artifacts: [...frame.artifacts],
    completedSteps: [...frame.completedSteps],
    pendingSteps: [...frame.pendingSteps],
  };
  for (const path of extractPathCandidates(params.input)) uniquePush(next.importantPaths, path);
  for (const path of extractPathCandidates(params.result)) uniquePush(next.artifacts, path);
  const summary = cleanText(params.result, MAX_SHORT_TEXT);
  if (summary) {
    next.toolFindings.push({
      toolName: params.toolName,
      summary,
      isError: params.isError,
      at: now,
    });
    if (next.toolFindings.length > MAX_FINDINGS) {
      next.toolFindings = next.toolFindings.slice(-MAX_FINDINGS);
    }
  }

  const hitGuard = /\[dmoss-agent\] Tool loop guard stopped/i.test(params.result);
  if (hitGuard) {
    next.status = 'paused_resumable';
    next.source = 'guard';
    next.lastError = cleanText(params.result);
    next.currentStep = `Paused at ${params.toolName} guard`;
    next.nextAction = `Continue with a different evidence path or resume after the ${params.toolName} guard checkpoint.`;
    uniquePush(next.pendingSteps, next.nextAction);
    return next;
  }

  if (params.aborted?.by === 'user') {
    next.status = 'aborted';
    next.source = 'abort';
    next.lastError = `Tool ${params.toolName} was aborted by user.`;
    next.nextAction = `Resume from before ${params.toolName} if the user asks to continue.`;
    return next;
  }
  if (params.isError) {
    next.status = 'paused_resumable';
    next.lastError = summary || `Tool ${params.toolName} failed.`;
    next.currentStep = `Handle ${params.toolName} failure`;
    next.nextAction = `Resolve or work around the latest ${params.toolName} error, then continue.`;
    uniquePush(next.pendingSteps, next.nextAction);
    return next;
  }

  uniquePush(next.completedSteps, `Ran ${params.toolName}`);
  next.currentStep = `Processed ${params.toolName} result`;
  next.nextAction = `Use the latest ${params.toolName} result to continue.`;
  next.status = 'active';
  return next;
}

export function recordTaskFrameCompaction(
  frame: TaskFrame,
  params: { summaryChars: number; droppedMessages: number; now?: number },
): TaskFrame {
  const next = { ...frame, source: 'compaction' as const, updatedAt: params.now ?? Date.now() };
  uniquePush(
    next.completedSteps,
    `Saved context checkpoint (${params.summaryChars} chars, ${params.droppedMessages} messages folded)`,
  );
  next.nextAction = next.nextAction || 'Continue from the compacted checkpoint.';
  return next;
}

/**
 * Plan closure discipline (aligned with Codex):
 * Before marking a task as completed, reconcile all pending steps.
 * Each unfinished step is either promoted to completed (if the assistant
 * response covers it) or explicitly marked as deferred.
 */
function reconcilePendingSteps(frame: TaskFrame): TaskFrame {
  if (frame.pendingSteps.length === 0) return frame;
  const next = {
    ...frame,
    completedSteps: [...frame.completedSteps],
    pendingSteps: [] as string[],
  };
  for (const step of frame.pendingSteps) {
    const alreadyDone = next.completedSteps.some(
      (cs) => cs.toLowerCase().includes(step.toLowerCase().slice(0, 40)),
    );
    if (alreadyDone) continue;
    uniquePush(next.completedSteps, `Deferred: ${step}`);
  }
  return next;
}

export function recordTaskFrameAssistant(
  frame: TaskFrame,
  text: string,
  stopReason: string,
  now = Date.now(),
): TaskFrame {
  const next = { ...frame, source: 'assistant' as const, updatedAt: now };
  const visible = cleanText(text, MAX_SHORT_TEXT);
  if (visible) uniquePush(next.completedSteps, `Assistant response: ${visible}`);
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
    if (next.status === 'paused_resumable') {
      next.nextAction =
        next.nextAction || 'Continue from the latest resumable checkpoint.';
    } else {
      const reconciled = reconcilePendingSteps(next);
      reconciled.status = 'completed';
      reconciled.currentStep = 'Task response completed';
      reconciled.nextAction = 'No automatic continuation is required unless the user asks for a follow-up.';
      return reconciled;
    }
  }
  return next;
}

export function recordTaskFrameStop(
  frame: TaskFrame,
  params: { reason: 'max_turns' | 'error' | 'abort'; detail?: string; now?: number },
): TaskFrame {
  const now = params.now ?? Date.now();
  const next = { ...frame, updatedAt: now };
  if (params.reason === 'max_turns') {
    next.status = 'paused_resumable';
    next.source = 'max_turns';
    next.lastError = 'Agent reached maximum turns before completing.';
    next.nextAction = 'Resume from the latest saved task state and avoid repeating completed steps.';
    uniquePush(next.pendingSteps, next.nextAction);
    return next;
  }
  if (params.reason === 'abort') {
    next.status = 'aborted';
    next.source = 'abort';
    next.lastError = cleanText(params.detail) || 'Run aborted.';
    next.nextAction = 'Resume from the latest safe checkpoint if the user asks to continue.';
    return next;
  }
  next.status = 'paused_resumable';
  next.source = 'error';
  next.lastError = cleanText(params.detail) || 'Run failed.';
  next.nextAction = 'Resolve the latest error or continue with a fallback path.';
  uniquePush(next.pendingSteps, next.nextAction);
  return next;
}

export function createTaskFrameCheckpointMessage(frame: TaskFrame): LLMMessage {
  const body = JSON.stringify(frame);
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `${CHECKPOINT_START} version="1">\n${body}\n${CHECKPOINT_END}`,
      },
    ],
  };
}

export function buildTaskFrameContext(frame: TaskFrame, intent: ContinuationIntent): string {
  const shouldInject =
    intent.isContinuation || frame.status === 'active' || frame.status === 'paused_resumable' || frame.status === 'error' || frame.status === 'aborted';
  if (!shouldInject) return '';
  const findings = frame.toolFindings
    .slice(-5)
    .map((f) => `- ${f.toolName}${f.isError ? ' (error)' : ''}: ${f.summary}`)
    .join('\n');
  return [
    '<dmoss_working_context>',
    'This is temporary working context for the current thread. Use it before cross-session archive search when the user asks to continue, resume, or refer to the just-finished work. Do not save it as long-term memory.',
    `Continuation intent: ${intent.isContinuation ? 'yes' : 'no'}`,
    `Status: ${frame.status}`,
    `Goal: ${frame.goal}`,
    `Current step: ${frame.currentStep}`,
    `Next action: ${frame.nextAction}`,
    frame.lastError ? `Last error: ${frame.lastError}` : '',
    frame.completedSteps.length ? `Completed steps:\n${frame.completedSteps.map((s) => `- ${s}`).join('\n')}` : '',
    frame.pendingSteps.length ? `Pending steps:\n${frame.pendingSteps.map((s) => `- ${s}`).join('\n')}` : '',
    frame.importantPaths.length ? `Important paths:\n${frame.importantPaths.map((s) => `- ${s}`).join('\n')}` : '',
    frame.artifacts.length ? `Artifacts:\n${frame.artifacts.map((s) => `- ${s}`).join('\n')}` : '',
    findings ? `Recent tool findings:\n${findings}` : '',
    '</dmoss_working_context>',
  ]
    .filter(Boolean)
    .join('\n');
}

export function stripTaskFrameCheckpointsFromLlmMessages(messages: LLMMessage[]): LLMMessage[] {
  return messages.filter((message) => !isTaskFrameCheckpointMessage(message));
}
