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

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '../tools/tool-types.js';
import type { Model, StreamFunction, ThinkingLevel } from '../../provider/pi-ai-types.js';
import type { AgentLoopPlatformConfig } from '../loop/agent-loop-types.js';
import type { Message } from '../session/session-jsonl.js';
import type { SubAgentConfig, SubAgentResult, SubAgentRunner } from './subagent-orchestrator.js';
import { resolveSpawnToolSet, buildSubagentPromptAddon } from './spawn-profile.js';
import type { SpawnProfileRegistry, SpawnToolScope } from './spawn-profile.js';
import { runAgentLoop } from '../loop/agent-loop.js';
import { getRootLogger } from '../../logger.js';

const log = getRootLogger().child('subagent-runner');

const READONLY_SCOPES: ReadonlySet<SpawnToolScope> = new Set([
  'read-only', 'device-read', 'explore', 'plan',
]);

function scopeNeedsIsolation(scope: SpawnToolScope): boolean {
  return !READONLY_SCOPES.has(scope);
}

async function prepareWorkspaceDir(
  scope: SpawnToolScope,
  runId: string,
): Promise<{ workspaceDir: string; isolated: boolean }> {
  const cwd = process.cwd();
  if (!scopeNeedsIsolation(scope)) {
    return { workspaceDir: cwd, isolated: false };
  }
  const isolatedDir = path.join(cwd, '.dmoss-subagent', runId);
  await fs.mkdir(isolatedDir, { recursive: true });
  log.info('created isolated workspace for child agent', {
    runId,
    scope,
    workspaceDir: isolatedDir,
  });
  return { workspaceDir: isolatedDir, isolated: true };
}

async function cleanupIsolatedWorkspace(workspaceDir: string): Promise<void> {
  try {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  } catch (err) {
    log.warn('failed to clean up isolated workspace', {
      workspaceDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

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
  /** Maximum nesting depth for sub-agent spawning (default: 1). */
  maxSpawnDepth?: number;
  /** Tool hook registry for child agent (inherits parent's sanitizer). */
  toolHooks?: import('../tools/tool-hooks.js').ToolHookRegistry;
  /** Per-agent spawn scope registry. Defaults to deprecated global compatibility registry. */
  spawnRegistry?: SpawnProfileRegistry;
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
    const allowedTools = resolveSpawnToolSet(config.scope, deps.spawnRegistry);
    const scopedTools = allowedTools
      ? deps.parentTools.filter((t) => allowedTools.has(t.name))
      : [...deps.parentTools];
    const filteredTools = scopedTools.filter((t) => t.name !== 'create_subagent');

    // 2. Prompt addon: inject scope-specific constraints + previous step result
    const promptAddon = buildSubagentPromptAddon(config.scope);
    const prevStepAddon = config.previousStepResult
      ? `[Previous pipeline step result]\nrunId: ${config.previousStepResult.runId}\nsuccess: ${config.previousStepResult.success}\nsummary:\n${config.previousStepResult.summary}`
      : undefined;
    const childSystemPrompt = [deps.systemPrompt, promptAddon, prevStepAddon]
      .filter(Boolean)
      .join('\n\n');

    // 3. Initial message: the task description
    const childMessages: Message[] = [
      { role: 'user', content: config.task, timestamp: Date.now() },
    ];

    // 4. In-memory message collection (child sessions are not persisted)
    const inMemoryMessages: Message[] = [...childMessages];
    let toolResultCount = 0;
    let turnCount = 0;

    const { workspaceDir, isolated } = await prepareWorkspaceDir(config.scope, childRunId);

    log.info('starting child agent', {
      runId: childRunId,
      scope: config.scope,
      maxTurns: config.maxTurns ?? 10,
      toolCount: filteredTools.length,
      parentRunId: config.parentRunId,
      isolatedWorkspace: isolated,
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
          workspaceDir,
          sessionKey: childSessionKey,
          abortSignal: signal,
          maxSpawnDepth: deps.maxSpawnDepth ?? 1,
          currentSpawnDepth: 1,
        },
        modelDef: deps.modelDef,
        streamFn: deps.streamFn,
        temperature: deps.temperature,
        reasoning: deps.reasoning,
        maxTurns: config.maxTurns ?? 10,
        contextTokens: deps.contextTokens,
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
        toolHooks: deps.toolHooks,
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
    } finally {
      if (isolated) {
        await cleanupIsolatedWorkspace(workspaceDir);
      }
    }
  };
}
