#!/usr/bin/env node
/**
 * LLM usage tracker — unit tests.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/llm-usage.spec.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  logLLMUsage,
  readUsageLog,
  summarizeUsage,
  formatUsageSummary,
  estimateLLMCost,
} from '../dist/observability/llm-usage.js';

// ── Setup: use temp dir for test logs ───────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-llm-usage-test-'));
const origEnv = process.env.DMOSS_LLM_USAGE_LOG;
process.env.DMOSS_LLM_USAGE_LOG = path.join(tmpDir, 'llm-usage.jsonl');

function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origEnv) {
    process.env.DMOSS_LLM_USAGE_LOG = origEnv;
  } else {
    delete process.env.DMOSS_LLM_USAGE_LOG;
  }
}

// ── Test: log and read back ──────────────────────────────────────

{
  await logLLMUsage({
    runId: 'run-1',
    providerId: 'openai',
    model: 'gpt-4o',
    inputTokens: 500,
    outputTokens: 200,
    durationMs: 1200,
    success: true,
  });

  await logLLMUsage({
    runId: 'run-2',
    providerId: 'anthropic',
    model: 'claude-sonnet-4-6',
    inputTokens: 1000,
    outputTokens: 500,
    durationMs: 2500,
    success: true,
  });

  await logLLMUsage({
    runId: 'run-3',
    providerId: 'openai',
    model: 'gpt-4o',
    inputTokens: 300,
    outputTokens: 0,
    durationMs: 5000,
    success: false,
    error: 'timeout',
  });

  const records = await readUsageLog();
  assert.equal(records.length, 3, 'should have 3 records');

  // Check record fields
  const r1 = records[0];
  assert.equal(r1.runId, 'run-1');
  assert.equal(r1.providerId, 'openai');
  assert.equal(r1.model, 'gpt-4o');
  assert.equal(r1.inputTokens, 500);
  assert.equal(r1.outputTokens, 200);
  assert.equal(r1.durationMs, 1200);
  assert.equal(r1.success, true);
  assert.ok(r1.timestamp, 'should have timestamp');
  assert.ok(typeof r1.estimatedCostUsd === 'number', 'should have estimated cost');

  const r3 = records[2];
  assert.equal(r3.success, false);
  assert.equal(r3.error, 'timeout');

  console.log('  [PASS] log and read back usage records');
}

// ── Test: summarize ──────────────────────────────────────────────

{
  const records = await readUsageLog();
  const summary = summarizeUsage(records);

  assert.equal(summary.totalRequests, 3);
  assert.equal(summary.totalInputTokens, 1800); // 500 + 1000 + 300
  assert.equal(summary.totalOutputTokens, 700); // 200 + 500 + 0
  assert.ok(summary.totalCostUsd > 0, 'should have estimated cost');

  // By model
  const gpt4o = summary.byModel['gpt-4o'];
  assert.ok(gpt4o, 'should have gpt-4o entry');
  assert.equal(gpt4o.requests, 2);
  assert.equal(gpt4o.inputTokens, 800);

  const sonnet = summary.byModel['claude-sonnet-4-6'];
  assert.ok(sonnet, 'should have sonnet entry');
  assert.equal(sonnet.requests, 1);
  assert.equal(sonnet.inputTokens, 1000);
  assert.equal(sonnet.outputTokens, 500);

  // By provider
  const openai = summary.byProvider['openai'];
  assert.equal(openai.requests, 2);

  const anthropic = summary.byProvider['anthropic'];
  assert.equal(anthropic.requests, 1);

  console.log('  [PASS] summarize usage records');
}

// ── Test: format summary ─────────────────────────────────────────

{
  const records = await readUsageLog();
  const summary = summarizeUsage(records);
  const formatted = formatUsageSummary(summary);

  assert.ok(formatted.includes('LLM Usage Summary'));
  assert.ok(formatted.includes('Total requests: 3'));
  assert.ok(formatted.includes('gpt-4o'));
  assert.ok(formatted.includes('claude-sonnet-4-6'));

  console.log('  [PASS] format usage summary');
}

// ── Test: cost estimation ────────────────────────────────────────

{
  // gpt-4o: $0.0025/1K input, $0.01/1K output
  const cost = estimateLLMCost('gpt-4o', 1000, 1000);
  assert.ok(typeof cost === 'number');
  // 1K input at $0.0025 + 1K output at $0.01 = $0.0125
  assert.ok(Math.abs(cost - 0.0125) < 0.001, `expected ~0.0125, got ${cost}`);

  // Unknown model
  const unknown = estimateLLMCost('unknown-model', 1000, 1000);
  assert.equal(unknown, undefined);

  console.log('  [PASS] cost estimation');
}

// ── Test: unknown model has no cost ──────────────────────────────

{
  // Clear and re-log with unknown model
  fs.unlinkSync(process.env.DMOSS_LLM_USAGE_LOG);

  await logLLMUsage({
    runId: 'run-u',
    providerId: 'test',
    model: 'unknown-model',
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 100,
    success: true,
  });

  const records = await readUsageLog();
  assert.equal(records.length, 1);
  assert.equal(records[0].estimatedCostUsd, undefined);

  console.log('  [PASS] unknown model has no cost estimate');
}

// ── Test: empty log returns empty array ──────────────────────────

{
  // Point to a new temp path
  const emptyPath = path.join(tmpDir, 'empty.jsonl');
  process.env.DMOSS_LLM_USAGE_LOG = emptyPath;

  const records = await readUsageLog();
  assert.deepEqual(records, []);

  const summary = summarizeUsage(records);
  assert.equal(summary.totalRequests, 0);
  assert.equal(summary.totalInputTokens, 0);

  console.log('  [PASS] empty log returns empty results');
}

// ── Cleanup ──────────────────────────────────────────────────────

cleanup();
console.log('\n[pass] llm-usage: 6/6');