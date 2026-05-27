/**
 * SubAgentRunner factory — wraps `runAgentLoop` as a `SubAgentRunner` callback.
 *
 * Bridges the SubagentOrchestrator (runFanOut / runPipeline) to the core
 * agent loop, enabling the LLM to spawn child agents via the `create_subagent` tool.
 *
 * Design decisions:
 * - In-memory sessions: child messages are collected in-memory, not persisted to disk.
 * - No-op compaction: child runs are short-lived (maxTurns ≤ 10).
 * - Recursion prevention: `create_subagent` is filtered from child tool lists.
 * - Provider reuse: child shares the parent's LLM stream function and model.
 */

import type { Tool } from '../tools/tool-types.js';
import type { Model, StreamFunction, ThinkingLevel } from '../../provider/pi-ai-types.js';
import type { AgentLoopPlatformConfig } from '../loop/agent-loop-types.js';
import type { Message } from '../session/session-jsonl.js';
import type { SubAgentConfig, SubAgentResult, SubAgentRunner } from './subagent-orchestrator.js';
import { resolveSpawnToolSet, buildSubagentPromptAddon } from './spawn-profile.js';
import { runAgentLoop } from '../loop/agent-loop.js';
import { getRootLogger } from '../../logger.js';

const log = getRootLogger().child('subagent-runner');

export interface SubAgentRunnerDeps {
  /** Parent agent's full tool list (runner filters by scope). */
  parentTools: Tool[];
  /** Parent agent's LLM stream function (reused by child). */
  streamFn: StreamFunction;
  /** Model definition for the child agent loop. */
  modelDef: Model<any>;
  /** Parent system prompt (scope addon is appended). */
  systemPrompt: string;
  /** Max output tokens per LLM call. */
  maxOutputTokens: number;
  /** Context window size in tokens. */
  contextTokens: number;
  /** Temperature for LLM sampling. */
  temperature?: number;
  /** Reasoning/thinking level. */
  reasoning?: ThinkingLevel;
  /** Platform-specific loop configuration. */
  platform?: AgentLoopPlatformConfig;
}

/**
 * Create a SubAgentRunner that executes child agents via `runAgentLoop`.
 *
 * The returned runner:
 * 1. Filters tools by scope (via `resolveSpawnToolSet`)
 * 2. Removes `create_subagent` to prevent recursive spawning
 * 3. Appends scope-specific prompt constraints (via `buildSubagentPromptAddon`)
 * 4. Runs the child agent loop with in-memory message collection
 * 5. Returns a `SubAgentResult` with summary, metrics, and success status
 */
export function createSubAgentRunner(deps: SubAgentRunnerDeps): SubAgentRunner {
  return async (config: SubAgentConfig, signal: AbortSignal): Promise<SubAgentResult> => {
    const startedAt = Date.now();
    const childRunId = config.runId;
    const childSessionKey = `subagent:${childRunId}`;

    // 1. Tool filtering: scope-based + recursion prevention
    const allowedTools = resolveSpawnToolSet(config.scope);
    const scopedTools = allowedTools
      ? deps.parentTools.filter((t) => allowedTools.has(t.name))
      : [...deps.parentTools];
    const filteredTools = scopedTools.filter((t) => t.name !== 'create_subagent');

    // 2. Prompt addon: inject scope-specific constraints
    const promptAddon = buildSubagentPromptAddon(config.scope);
    const childSystemPrompt = promptAddon
      ? `${deps.systemPrompt}\n\n${promptAddon}`
      : deps.systemPrompt;

    // 3. Initial message: the task description
    const childMessages: Message[] = [
      { role: 'user', content: config.task, timestamp: Date.now() },
    ];

    // 4. In-memory message collection (child sessions are not persisted)
    const inMemoryMessages: Message[] = [...childMessages];
    let toolResultCount = 0;
    let turnCount = 0;

    log.info('starting child agent', {
      runId: childRunId,
      scope: config.scope,
      maxTurns: config.maxTurns ?? 10,
      toolCount: filteredTools.length,
      parentRunId: config.parentRunId,
    });

    try {
      // 5. Launch the child agent loop
      const childStream = runAgentLoop({
        runId: childRunId,
        sessionKey: childSessionKey,
        agentId: `subagent:${config.scope}`,
        currentMessages: childMessages,
        compactionSummary: undefined,
        systemPrompt: childSystemPrompt,
        toolsForRun: filteredTools,
        getToolsForRun: () => filteredTools,
        toolCtx: {
          workspaceDir: process.cwd(),
          sessionKey: childSessionKey,
          abortSignal: signal,
        },
        modelDef: deps.modelDef,
        streamFn: deps.streamFn,
        temperature: deps.temperature,
        reasoning: deps.reasoning,
        maxTurns: config.maxTurns ?? 10,
        contextTokens: deps.contextTokens,
        getSteeringMessages: async () => [],
        appendMessage: async (_key, msg) => {
          inMemoryMessages.push(msg);
        },
        replaceMessages: async (_key, msgs) => {
          inMemoryMessages.splice(0, inMemoryMessages.length, ...msgs);
        },
        prepareCompaction: async () => ({}),
        abortSignal: signal,
        maxOutputTokens: deps.maxOutputTokens,
        platform: deps.platform,
      });

      // 6. Consume the event stream, collecting metrics
      for await (const event of childStream) {
        if (event.type === 'tool_execution_end') toolResultCount++;
        if (event.type === 'turn_end') turnCount = event.turn;
      }

      const miniResult = await childStream.result();

      log.info('child agent completed', {
        runId: childRunId,
        turns: turnCount,
        toolResults: toolResultCount,
        durationMs: Date.now() - startedAt,
        finalTextLength: miniResult.finalText.length,
      });

      return {
        runId: childRunId,
        summary: miniResult.finalText,
        toolResults: toolResultCount,
        turns: turnCount,
        durationMs: Date.now() - startedAt,
        success: true,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn('child agent failed', {
        runId: childRunId,
        error: errorMsg,
        durationMs: Date.now() - startedAt,
      });

      return {
        runId: childRunId,
        summary: '',
        toolResults: toolResultCount,
        turns: turnCount,
        durationMs: Date.now() - startedAt,
        success: false,
        error: errorMsg,
      };
    }
  };
}
