import type { GoalState } from './goal-state.js';

export type GoalCommandAction =
  | 'status'
  | 'set'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'block'
  | 'clear';

export type GoalCommandEvent =
  | 'goal_status'
  | 'goal_set'
  | 'goal_paused'
  | 'goal_resumed'
  | 'goal_completed'
  | 'goal_blocked'
  | 'goal_cleared';

export interface ParsedGoalCommand {
  handled: boolean;
  action?: GoalCommandAction;
  objective?: string;
  reason?: string;
  error?: string;
}

export interface GoalCommandResult {
  handled: boolean;
  action?: GoalCommandAction;
  event?: GoalCommandEvent;
  goal?: GoalState;
  replaced?: boolean;
  message: string;
  error?: string;
}

export interface GoalCommandAgent {
  getGoal(sessionKey: string): Promise<GoalState | undefined>;
  setGoal(sessionKey: string, objective: string): Promise<GoalState>;
  pauseGoal(sessionKey: string, reason?: string): Promise<GoalState | undefined>;
  resumeGoal(sessionKey: string): Promise<GoalState | undefined>;
  completeGoal(sessionKey: string, reason?: string): Promise<GoalState | undefined>;
  blockGoal(sessionKey: string, reason?: string): Promise<GoalState | undefined>;
  clearGoal(sessionKey: string): Promise<void>;
}

export interface GoalCommandOptions {
  locale?: string;
}

export interface HandleGoalCommandParams extends GoalCommandOptions {
  agent: GoalCommandAgent;
  sessionKey: string;
  input: string;
}

const GOAL_COMMAND_RE = /^\/goal(?::|：|\s|$)/i;
const EMPTY_MESSAGE = '';

function startsWithZh(locale?: string): boolean {
  return Boolean(locale && locale.toLowerCase().startsWith('zh'));
}

function eventForAction(action?: GoalCommandAction): GoalCommandEvent | undefined {
  switch (action) {
    case 'status':
      return 'goal_status';
    case 'set':
      return 'goal_set';
    case 'pause':
      return 'goal_paused';
    case 'resume':
      return 'goal_resumed';
    case 'complete':
      return 'goal_completed';
    case 'block':
      return 'goal_blocked';
    case 'clear':
      return 'goal_cleared';
    default:
      return undefined;
  }
}

function goalStatusLabel(goal: GoalState, locale?: string): string {
  if (!startsWithZh(locale)) return goal.status;
  switch (goal.status) {
    case 'active':
      return '进行中';
    case 'paused':
      return '已暂停';
    case 'completed':
      return '已完成';
    case 'blocked':
      return '已阻塞';
    default:
      return goal.status;
  }
}

function statusMessage(goal: GoalState | undefined, locale?: string): string {
  if (!goal) {
    return startsWithZh(locale) ? '当前会话没有设置目标。' : 'No goal is set for this session.';
  }
  const reason = goal.statusReason
    ? startsWithZh(locale)
      ? ` 原因：${goal.statusReason}`
      : ` Reason: ${goal.statusReason}`
    : '';
  if (startsWithZh(locale)) {
    return `当前目标（${goalStatusLabel(goal, locale)}）：${goal.objective}${reason}`;
  }
  return `Current goal (${goalStatusLabel(goal, locale)}): ${goal.objective}${reason}`;
}

function actionMessage(
  action: GoalCommandAction,
  goal: GoalState | undefined,
  locale?: string,
  extra?: { replaced?: boolean; reason?: string },
): string {
  const zh = startsWithZh(locale);
  switch (action) {
    case 'set':
      if (zh) return extra?.replaced ? `已替换目标：${goal?.objective ?? ''}` : `已设置目标：${goal?.objective ?? ''}`;
      return extra?.replaced ? `Goal replaced: ${goal?.objective ?? ''}` : `Goal set: ${goal?.objective ?? ''}`;
    case 'pause':
      if (zh) return `目标已暂停：${goal?.objective ?? ''}`;
      return `Goal paused: ${goal?.objective ?? ''}`;
    case 'resume':
      if (zh) return `目标已恢复：${goal?.objective ?? ''}`;
      return `Goal resumed: ${goal?.objective ?? ''}`;
    case 'complete':
      if (zh) return `目标已完成：${goal?.objective ?? ''}`;
      return `Goal completed: ${goal?.objective ?? ''}`;
    case 'block':
      if (zh) return `目标已标记为阻塞：${goal?.objective ?? ''}`;
      return `Goal blocked: ${goal?.objective ?? ''}`;
    case 'clear':
      if (zh) return '目标已清除。';
      return 'Goal cleared.';
    case 'status':
      return statusMessage(goal, locale);
  }
}

function errorMessage(error: string, locale?: string): string {
  if (!startsWithZh(locale)) return error;
  switch (error) {
    case 'Goal objective must not be empty.':
      return '目标不能为空。';
    case 'No goal is set for this session.':
      return '当前会话没有设置目标。';
    default:
      return error;
  }
}

function parseNoArgAction(action: GoalCommandAction, tail: string): ParsedGoalCommand {
  if (tail) {
    return {
      handled: true,
      action,
      error: `/goal ${action} does not accept arguments.`,
    };
  }
  return { handled: true, action };
}

export function isGoalCommand(input: string): boolean {
  return GOAL_COMMAND_RE.test(String(input ?? '').trimStart());
}

export function parseGoalCommand(input: string): ParsedGoalCommand {
  const trimmed = String(input ?? '').trim();
  if (!isGoalCommand(trimmed)) return { handled: false };

  const rest = trimmed.replace(/^\/goal(?::|：)?/i, '').trim();
  if (!rest) return { handled: true, action: 'status' };

  const [rawAction = '', ...parts] = rest.split(/\s+/);
  const action = rawAction.toLowerCase();
  const tail = parts.join(' ').trim();

  switch (action) {
    case 'status':
      return parseNoArgAction('status', tail);
    case 'set':
      if (!tail) {
        return {
          handled: true,
          action: 'set',
          error: 'Goal objective must not be empty.',
        };
      }
      return { handled: true, action: 'set', objective: tail };
    case 'pause':
      return { handled: true, action: 'pause', reason: tail || undefined };
    case 'resume':
      return parseNoArgAction('resume', tail);
    case 'complete':
      return { handled: true, action: 'complete', reason: tail || undefined };
    case 'block':
      return { handled: true, action: 'block', reason: tail || undefined };
    case 'clear':
      return parseNoArgAction('clear', tail);
    default:
      return { handled: true, action: 'set', objective: rest };
  }
}

export function formatGoalCommandResult(result: GoalCommandResult, locale?: string): string {
  if (!result.handled) return EMPTY_MESSAGE;
  if (result.error) return errorMessage(result.error, locale);
  if (!result.action) return result.message;
  if (result.action === 'status') return statusMessage(result.goal, locale);
  return actionMessage(result.action, result.goal, locale, { replaced: result.replaced });
}

export async function executeGoalCommand(
  agent: GoalCommandAgent,
  sessionKey: string,
  parsedCommand: ParsedGoalCommand,
  options?: GoalCommandOptions,
): Promise<GoalCommandResult> {
  const locale = options?.locale;
  if (!parsedCommand.handled) {
    return { handled: false, message: EMPTY_MESSAGE };
  }

  if (parsedCommand.error) {
    return {
      handled: true,
      action: parsedCommand.action,
      event: eventForAction(parsedCommand.action),
      message: errorMessage(parsedCommand.error, locale),
      error: parsedCommand.error,
    };
  }

  const action = parsedCommand.action;
  if (!action) {
    const error = 'Goal command action is missing.';
    return { handled: true, message: errorMessage(error, locale), error };
  }

  try {
    if (action === 'status') {
      const goal = await agent.getGoal(sessionKey);
      const result: GoalCommandResult = {
        handled: true,
        action,
        event: eventForAction(action),
        goal,
        message: statusMessage(goal, locale),
      };
      return result;
    }

    if (action === 'set') {
      const existing = await agent.getGoal(sessionKey);
      const goal = await agent.setGoal(sessionKey, parsedCommand.objective ?? '');
      return {
        handled: true,
        action,
        event: eventForAction(action),
        goal,
        replaced: Boolean(existing),
        message: actionMessage(action, goal, locale, { replaced: Boolean(existing) }),
      };
    }

    if (action === 'clear') {
      await agent.clearGoal(sessionKey);
      return {
        handled: true,
        action,
        event: eventForAction(action),
        message: actionMessage(action, undefined, locale),
      };
    }

    const goal = await executeTransition(agent, sessionKey, action, parsedCommand.reason);
    if (!goal) {
      const error = 'No goal is set for this session.';
      return {
        handled: true,
        action,
        event: eventForAction(action),
        message: errorMessage(error, locale),
        error,
      };
    }

    return {
      handled: true,
      action,
      event: eventForAction(action),
      goal,
      message: actionMessage(action, goal, locale, { reason: parsedCommand.reason }),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      handled: true,
      action,
      event: eventForAction(action),
      message: errorMessage(error, locale),
      error,
    };
  }
}

async function executeTransition(
  agent: GoalCommandAgent,
  sessionKey: string,
  action: Exclude<GoalCommandAction, 'status' | 'set' | 'clear'>,
  reason?: string,
): Promise<GoalState | undefined> {
  switch (action) {
    case 'pause':
      return agent.pauseGoal(sessionKey, reason);
    case 'resume':
      return agent.resumeGoal(sessionKey);
    case 'complete':
      return agent.completeGoal(sessionKey, reason);
    case 'block':
      return agent.blockGoal(sessionKey, reason);
  }
}

export async function handleGoalCommand(params: HandleGoalCommandParams): Promise<GoalCommandResult> {
  const parsed = parseGoalCommand(params.input);
  return executeGoalCommand(params.agent, params.sessionKey, parsed, { locale: params.locale });
}
