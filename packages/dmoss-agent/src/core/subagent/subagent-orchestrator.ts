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
import type { MeshEventBus } from '../../mesh/mesh-events.js';
import type { SubagentRunProgress } from '../tools/tool-types.js';

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
  /** Structured context from a prior pipeline step (injected by the orchestrator). */
  previousStepResult?: {
    runId: string;
    summary: string;
    success: boolean;
  };
  /** Optional live progress sink for parent task surfaces. */
  onProgress?: (progress: SubagentRunProgress) => void;
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
  /** Aggregated metrics. */
  totalToolResults: number;
  totalTurns: number;
  successCount: number;
  failureCount: number;
}

export interface PipelineResult {
  results: SubAgentResult[];
  allSucceeded: boolean;
  durationMs: number;
  /** Aggregated metrics. */
  totalToolResults: number;
  totalTurns: number;
  successCount: number;
  failureCount: number;
}

/** Callback invoked to actually run a child agent. Hosts inject their LLM provider here. */
export type SubAgentRunner = (
  config: SubAgentConfig,
  signal: AbortSignal,
) => Promise<SubAgentResult>;

// ── Shared lifecycle ────────────────────────────────────────────

function aggregateResults(results: SubAgentResult[]): {
  totalToolResults: number;
  totalTurns: number;
  successCount: number;
  failureCount: number;
} {
  let totalToolResults = 0;
  let totalTurns = 0;
  let successCount = 0;
  let failureCount = 0;
  for (const r of results) {
    totalToolResults += r.toolResults;
    totalTurns += r.turns;
    if (r.success) successCount++;
    else failureCount++;
  }
  return { totalToolResults, totalTurns, successCount, failureCount };
}

/**
 * Run a single child agent with timeout, parent-abort propagation, and
 * structured event emission. Returns a SubAgentResult even on crash.
 */
async function runSingleChild(
  config: SubAgentConfig,
  runner: SubAgentRunner,
  eventBus: MeshEventBus | undefined,
  parentSignal: AbortSignal | undefined,
  startedAt: number,
): Promise<SubAgentResult> {
  const controller = new AbortController();
  const timeoutMs = config.timeoutMs ?? 120_000;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // Reject on timeout (not just abort the signal): a runner that ignores the
  // abort signal must not block the parent past timeoutMs. Cooperative runners
  // that settle on abort still win the race first, preserving their behavior.
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`child run timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

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

  try {
    const result = await Promise.race([runner(config, controller.signal), timeoutPromise]);

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
    const errorMsg = err instanceof Error ? err.message : String(err);
    eventBus?.emit({
      type: 'child_run_failed',
      runId: config.runId,
      error: errorMsg,
      category: 'crash',
      timestamp: Date.now(),
    });

    return {
      runId: config.runId,
      summary: '',
      toolResults: 0,
      turns: 0,
      durationMs: Date.now() - startedAt,
      success: false,
      error: errorMsg,
    };
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

// ── Fan-out (parallel dispatch) ─────────────────────────────────

export async function runFanOut(
  configs: SubAgentConfig[],
  runner: SubAgentRunner,
  eventBus?: MeshEventBus,
  parentSignal?: AbortSignal,
): Promise<FanOutResult> {
  const started = Date.now();

  const tasks = configs.map((config) =>
    runSingleChild(config, runner, eventBus, parentSignal, started),
  );

  const settled = await Promise.allSettled(tasks);
  const results: SubAgentResult[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          runId: configs[i].runId,
          summary: '',
          toolResults: 0,
          turns: 0,
          durationMs: Date.now() - started,
          success: false,
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        },
  );
  const agg = aggregateResults(results);

  return {
    results,
    allSucceeded: results.every((r) => r.success),
    durationMs: Date.now() - started,
    ...agg,
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
  let previousResult: SubAgentResult | undefined;

  for (const config of configs) {
    if (parentSignal?.aborted) break;

    const augmentedConfig: SubAgentConfig = previousResult
      ? {
          ...config,
          previousStepResult: {
            runId: previousResult.runId,
            summary: previousResult.summary,
            success: previousResult.success,
          },
        }
      : config;

    const result = await runSingleChild(augmentedConfig, runner, eventBus, parentSignal, started);
    results.push(result);
    previousResult = result;

    // Pipeline stops on first failure
    if (!result.success) break;
  }

  const agg = aggregateResults(results);

  return {
    results,
    allSucceeded: results.length === configs.length && results.every((r) => r.success),
    durationMs: Date.now() - started,
    ...agg,
  };
}
