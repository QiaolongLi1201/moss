/**
 * LLM usage tracker — logs token consumption and cost estimates.
 *
 * Writes structured JSONL records to a configurable log file so hosts
 * can monitor LLM spend without external observability infrastructure.
 *
 * Set DMOSS_LLM_USAGE_LOG to configure the output path.
 * Default: .moss/llm-usage.jsonl (relative to cwd)
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ───────────────────────────────────────────────────────

export interface LLMUsageRecord {
  timestamp: string;
  runId: string;
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost in USD (if pricing data available). */
  estimatedCostUsd?: number;
  /** Duration of the LLM request in ms. */
  durationMs: number;
  /** Whether the request succeeded. */
  success: boolean;
  /** Error message if !success. */
  error?: string;
}

export interface LLMUsageSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byModel: Record<string, {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
  byProvider: Record<string, {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
  periodStart: string;
  periodEnd: string;
}

// ── Pricing table (per 1K tokens, USD) ──────────────────────────

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-opus-4-7': { input: 0.015, output: 0.075 },
  'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
  'claude-haiku-4-5': { input: 0.001, output: 0.005 },
  // OpenAI
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  // Qwen
  'qwen3.6-plus': { input: 0.0008, output: 0.002 },
  'qwen-coder-plus': { input: 0.0008, output: 0.002 },
};

/**
 * Register or override pricing for a model. Hosts call this at startup
 * to add pricing for custom/proprietary models before any LLM calls.
 */
export function registerModelPricing(
  model: string,
  inputPer1K: number,
  outputPer1K: number,
): void {
  MODEL_PRICING[model] = { input: inputPer1K, output: outputPer1K };
}

// ── Log path ─────────────────────────────────────────────────────

function getUsageLogPath(): string {
  const envPath = process.env.DMOSS_LLM_USAGE_LOG;
  if (envPath) return envPath;
  const cwd = process.env.DMOSS_WORKSPACE_DIR ?? process.cwd();
  return path.join(cwd, '.moss', 'llm-usage.jsonl');
}

// ── Write record ─────────────────────────────────────────────────

function estimateCost(model: string, inputTokens: number, outputTokens: number): number | undefined {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return undefined;
  return (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output;
}

/**
 * Append a usage record to the log file.
 * Creates the directory if it doesn't exist.
 */
export async function logLLMUsage(record: Omit<LLMUsageRecord, 'timestamp' | 'estimatedCostUsd'>): Promise<void> {
  const logPath = getUsageLogPath();
  const dir = path.dirname(logPath);

  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const fullRecord: LLMUsageRecord = {
    ...record,
    timestamp: new Date().toISOString(),
    estimatedCostUsd: estimateCost(record.model, record.inputTokens, record.outputTokens),
  };

  const line = JSON.stringify(fullRecord) + '\n';
  await fs.promises.appendFile(logPath, line, 'utf-8');
}

// ── Read and summarize ───────────────────────────────────────────

/**
 * Read all usage records from the log file.
 */
export async function readUsageLog(): Promise<LLMUsageRecord[]> {
  const logPath = getUsageLogPath();
  try {
    const content = await fs.promises.readFile(logPath, 'utf-8');
    return content
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        // M4: Gracefully skip corrupt JSONL lines
        try { return [JSON.parse(line) as LLMUsageRecord]; } catch { return []; }
      });
  } catch {
    return [];
  }
}

/**
 * Summarize usage records, optionally filtered to a time range.
 */
export function summarizeUsage(
  records: LLMUsageRecord[],
  periodStart?: string,
  periodEnd?: string,
): LLMUsageSummary {
  const start = periodStart ? new Date(periodStart).getTime() : 0;
  const end = periodEnd ? new Date(periodEnd).getTime() : Infinity;

  const filtered = records.filter((r) => {
    const ts = new Date(r.timestamp).getTime();
    return ts >= start && ts <= end;
  });

  const summary: LLMUsageSummary = {
    totalRequests: filtered.length,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    byModel: {},
    byProvider: {},
    periodStart: filtered.length > 0 ? filtered[0].timestamp : (periodStart ?? ''),
    periodEnd: filtered.length > 0 ? filtered[filtered.length - 1].timestamp : (periodEnd ?? ''),
  };

  for (const r of filtered) {
    summary.totalInputTokens += r.inputTokens;
    summary.totalOutputTokens += r.outputTokens;
    summary.totalCostUsd += r.estimatedCostUsd ?? 0;

    // By model
    const m = summary.byModel[r.model] ??= { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    m.requests++;
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.outputTokens;
    m.costUsd += r.estimatedCostUsd ?? 0;

    // By provider
    const p = summary.byProvider[r.providerId] ??= { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    p.requests++;
    p.inputTokens += r.inputTokens;
    p.outputTokens += r.outputTokens;
    p.costUsd += r.estimatedCostUsd ?? 0;
  }

  return summary;
}

/**
 * Format a usage summary as a human-readable string.
 */
export function formatUsageSummary(summary: LLMUsageSummary): string {
  const lines: string[] = [];
  lines.push(`LLM Usage Summary`);
  lines.push(`  Period: ${summary.periodStart} → ${summary.periodEnd}`);
  lines.push(`  Total requests: ${summary.totalRequests}`);
  lines.push(`  Total tokens:  ${summary.totalInputTokens.toLocaleString()} in / ${summary.totalOutputTokens.toLocaleString()} out`);
  if (summary.totalCostUsd > 0) {
    lines.push(`  Est. cost:      $${summary.totalCostUsd.toFixed(4)}`);
  }
  lines.push('');

  if (Object.keys(summary.byModel).length > 0) {
    lines.push('  By model:');
    for (const [model, m] of Object.entries(summary.byModel)) {
      const costStr = m.costUsd > 0 ? ` — $${m.costUsd.toFixed(4)}` : '';
      lines.push(`    ${model}: ${m.requests} req, ${m.inputTokens.toLocaleString()}/${m.outputTokens.toLocaleString()} tokens${costStr}`);
    }
    lines.push('');
  }

  if (Object.keys(summary.byProvider).length > 0) {
    lines.push('  By provider:');
    for (const [provider, p] of Object.entries(summary.byProvider)) {
      const costStr = p.costUsd > 0 ? ` — $${p.costUsd.toFixed(4)}` : '';
      lines.push(`    ${provider}: ${p.requests} req, ${p.inputTokens.toLocaleString()}/${p.outputTokens.toLocaleString()} tokens${costStr}`);
    }
  }

  return lines.join('\n');
}

/**
 * Estimate cost for a specific model and token counts.
 * Returns undefined if pricing data is unavailable for the model.
 */
export function estimateLLMCost(model: string, inputTokens: number, outputTokens: number): number | undefined {
  return estimateCost(model, inputTokens, outputTokens);
}
