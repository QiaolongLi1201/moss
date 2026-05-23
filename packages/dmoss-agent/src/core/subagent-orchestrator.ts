/**
 * Sub-agent orchestration runtime.
 *
 * Provides fan-out (parallel dispatch) and pipeline (sequential chain)
 * execution patterns on top of the existing spawn-profile tool scoping.
 *
 * Integrates with MeshEventBus so hosts receive structured child_run_* events.
 */

import type { SpawnToolScope } from './spawn-profile.js';
import { resolveSpawnToolSet } from './spawn-profile.js';
import type { MeshEventBus } from '../mesh/mesh-events.js';

// ── Types ───────────────────────────────────────────────────────

export interface SubAgentConfig {
  /** Unique id for this child run. */
  runId: string;
  /** Parent agent run id. */
  parentRunId: string;
  /** Tool scope for the child. */
  scope: SpawnToolScope;
  /** System prompt or task description for the child. */
  task: string;
  /** Maximum turns the child may execute. Enforced by the runner, not the orchestrator. */
  maxTurns?: number;
  /** Timeout in ms for the entire child run (default: 120_000). */
  timeoutMs?: number;
}

export interface SubAgentResult {
  runId: string;
  summary: string;
  toolResults: number;
  turns: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface FanOutResult {
  results: SubAgentResult[];
  allSucceeded: boolean;
  durationMs: number;
}

export interface PipelineResult {
  results: SubAgentResult[];
  allSucceeded: boolean;
  durationMs: number;
}

/** Callback invoked to actually run a child agent. Hosts inject their LLM provider here. */
export type SubAgentRunner = (
  config: SubAgentConfig,
  signal: AbortSignal,
) => Promise<SubAgentResult>;

function emitChildRunProgress(eventBus: MeshEventBus | undefined, runId: string): void {
  eventBus?.emit({
    type: 'child_run_progress',
    runId,
    turn: 0,
    toolCalls: [],
    status: 'running',
    timestamp: Date.now(),
  });
}

// ── Fan-out (parallel dispatch) ─────────────────────────────────

export async function runFanOut(
  configs: SubAgentConfig[],
  runner: SubAgentRunner,
  eventBus?: MeshEventBus,
  parentSignal?: AbortSignal,
): Promise<FanOutResult> {
  const started = Date.now();

  const tasks = configs.map(async (config) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 120_000);

    const onParentAbort = () => controller.abort();
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });

    eventBus?.emit({
      type: 'child_run_started',
      runId: config.runId,
      parentRunId: config.parentRunId,
      scope: config.scope,
      toolSet: [...(resolveSpawnToolSet(config.scope) ?? [])],
      timestamp: Date.now(),
    });
    emitChildRunProgress(eventBus, config.runId);

    try {
      const result = await runner(config, controller.signal);
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', onParentAbort);

      if (result.success) {
        eventBus?.emit({
          type: 'child_run_completed',
          runId: config.runId,
          summary: result.summary,
          toolResults: result.toolResults,
          turns: result.turns,
          durationMs: result.durationMs,
          timestamp: Date.now(),
        });
      } else {
        eventBus?.emit({
          type: 'child_run_failed',
          runId: config.runId,
          error: result.error ?? 'unknown',
          category: 'execution',
          timestamp: Date.now(),
        });
      }

      return result;
    } catch (err) {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', onParentAbort);

      eventBus?.emit({
        type: 'child_run_failed',
        runId: config.runId,
        error: err instanceof Error ? err.message : String(err),
        category: 'crash',
        timestamp: Date.now(),
      });

      return {
        runId: config.runId,
        summary: '',
        toolResults: 0,
        turns: 0,
        durationMs: Date.now() - started,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const results = await Promise.all(tasks);
  return {
    results,
    allSucceeded: results.every((r) => r.success),
    durationMs: Date.now() - started,
  };
}

// ── Pipeline (sequential chain) ─────────────────────────────────

export async function runPipeline(
  configs: SubAgentConfig[],
  runner: SubAgentRunner,
  eventBus?: MeshEventBus,
  parentSignal?: AbortSignal,
): Promise<PipelineResult> {
  const started = Date.now();
  const results: SubAgentResult[] = [];
  let previousSummary = '';

  for (const config of configs) {
    if (parentSignal?.aborted) break;

    // Inject previous result as context
    const augmentedConfig: SubAgentConfig = previousSummary
      ? { ...config, task: `${config.task}\n\n[Previous step result]\n${previousSummary}` }
      : config;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 120_000);
    const onParentAbort = () => controller.abort();
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });

    eventBus?.emit({
      type: 'child_run_started',
      runId: augmentedConfig.runId,
      parentRunId: augmentedConfig.parentRunId,
      scope: augmentedConfig.scope,
      toolSet: [...(resolveSpawnToolSet(augmentedConfig.scope) ?? [])],
      timestamp: Date.now(),
    });
    emitChildRunProgress(eventBus, augmentedConfig.runId);

    try {
      const result = await runner(augmentedConfig, controller.signal);
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', onParentAbort);
      results.push(result);
      previousSummary = result.summary;

      if (result.success) {
        eventBus?.emit({
          type: 'child_run_completed',
          runId: config.runId,
          summary: result.summary,
          toolResults: result.toolResults,
          turns: result.turns,
          durationMs: result.durationMs,
          timestamp: Date.now(),
        });
      } else {
        eventBus?.emit({
          type: 'child_run_failed',
          runId: config.runId,
          error: result.error ?? 'unknown',
          category: 'execution',
          timestamp: Date.now(),
        });
        break; // pipeline stops on first failure
      }
    } catch (err) {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', onParentAbort);
      results.push({
        runId: config.runId,
        summary: '',
        toolResults: 0,
        turns: 0,
        durationMs: Date.now() - started,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });

      eventBus?.emit({
        type: 'child_run_failed',
        runId: config.runId,
        error: err instanceof Error ? err.message : String(err),
        category: 'crash',
        timestamp: Date.now(),
      });
      break;
    }
  }

  return {
    results,
    allSucceeded: results.length === configs.length && results.every((r) => r.success),
    durationMs: Date.now() - started,
  };
}
