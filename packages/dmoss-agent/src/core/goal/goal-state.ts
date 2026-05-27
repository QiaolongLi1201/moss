import type { LLMMessage } from '../llm/llm-provider.js';
import type { Message } from '../session/session-jsonl.js';

export type GoalStatus = 'active' | 'paused' | 'completed' | 'blocked';

export interface GoalState {
  sessionKey: string;
  objective: string;
  status: GoalStatus;
  statusReason?: string;
  createdAt: number;
  updatedAt: number;
  pausedAt?: number;
  completedAt?: number;
  blockedAt?: number;
}

export interface GoalCheckpointSplit<T extends Message | LLMMessage = Message | LLMMessage> {
  goal?: GoalState;
  messages: T[];
}

const CHECKPOINT_START = '<dmoss_goal_checkpoint';
const CHECKPOINT_END = '</dmoss_goal_checkpoint>';
const MAX_OBJECTIVE_CHARS = 1000;
const MAX_REASON_CHARS = 500;

function cleanText(value: unknown, max: number): string {
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeObjective(value: unknown): string {
  const objective = String(value ?? '').trim();
  if (!objective) {
    throw new Error('Goal objective must not be empty.');
  }
  if (objective.length > MAX_OBJECTIVE_CHARS) {
    throw new Error(`Goal objective must be ${MAX_OBJECTIVE_CHARS} characters or less.`);
  }
  return objective;
}

function normalizeStatus(value: unknown): GoalStatus | undefined {
  if (value === 'active' || value === 'paused' || value === 'completed' || value === 'blocked') {
    return value;
  }
  return undefined;
}

function optionalReason(value: unknown): string | undefined {
  const reason = cleanText(value, MAX_REASON_CHARS);
  return reason || undefined;
}

function finiteTime(value: unknown, fallback: number): number {
  const time = Number(value);
  return Number.isFinite(time) ? time : fallback;
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

function normalizeGoalState(raw: unknown): GoalState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const sessionKey = cleanText(obj.sessionKey, 160);
  if (!sessionKey) return undefined;
  let objective: string;
  try {
    objective = normalizeObjective(obj.objective);
  } catch {
    return undefined;
  }
  const status = normalizeStatus(obj.status) ?? 'active';
  const now = Date.now();
  const createdAt = finiteTime(obj.createdAt, now);
  const updatedAt = finiteTime(obj.updatedAt, createdAt);
  return {
    sessionKey,
    objective,
    status,
    statusReason: optionalReason(obj.statusReason),
    createdAt,
    updatedAt,
    pausedAt: obj.pausedAt === undefined ? undefined : finiteTime(obj.pausedAt, updatedAt),
    completedAt: obj.completedAt === undefined ? undefined : finiteTime(obj.completedAt, updatedAt),
    blockedAt: obj.blockedAt === undefined ? undefined : finiteTime(obj.blockedAt, updatedAt),
  };
}

function parseCheckpoint(text: string): GoalState | undefined {
  const start = text.indexOf(CHECKPOINT_START);
  if (start < 0) return undefined;
  const openEnd = text.indexOf('>', start);
  const end = text.indexOf(CHECKPOINT_END, openEnd + 1);
  if (openEnd < 0 || end < 0) return undefined;
  const rawJson = text.slice(openEnd + 1, end).trim();
  try {
    return normalizeGoalState(JSON.parse(rawJson));
  } catch {
    return undefined;
  }
}

export function createGoalState(params: {
  sessionKey: string;
  objective: string;
  now?: number;
}): GoalState {
  const now = params.now ?? Date.now();
  return {
    sessionKey: params.sessionKey,
    objective: normalizeObjective(params.objective),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

export function updateGoalState(
  goal: GoalState,
  params: { status: GoalStatus; statusReason?: string; now?: number },
): GoalState {
  const now = params.now ?? Date.now();
  const statusReason = optionalReason(params.statusReason);
  const next: GoalState = {
    ...goal,
    status: params.status,
    updatedAt: now,
    statusReason,
    pausedAt: undefined,
    completedAt: undefined,
    blockedAt: undefined,
  };

  if (params.status === 'paused') {
    return { ...next, pausedAt: now };
  }
  if (params.status === 'completed') {
    return { ...next, completedAt: now };
  }
  if (params.status === 'blocked') {
    return { ...next, blockedAt: now };
  }
  return { ...next, statusReason: undefined };
}

export function createGoalCheckpointMessage(goal: GoalState): LLMMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `${CHECKPOINT_START} version="1">\n${JSON.stringify(goal)}\n${CHECKPOINT_END}`,
      },
    ],
  };
}

export function isGoalCheckpointMessage(message: Message | LLMMessage): boolean {
  const text = extractTextContent(message);
  return text.includes(CHECKPOINT_START) && text.includes(CHECKPOINT_END);
}

export function splitGoalCheckpointMessages<T extends Message | LLMMessage>(
  messages: T[],
): GoalCheckpointSplit<T> {
  let goal: GoalState | undefined;
  const kept: T[] = [];
  for (const message of messages) {
    if (isGoalCheckpointMessage(message)) {
      goal = parseCheckpoint(extractTextContent(message)) ?? goal;
      continue;
    }
    kept.push(message);
  }
  return { goal, messages: kept };
}

export function stripGoalCheckpointsFromLlmMessages<T extends Message | LLMMessage>(messages: T[]): T[] {
  return messages.filter((message) => !isGoalCheckpointMessage(message));
}

export function buildGoalModeContext(goal: GoalState): string {
  if (goal.status !== 'active' && goal.status !== 'paused') return '';
  return [
    '<dmoss_goal_mode>',
    'The user has set a persistent goal for this thread. Keep responses and tool work aligned with it unless the user changes or clears the goal.',
    `Status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    goal.statusReason ? `Status reason: ${goal.statusReason}` : '',
    goal.status === 'paused'
      ? 'Goal mode is paused. Do not proactively continue the goal until the user resumes it or asks for related help.'
      : '',
    '</dmoss_goal_mode>',
  ]
    .filter(Boolean)
    .join('\n');
}
