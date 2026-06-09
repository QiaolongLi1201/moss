/**
 * create_subagent tool — spawns a child agent to perform a task.
 *
 * Delegates execution to `ctx.spawnSubagent`, which is injected by
 * `DmossAgent.streamChatViaAgentLoop`. By default the tool waits for the child
 * to complete and returns its summary as the tool result. Hosts can provide
 * `ctx.asyncTaskRegistry` and callers can pass `background: true` to start the
 * same child through the async task contract and return a stable handle
 * immediately.
 */

import { randomUUID } from 'node:crypto';
import type { MossAsyncTaskSnapshot, MossAsyncTaskStartRequest } from '@rdk-moss/core/contracts/async-task';
import type { SubagentRunProgress, Tool, ToolContext } from '../core/tools/tool-types.js';

interface CreateSubagentInput {
  task: string;
  scope?: 'read-only' | 'device-read' | 'full' | 'explore' | 'plan' | 'verify';
  maxTurns?: number;
  timeoutMs?: number;
  background?: boolean;
}

interface SubagentStatusInput {
  taskId: string;
  wait?: boolean;
}

interface SubagentStopInput {
  taskId: string;
}

const DEFAULT_SUBAGENT_TIMEOUT_MS = 120_000;
const DEFAULT_FAN_OUT_MAX_TURNS = 4;
const MIN_SUBAGENT_TIMEOUT_MS = 100;
const MAX_SUBAGENT_TIMEOUT_MS = 30 * 60_000;
const TERMINAL_SUBAGENT_TASK_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);

function completionMetricLines(data: unknown): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const record = data as Record<string, unknown>;
  return [
    typeof record.runId === 'string' ? `runId: ${record.runId}` : '',
    typeof record.turns === 'number' ? `turns: ${record.turns}` : '',
    typeof record.toolResults === 'number' ? `toolResults: ${record.toolResults}` : '',
  ].filter(Boolean);
}

function snapshotProgressLines(snapshot: MossAsyncTaskSnapshot | undefined): string[] {
  if (!snapshot?.progress) return [];
  const progress = snapshot.progress;
  const parts = [
    progress.phase ? `phase: ${progress.phase}` : '',
    progress.currentTurn ? `turn: ${progress.currentTurn}${progress.maxTurns ? `/${progress.maxTurns}` : ''}` : '',
    progress.toolCalls !== undefined ? `toolCalls: ${progress.toolCalls}` : '',
    progress.lastTool ? `lastTool: ${progress.lastTool}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? [`progress: ${parts.join(' · ')}`] : [];
}

function resolveSubagentTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return DEFAULT_SUBAGENT_TIMEOUT_MS;
  }
  return Math.min(
    MAX_SUBAGENT_TIMEOUT_MS,
    Math.max(MIN_SUBAGENT_TIMEOUT_MS, Math.floor(timeoutMs)),
  );
}

export const createSubagentTool: Tool<CreateSubagentInput> = {
  name: 'create_subagent',
  description: [
    'Spawn a sub-agent to perform a task independently.',
    'Sub-agents have their own tool scope and context window.',
    'Use for parallel exploration, planning, or verification tasks.',
    'Do not use for quick usage/config/help questions, short-answer requests, or simple read-only summaries.',
    '',
    'Scopes: "explore" (read-only), "plan" (read + plan), "verify" (read + exec for testing), "full" (all tools).',
  ].join(' '),
  metadata: {
    sideEffectClass: 'subagent',
    planMode: 'allow',
    requiresApproval: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'Task description for the sub-agent',
      },
      scope: {
        type: 'string',
        enum: ['read-only', 'device-read', 'full', 'explore', 'plan', 'verify'],
        description: 'Tool scope for the sub-agent (default: full)',
      },
      maxTurns: {
        type: 'number',
        description: 'Maximum turns the sub-agent may execute (default: 10)',
      },
      timeoutMs: {
        type: 'number',
        minimum: MIN_SUBAGENT_TIMEOUT_MS,
        maximum: MAX_SUBAGENT_TIMEOUT_MS,
        description: 'Maximum runtime for the sub-agent in milliseconds (default: 120000, max: 1800000)',
      },
      background: {
        type: 'boolean',
        description: 'Return immediately with a task handle instead of waiting for the sub-agent to finish',
      },
    },
    required: ['task'],
  },

  async execute(input: CreateSubagentInput, ctx: ToolContext): Promise<string> {
    if (!ctx.spawnSubagent) {
      return 'Error: sub-agent spawning is not available in this context.';
    }
    if (
      ctx.maxSpawnDepth !== undefined &&
      ctx.currentSpawnDepth !== undefined &&
      ctx.currentSpawnDepth >= ctx.maxSpawnDepth
    ) {
      return `Error: maximum spawn depth (${ctx.maxSpawnDepth}) reached; cannot spawn nested sub-agents.`;
    }

    if (input.background) {
      if (!ctx.asyncTaskRegistry) {
        return 'Error: background sub-agent tasks are not available in this context.';
      }
      const taskId = `${ctx.runId ?? ctx.sessionKey}/sub-${randomUUID().slice(0, 8)}`;
      const scope = input.scope ?? 'full';
      const maxTurns = input.maxTurns ?? 10;
      const timeoutMs = resolveSubagentTimeoutMs(input.timeoutMs);
      const updateProgress = (progress: SubagentRunProgress) => {
        ctx.asyncTaskRegistry?.update(taskId, {
          progress: {
            phase: progress.phase ?? progress.status,
            message: progress.status,
            ...(progress.turn !== undefined ? { currentTurn: progress.turn } : {}),
            ...(progress.maxTurns !== undefined ? { maxTurns: progress.maxTurns } : {}),
            ...(progress.toolResults !== undefined ? { toolCalls: progress.toolResults } : {}),
            ...(progress.lastTool ? { lastTool: progress.lastTool } : {}),
            ...(progress.error ? { lastError: progress.error } : {}),
            ...(progress.summaryPreview ? { summaryPreview: progress.summaryPreview } : {}),
            details: {
              runId: progress.runId,
              scope: progress.scope,
              elapsedMs: progress.elapsedMs,
            },
          },
          ...(progress.error ? { error: progress.error } : {}),
        });
      };
      const handle = ctx.asyncTaskRegistry.start(
        {
          taskId,
          kind: 'subagent',
          label: input.task.slice(0, 80),
          parentRunId: ctx.runId,
          timeoutMs,
          payload: {
            task: input.task,
            scope,
            maxTurns,
            timeoutMs,
          },
        },
        async (_request: MossAsyncTaskStartRequest, signal: AbortSignal) => {
          const result = await ctx.spawnSubagent?.({
            task: input.task,
            scope,
            maxTurns,
            timeoutMs,
            abortSignal: signal,
            onProgress: updateProgress,
          });
          if (!result) {
            return {
              success: false,
              summary: 'Sub-agent spawning is no longer available.',
            };
          }
          return {
            success: result.success,
            summary: result.summary || (result.success ? '(no output)' : 'Sub-agent failed.'),
            data: {
              runId: result.runId,
              sessionKey: result.sessionKey,
              ...(result.turns !== undefined ? { turns: result.turns } : {}),
              ...(result.toolResults !== undefined ? { toolResults: result.toolResults } : {}),
              ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
              ...(result.error ? { error: result.error } : {}),
            },
          };
        },
        { parentSignal: ctx.abortSignal },
      );
      return [
        `[Sub-agent task ${handle.taskId}] STARTED`,
        '',
        'The sub-agent is running in the background. Its final summary will be available through the host async task registry.',
      ].join('\n');
    }

    const result = await ctx.spawnSubagent({
      task: input.task,
      scope: input.scope ?? 'full',
      maxTurns: input.maxTurns ?? 10,
      timeoutMs: resolveSubagentTimeoutMs(input.timeoutMs),
    });
    const status = result.success ? 'SUCCESS' : 'FAILED';
    const summary = result.summary || '(no output)';
    return `[Sub-agent ${result.runId.slice(0, 8)}] ${status}\n\n${summary}`;
  },
};

interface FanOutTaskInput {
  task: string;
  scope?: 'read-only' | 'device-read' | 'full' | 'explore' | 'plan' | 'verify';
  label?: string;
}

interface FanOutSubagentsInput {
  tasks: FanOutTaskInput[];
  maxTurns?: number;
  timeoutMs?: number;
}

const MAX_FAN_OUT_TASKS = 6;

/**
 * fan_out_subagents — run 2..MAX_FAN_OUT_TASKS sub-agents CONCURRENTLY over independent tasks,
 * then aggregate their summaries. This is the multi-agent fan-out primitive (ultra-review /
 * ultra-plan build on it): one approval-gated tool call whose children run in parallel.
 *
 * Safety: the agent loop runs this single `subagent`-class call serially & approval-gated like
 * any spawn; the *concurrency* lives inside, across children that are fully isolated (each child
 * gets its own runId / sessionKey / scratch dir via the subagent runner), so parallel execution
 * is race-safe. Children default to read-only (`explore`) scope.
 */
export const fanOutSubagentsTool: Tool<FanOutSubagentsInput> = {
  name: 'fan_out_subagents',
  description: [
    'Run 2-6 sub-agents CONCURRENTLY over independent tasks, then return all their summaries aggregated.',
    'Use for breadth + speed when independent facets can be tackled in parallel — e.g. multi-angle code review',
    '(correctness / security / perf), multi-source exploration, or cross-checking a finding. Each child is',
    'isolated and read-only by default. For a single task, use create_subagent instead.',
    'Do not use for quick usage/config/help questions, "answer in N lines" requests, or simple UX impressions;',
    'answer directly or do at most one targeted file read in those cases.',
  ].join(' '),
  metadata: {
    sideEffectClass: 'subagent',
    planMode: 'allow',
    requiresApproval: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        minItems: 2,
        maxItems: MAX_FAN_OUT_TASKS,
        description: `2-${MAX_FAN_OUT_TASKS} independent tasks to run concurrently.`,
        items: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Task / system prompt for this sub-agent' },
            scope: {
              type: 'string',
              enum: ['read-only', 'device-read', 'full', 'explore', 'plan', 'verify'],
              description: 'Tool scope for this sub-agent (default: explore, read-only)',
            },
            label: { type: 'string', description: 'Short angle label, e.g. "correctness" / "security"' },
          },
          required: ['task'],
        },
      },
      maxTurns: { type: 'number', description: `Max turns per sub-agent (default: ${DEFAULT_FAN_OUT_MAX_TURNS}; keep shallow unless the user explicitly asks for deep multi-agent research)` },
      timeoutMs: {
        type: 'number',
        minimum: MIN_SUBAGENT_TIMEOUT_MS,
        maximum: MAX_SUBAGENT_TIMEOUT_MS,
        description: 'Max runtime per sub-agent in ms (default: 120000, max: 1800000)',
      },
    },
    required: ['tasks'],
  },

  async execute(input: FanOutSubagentsInput, ctx: ToolContext): Promise<string> {
    if (!ctx.spawnSubagent) {
      return 'Error: sub-agent spawning is not available in this context.';
    }
    if (
      ctx.maxSpawnDepth !== undefined &&
      ctx.currentSpawnDepth !== undefined &&
      ctx.currentSpawnDepth >= ctx.maxSpawnDepth
    ) {
      return `Error: maximum spawn depth (${ctx.maxSpawnDepth}) reached; cannot spawn nested sub-agents.`;
    }

    const tasks = (Array.isArray(input.tasks) ? input.tasks : [])
      .filter((t) => t && typeof t.task === 'string' && t.task.trim())
      .slice(0, MAX_FAN_OUT_TASKS);
    if (tasks.length < 2) {
      return 'Error: fan_out_subagents needs at least 2 tasks; use create_subagent for a single task.';
    }

    const maxTurns = input.maxTurns ?? DEFAULT_FAN_OUT_MAX_TURNS;
    const timeoutMs = resolveSubagentTimeoutMs(input.timeoutMs);
    const labelFor = (i: number) => String(tasks[i].label ?? `task ${i + 1}`).slice(0, 40);

    const settled = await Promise.allSettled(
      tasks.map((t) =>
        ctx.spawnSubagent!({
          task: t.task,
          scope: t.scope ?? 'explore',
          maxTurns,
          timeoutMs,
          abortSignal: ctx.abortSignal,
        }),
      ),
    );

    let ok = 0;
    let fail = 0;
    const sections: string[] = [];
    settled.forEach((s, i) => {
      const label = labelFor(i);
      if (s.status === 'fulfilled' && s.value) {
        const r = s.value;
        if (r.success) ok++;
        else fail++;
        const id = String(r.runId ?? '').slice(0, 8);
        sections.push(
          `### [${label}] ${r.success ? 'SUCCESS' : 'FAILED'}${id ? ` (sub-agent ${id})` : ''}\n${r.summary || '(no output)'}`,
        );
      } else {
        fail++;
        const reason = s.status === 'rejected' ? String(s.reason) : 'sub-agent spawning unavailable';
        sections.push(`### [${label}] ERROR\n${reason}`);
      }
    });

    return [
      `[fan_out_subagents] ${tasks.length} sub-agents ran concurrently — ${ok} ok, ${fail} failed.`,
      '',
      sections.join('\n\n'),
    ].join('\n');
  },
};

export const subagentStatusTool: Tool<SubagentStatusInput> = {
  name: 'subagent_status',
  description: [
    'Check or wait for a background sub-agent task started by create_subagent with background=true.',
    'Use wait=false for a non-blocking status snapshot, or wait=true when you need the final completion summary.',
  ].join(' '),
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'Task id returned by create_subagent background mode',
      },
      wait: {
        type: 'boolean',
        description: 'When true, wait until the background task reaches a terminal state',
      },
    },
    required: ['taskId'],
  },

  async execute(input: SubagentStatusInput, ctx: ToolContext): Promise<string> {
    if (!ctx.asyncTaskRegistry) {
      return 'Error: background sub-agent tasks are not available in this context.';
    }

    const taskId = String(input.taskId ?? '').trim();
    if (!taskId) return 'Error: taskId is required.';

    const snapshot = ctx.asyncTaskRegistry.status(taskId);
    if (!snapshot) return `Error: background sub-agent task not found: ${taskId}`;

    const completion = input.wait
      ? await ctx.asyncTaskRegistry.wait(taskId)
      : ctx.asyncTaskRegistry.readCompletion(taskId);

    if (completion) {
      const status = completion.success ? 'SUCCESS' : completion.status.toUpperCase();
      const summary = completion.summary || completion.error || '(no output)';
      return [
        `[Sub-agent task ${taskId}] ${status}`,
        `status: ${completion.status}`,
        `durationMs: ${completion.durationMs}`,
        ...completionMetricLines(completion.data),
        '',
        summary,
      ].join('\n');
    }

    return [
      `[Sub-agent task ${taskId}] ${snapshot.status.toUpperCase()}`,
      `kind: ${snapshot.kind}`,
      ...(snapshot.label ? [`label: ${snapshot.label}`] : []),
      ...(snapshot.startedAt ? [`startedAt: ${snapshot.startedAt}`] : []),
      ...snapshotProgressLines(snapshot),
      `updatedAt: ${snapshot.updatedAt}`,
    ].join('\n');
  },
};

export const subagentStopTool: Tool<SubagentStopInput> = {
  name: 'subagent_stop',
  description: [
    'Stop a background sub-agent task started by create_subagent with background=true.',
    'Use when a long-running sub-agent is no longer useful or should yield control back to the parent task.',
  ].join(' '),
  metadata: {
    sideEffectClass: 'subagent',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'Task id returned by create_subagent background mode',
      },
    },
    required: ['taskId'],
  },

  async execute(input: SubagentStopInput, ctx: ToolContext): Promise<string> {
    if (!ctx.asyncTaskRegistry) {
      return 'Error: background sub-agent tasks are not available in this context.';
    }

    const taskId = String(input.taskId ?? '').trim();
    if (!taskId) return 'Error: taskId is required.';

    const snapshot = ctx.asyncTaskRegistry.status(taskId);
    if (!snapshot) return `Error: background sub-agent task not found: ${taskId}`;

    if (TERMINAL_SUBAGENT_TASK_STATUSES.has(snapshot.status)) {
      const completion = ctx.asyncTaskRegistry.readCompletion(taskId);
      return [
        `[Sub-agent task ${taskId}] ALREADY ${snapshot.status.toUpperCase()}`,
        `status: ${snapshot.status}`,
        ...(completion ? ['', completion.summary || completion.error || '(no output)'] : []),
      ].join('\n');
    }

    ctx.asyncTaskRegistry.stop(taskId, 'user_cancelled');
    const completion = ctx.asyncTaskRegistry.readCompletion(taskId);
    if (completion) {
      return [
        `[Sub-agent task ${taskId}] STOPPED`,
        `status: ${completion.status}`,
        '',
        completion.summary || completion.error || 'Task cancelled.',
      ].join('\n');
    }

    return [
      `[Sub-agent task ${taskId}] STOP REQUESTED`,
      `previousStatus: ${snapshot.status}`,
    ].join('\n');
  },
};
