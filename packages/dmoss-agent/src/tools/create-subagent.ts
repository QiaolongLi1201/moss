/**
 * create_subagent tool — spawns a child agent to perform a task.
 *
 * Delegates execution to `ctx.spawnSubagent`, which is injected by
 * `DmossAgent.streamChatViaAgentLoop`. The tool waits for the child
 * to complete and returns its summary as the tool result.
 *
 * Supported modes:
 * - single: one child agent (default)
 * - fan-out: parallel dispatch via `runFanOut` (future)
 * - pipeline: sequential chain via `runPipeline` (future)
 *
 * Current implementation supports single mode; fan-out/pipeline
 * are declared in the schema for forward compatibility.
 */

import type { Tool, ToolContext } from '../core/tools/tool-types.js';

interface CreateSubagentInput {
  task: string;
  mode?: 'single' | 'fan-out' | 'pipeline';
  scope?: 'read-only' | 'device-read' | 'full' | 'explore' | 'plan' | 'verify';
  maxTurns?: number;
  tasks?: Array<{ task: string; scope?: string }>;
}

export const createSubagentTool: Tool<CreateSubagentInput> = {
  name: 'create_subagent',
  description: [
    'Spawn a sub-agent to perform a task independently.',
    'Sub-agents have their own tool scope and context window.',
    'Use for parallel exploration, planning, or verification tasks.',
    '',
    'Modes: "single" (one agent, default), "fan-out" (parallel), "pipeline" (sequential).',
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
      mode: {
        type: 'string',
        enum: ['single', 'fan-out', 'pipeline'],
        description: 'Execution mode (default: single)',
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
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            task: { type: 'string' },
            scope: { type: 'string' },
          },
          required: ['task'],
        },
        description: 'For fan-out/pipeline mode: list of sub-tasks to dispatch',
      },
    },
    required: ['task'],
  },

  async execute(input: CreateSubagentInput, ctx: ToolContext): Promise<string> {
    if (!ctx.spawnSubagent) {
      return 'Error: sub-agent spawning is not available in this context.';
    }

    const mode = input.mode ?? 'single';

    if (mode === 'single') {
      const result = await ctx.spawnSubagent({
        task: input.task,
        scope: input.scope ?? 'full',
        maxTurns: input.maxTurns ?? 10,
      });
      const status = result.success ? 'SUCCESS' : 'FAILED';
      const summary = result.summary || '(no output)';
      return `[Sub-agent ${result.runId.slice(0, 8)}] ${status}\n\n${summary}`;
    }

    // fan-out / pipeline: not yet implemented, fall back to single
    return [
      `Mode "${mode}" is not yet implemented.`,
      'Falling back to single-agent execution.',
      '',
      await (async () => {
        const result = await ctx.spawnSubagent!({
          task: input.task,
          scope: input.scope ?? 'full',
          maxTurns: input.maxTurns ?? 10,
        });
        const status = result.success ? 'SUCCESS' : 'FAILED';
        return `[Sub-agent ${result.runId.slice(0, 8)}] ${status}\n\n${result.summary || '(no output)'}`;
      })(),
    ].join('\n');
  },
};
