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
import type { SubagentRunProgress } from '../tools/tool-types.js';
import type { Model, StreamFunction, ThinkingLevel } from '../../provider/pi-ai-types.js';
import type { AgentLoopPlatformConfig } from '../loop/agent-loop-types.js';
import type { Message } from '../session/session-jsonl.js';
import type { LLMSystemPromptParts } from '../llm/llm-provider.js';
import type { SubAgentConfig, SubAgentResult, SubAgentRunner } from './subagent-orchestrator.js';
import { resolveSpawnToolSet, buildSubagentPromptAddon } from './spawn-profile.js';
import type { SpawnProfileRegistry, SpawnToolScope } from './spawn-profile.js';
import { runAgentLoop } from '../loop/agent-loop.js';
import { getRootLogger } from '../../logger.js';
import { getMossWorkspacePaths } from '../../utils/workspace-paths.js';

const log = getRootLogger().child('subagent-runner');

const READONLY_SCOPES: ReadonlySet<SpawnToolScope> = new Set([
  'read-only', 'device-read', 'explore', 'plan',
]);

function scopeNeedsIsolation(scope: SpawnToolScope): boolean {
  return !READONLY_SCOPES.has(scope);
}

async function prepareWorkspaceDir(
  parentWorkspaceDir: string,
  scope: SpawnToolScope,
  runId: string,
): Promise<{ workspaceDir: string; isolated: boolean }> {
  const workspaceDir = path.resolve(parentWorkspaceDir);
  if (!scopeNeedsIsolation(scope)) {
    return { workspaceDir, isolated: false };
  }
  const isolatedDir = path.join(getMossWorkspacePaths(workspaceDir).runtimeDir, 'subagent', runId);
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
  /** Cache-friendly parent system prompt split, when prompt caching is enabled. */
  systemPromptParts?: LLMSystemPromptParts;
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
  /** Parent workspace root used for read-only scopes and child isolation. Defaults to process.cwd(). */
  workspaceDir?: string;
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
    const childDynamicSystemPrompt = deps.systemPromptParts
      ? [deps.systemPromptParts.dynamic, promptAddon, prevStepAddon].filter(Boolean).join('\n\n')
      : undefined;
    const childSystemPrompt = deps.systemPromptParts
      ? [deps.systemPromptParts.stable, childDynamicSystemPrompt].filter(Boolean).join('\n\n')
      : [deps.systemPrompt, promptAddon, prevStepAddon].filter(Boolean).join('\n\n');
    const childSystemPromptParts = deps.systemPromptParts
      ? { stable: deps.systemPromptParts.stable, dynamic: childDynamicSystemPrompt ?? '' }
      : undefined;

    // 3. Initial message: the task description
    const childMessages: Message[] = [
      { role: 'user', content: config.task, timestamp: Date.now() },
    ];

    // 4. In-memory message collection (child sessions are not persisted)
    const inMemoryMessages: Message[] = [...childMessages];
    let toolResultCount = 0;
    let turnCount = 0;
    let lastTool: string | undefined;
    let partialText = '';
    const emitProgress = (partial: Partial<SubagentRunProgress>): void => {
      config.onProgress?.({
        runId: childRunId,
        scope: config.scope,
        task: config.task,
        status: 'running',
        maxTurns: config.maxTurns ?? 10,
        turn: turnCount || undefined,
        toolResults: toolResultCount,
        ...(lastTool ? { lastTool } : {}),
        elapsedMs: Date.now() - startedAt,
        ...partial,
      });
    };

    const { workspaceDir, isolated } = await prepareWorkspaceDir(deps.workspaceDir ?? process.cwd(), config.scope, childRunId);

    log.info('starting child agent', {
      runId: childRunId,
      scope: config.scope,
      maxTurns: config.maxTurns ?? 10,
      toolCount: filteredTools.length,
      parentRunId: config.parentRunId,
      isolatedWorkspace: isolated,
    });
    emitProgress({ status: 'started', phase: 'starting' });

    try {
      // 5. Launch the child agent loop
      const childStream = runAgentLoop({
        runId: childRunId,
        sessionKey: childSessionKey,
        agentId: `subagent:${config.scope}`,
        currentMessages: childMessages,
        compactionSummary: undefined,
        systemPrompt: childSystemPrompt,
        systemPromptParts: childSystemPromptParts,
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
        if (event.type === 'message_delta') {
          partialText = `${partialText}${event.delta}`.slice(-400);
        }
        if (event.type === 'turn_start') {
          turnCount = event.turn;
          emitProgress({ phase: 'turn', turn: event.turn });
        }
        if (event.type === 'tool_execution_start') {
          lastTool = event.toolName;
          emitProgress({ phase: 'tool', lastTool });
        }
        if (event.type === 'tool_execution_end') {
          toolResultCount++;
          lastTool = event.toolName;
          emitProgress({ phase: 'tool', lastTool, toolResults: toolResultCount });
        }
        if (event.type === 'turn_end') {
          turnCount = event.turn;
          emitProgress({ phase: 'turn', turn: event.turn });
        }
      }

      const miniResult = await childStream.result();
      const finalSummary = miniResult.finalText.trim();
      if (!finalSummary) {
        const message = `Sub-agent completed without a final response (${turnCount} turn${turnCount === 1 ? '' : 's'}, ${toolResultCount} tool result${toolResultCount === 1 ? '' : 's'}).`;
        log.warn('child agent completed without final text', {
          runId: childRunId,
          turns: turnCount,
          toolResults: toolResultCount,
          durationMs: Date.now() - startedAt,
        });
        emitProgress({
          status: 'failed',
          phase: 'failed',
          error: message,
          ...(partialText ? { summaryPreview: partialText.trim().slice(0, 240) } : {}),
        });
        return {
          runId: childRunId,
          summary: message,
          toolResults: toolResultCount,
          turns: turnCount,
          durationMs: Date.now() - startedAt,
          success: false,
          error: message,
        };
      }

      log.info('child agent completed', {
        runId: childRunId,
        turns: turnCount,
        toolResults: toolResultCount,
        durationMs: Date.now() - startedAt,
        finalTextLength: finalSummary.length,
      });
      emitProgress({
        status: 'completed',
        phase: 'completed',
        summaryPreview: finalSummary.slice(0, 240),
      });

      return {
        runId: childRunId,
        summary: finalSummary,
        toolResults: toolResultCount,
        turns: turnCount,
        durationMs: Date.now() - startedAt,
        success: true,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const summary = `Sub-agent failed: ${errorMsg}`;
      log.warn('child agent failed', {
        runId: childRunId,
        error: errorMsg,
        durationMs: Date.now() - startedAt,
      });
      emitProgress({
        status: 'failed',
        phase: 'failed',
        error: errorMsg,
        ...(partialText ? { summaryPreview: partialText.trim().slice(0, 240) } : {}),
      });

      return {
        runId: childRunId,
        summary,
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
