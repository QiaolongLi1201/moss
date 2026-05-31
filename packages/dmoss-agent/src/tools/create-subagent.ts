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
import type { MossAsyncTaskStartRequest } from '@rdk-moss/core/contracts/async-task';
import type { Tool, ToolContext } from '../core/tools/tool-types.js';

interface CreateSubagentInput {
  task: string;
  scope?: 'read-only' | 'device-read' | 'full' | 'explore' | 'plan' | 'verify';
  maxTurns?: number;
  background?: boolean;
}

interface SubagentStatusInput {
  taskId: string;
  wait?: boolean;
}

export const createSubagentTool: Tool<CreateSubagentInput> = {
  name: 'create_subagent',
  description: [
    'Spawn a sub-agent to perform a task independently.',
    'Sub-agents have their own tool scope and context window.',
    'Use for parallel exploration, planning, or verification tasks.',
    '',
    'Scopes: "explore" (read-only), "plan" (read + plan), "verify" (read + exec for testing), "full" (all tools).',
  ].join(' '),
  metadata: {
    sideEffectClass: 'subagent',
    planMode: 'allow',
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
      const handle = ctx.asyncTaskRegistry.start(
        {
          taskId,
          kind: 'subagent',
          label: input.task.slice(0, 80),
          parentRunId: ctx.runId,
          timeoutMs: 120_000,
          payload: {
            task: input.task,
            scope,
            maxTurns,
          },
        },
        async (_request: MossAsyncTaskStartRequest, signal: AbortSignal) => {
          const result = await ctx.spawnSubagent?.({
            task: input.task,
            scope,
            maxTurns,
            abortSignal: signal,
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
    });
    const status = result.success ? 'SUCCESS' : 'FAILED';
    const summary = result.summary || '(no output)';
    return `[Sub-agent ${result.runId.slice(0, 8)}] ${status}\n\n${summary}`;
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
        '',
        summary,
      ].join('\n');
    }

    return [
      `[Sub-agent task ${taskId}] ${snapshot.status.toUpperCase()}`,
      `kind: ${snapshot.kind}`,
      ...(snapshot.label ? [`label: ${snapshot.label}`] : []),
      ...(snapshot.startedAt ? [`startedAt: ${snapshot.startedAt}`] : []),
      `updatedAt: ${snapshot.updatedAt}`,
    ].join('\n');
  },
};
