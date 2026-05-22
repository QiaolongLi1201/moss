#!/usr/bin/env node
/**
 * P2.2 — Compaction Fallback Chain tests.
 *
 * Three-layer fallback:
 *   1. LLM summarize (summarizeChunks)
 *   2. If failed → retry with smaller chunks
 *   3. If also failed → deterministic summary
 *   4. mergePriorCompactionSummaries
 *
 * Run: node packages/dmoss-agent/test/compaction-fallback.spec.mjs
 */

import assert from 'node:assert/strict';
import { compactHistoryIfNeeded } from '../dist/context/index.js';
import { createCompactionSummaryMessage } from '../dist/core/session-jsonl.js';
import { mergePriorCompactionSummaries, extractCompactionSummaryText } from '../dist/context/summary-checkpoint-merge.js';
import { buildDeterministicCompactionSummary } from '../dist/context/deterministic-summary.js';

// ── Helper: build test messages ──
function makeMessages(count) {
  const msgs = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `msg-${i}: ${'hello '.repeat(20)}` }],
    });
  }
  return msgs;
}

// ── Test 1: Deterministic fallback summary is non-empty ──
{
  const msgs = makeMessages(10);
  const summary = buildDeterministicCompactionSummary(msgs);
  assert.ok(summary.length > 10, `deterministic summary must be non-empty, got ${summary.length} chars`);
  console.log('  [PASS] deterministic summary generates non-empty text for 10 messages');
}

// ── Test 2: Deterministic summary for empty messages ──
{
  const summary = buildDeterministicCompactionSummary([]);
  assert.ok(summary.length > 0, 'deterministic summary for empty input must still produce text');
  console.log('  [PASS] deterministic summary handles empty message list');
}

// ── Test 3: mergePriorCompactionSummaries preserves new summary when no priors ──
{
  const base = 'Base conversation summary.';
  const merged = mergePriorCompactionSummaries(base, []);
  assert.equal(merged, base, 'no priors → unchanged base');
  console.log('  [PASS] mergePriorSummaries: no priors returns base unchanged');
}

// ── Test 4: mergePriorCompactionSummaries merges with priors ──
{
  const base = 'New summary.';
  const priors = ['Prior summary A.', 'Prior summary B.'];
  const merged = mergePriorCompactionSummaries(base, priors);
  assert.ok(merged.includes(base), 'merged must contain base summary');
  assert.ok(merged.includes('Prior summary A'), 'merged must include prior A');
  assert.ok(merged.includes('Prior summary B'), 'merged must include prior B');
  console.log('  [PASS] mergePriorSummaries: merges base with priors');
}

// ── Test 5: extractCompactionSummaryText extracts from a compaction summary Message ──
{
  const msg = createCompactionSummaryMessage('Extracted content');
  const extracted = extractCompactionSummaryText(msg);
  assert.equal(extracted, 'Extracted content', 'must extract content between tags');
  console.log('  [PASS] extractCompactionSummaryText: extracts from createCompactionSummaryMessage');
}

// ── Test 6: extractCompactionSummaryText returns null for non-summary message ──
{
  const msg = {
    role: 'user',
    content: 'Plain user message without compaction prefix',
  };
  const extracted = extractCompactionSummaryText(msg);
  assert.equal(extracted, null, 'must return null when no compaction prefix');
  console.log('  [PASS] extractCompactionSummaryText: returns null when no prefix');
}

// ── Test 7: compactHistoryIfNeeded with a failing summarizeFn falls back gracefully ──
{
  const msgs = makeMessages(15);
  const result = await compactHistoryIfNeeded({
    messages: msgs,
    contextWindowTokens: 1000,
    summarize: async () => { throw new Error('LLM summarize failed'); },
    systemPrompt: 'You are a summarizer.',
    charsPerTokenUnit: 4,
    pruningSettings: {},
    compactionSettings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
    forceCompaction: true,
  });

  // Even with LLM failure, deterministic fallback should produce a summary
  assert.ok(result.summary, 'fallback must produce a summary');
  assert.ok(result.summary.length > 10, 'fallback summary must be substantive');
  console.log('  [PASS] compactHistoryIfNeeded: LLM failure → deterministic fallback');
}

// ── Test 8: compactHistoryIfNeeded with a working summarizeFn ──
{
  const msgs = makeMessages(15);
  const result = await compactHistoryIfNeeded({
    messages: msgs,
    contextWindowTokens: 1000,
    summarize: async ({ userPrompt }) => `Summarized: ${userPrompt.slice(0, 50)}`,
    systemPrompt: 'You are a summarizer.',
    charsPerTokenUnit: 4,
    pruningSettings: {},
    compactionSettings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
    forceCompaction: true,
  });

  assert.ok(result.summary, 'working summarizeFn → summary');
  assert.ok(result.summaryMessage, 'working summarizeFn → summaryMessage');
  console.log('  [PASS] compactHistoryIfNeeded: working summarizeFn succeeds');
}

// ── Test 9: createCompactionSummaryMessage produces valid user message ──
{
  const summaryMsg = createCompactionSummaryMessage('Test summary content');
  assert.equal(summaryMsg.role, 'user');
  assert.ok(typeof summaryMsg.content === 'string');
  assert.ok(summaryMsg.content.includes('Test summary'));
  console.log('  [PASS] createCompactionSummaryMessage: produces valid user message');
}

// ── Test 10: Smaller-chunks fallback chain ──
{
  const msgs = makeMessages(20);
  // Force a failure on first attempt, success on smaller chunks
  let callCount = 0;
  const summarize = async (params) => {
    callCount++;
    if (callCount === 1) throw new Error('first attempt failed');
    return `Partial summary chunk ${callCount}`;
  };

  const result = await compactHistoryIfNeeded({
    messages: msgs,
    contextWindowTokens: 500,
    summarize,
    systemPrompt: 'Summarizer.',
    charsPerTokenUnit: 4,
    pruningSettings: {},
    compactionSettings: { enabled: true, reserveTokens: 50, keepRecentTokens: 50 },
    forceCompaction: true,
  });

  assert.ok(result.summary, 'smaller-chunks fallback must produce a summary');
  console.log('  [PASS] smaller-chunks fallback produces summary');
}

console.log('\n[pass] compaction-fallback: 10/10');
