/**
 * create_subagent tool — spawns a child agent to perform a task.
 *
 * Delegates execution to `ctx.spawnSubagent`, which is injected by
 * `DmossAgent.streamChatViaAgentLoop`. The tool waits for the child
 * to complete and returns its summary as the tool result.
 */

import type { Tool, ToolContext } from '../core/tools/tool-types.js';

interface CreateSubagentInput {
  task: string;
  scope?: 'read-only' | 'device-read' | 'full' | 'explore' | 'plan' | 'verify';
  maxTurns?: number;
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
