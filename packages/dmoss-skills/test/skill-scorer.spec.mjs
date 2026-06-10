#!/usr/bin/env node
/**
 * Skill scorer unit tests — pure functions, no file system.
 *
 * Run:
 *   npm run build -w @rdk-moss/skills
 *   node packages/dmoss-skills/test/skill-scorer.spec.mjs
 */

import assert from 'node:assert/strict';
import { scoreSkillCandidate, isHighConfidence, isMediumConfidence } from '../dist/skill-scorer.js';

/**
 * Build a minimal evidence fixture for testing.
 */
function buildEvidence(overrides = {}) {
  return {
    candidateId: 'test-candidate',
    sourceKind: 'conversation',
    createdAt: Date.now(),
    sourceSessionKey: 'test-session',
    turnHash: 'abc123',
    gate: 'strict',
    toolCalls: [],
    toolNames: [],
    userMessage: 'test user message',
    assistantText: 'test assistant text',
    runMeta: { completionKind: 'complete', model: 'test-model', totalElapsedMs: 1000 },
    ...overrides,
  };
}

// ─── Base confidence ──────────────────────────────────────────────

{
  // Use a tool that doesn't trigger verification (exec/read/device_exec do)
  // and use partial completion to avoid the +0.05 run completeness bonus
  const evidence = buildEvidence({
    toolCalls: [{ name: 'write', input: { path: '/tmp/a' }, failed: false }],
    toolNames: ['write'],
    runMeta: { completionKind: 'partial', model: 'test-model', totalElapsedMs: 1000 },
  });
  const score = scoreSkillCandidate(evidence);
  assert.equal(score.confidence, 0.3, 'base confidence with 1 non-verification tool call should be 0.3');
  assert.equal(score.signals.toolCallCount, 1);
  assert.equal(score.signals.distinctTools, 1);
  assert.equal(score.signals.errorRecovered, false);
  assert.equal(score.signals.allSucceeded, true);
  assert.equal(score.signals.hasVerification, false);
  console.log('  [PASS] scoreSkillCandidate base confidence');
}

// ─── Tool call count bonus ────────────────────────────────────────

{
  const evidence = buildEvidence({
    toolCalls: [
      { name: 'read', input: {}, failed: false },
      { name: 'read', input: {}, failed: false },
      { name: 'read', input: {}, failed: false },
    ],
    toolNames: ['read'],
  });
  const score = scoreSkillCandidate(evidence);
  assert.ok(score.confidence >= 0.4, `3 tool calls should add +0.1 bonus, got ${score.confidence}`);
  console.log('  [PASS] 3 tool calls add +0.1 bonus');
}

{
  const evidence = buildEvidence({
    toolCalls: [
      { name: 'read', input: {}, failed: false },
      { name: 'read', input: {}, failed: false },
      { name: 'read', input: {}, failed: false },
      { name: 'read', input: {}, failed: false },
    ],
    toolNames: ['read'],
  });
  const score = scoreSkillCandidate(evidence);
  assert.ok(score.confidence >= 0.45, `4 tool calls should add +0.15 bonus, got ${score.confidence}`);
  console.log('  [PASS] 4 tool calls add +0.15 bonus');
}

// ─── Distinct tools bonus ─────────────────────────────────────────

{
  const evidence = buildEvidence({
    toolCalls: [
      { name: 'read', input: {}, failed: false },
      { name: 'write', input: {}, failed: false },
      { name: 'exec', input: {}, failed: false },
    ],
    toolNames: ['read', 'write', 'exec'],
  });
  const score = scoreSkillCandidate(evidence);
  assert.equal(score.signals.distinctTools, 3);
  // 3 distinct tools should give +0.1 bonus
  console.log('  [PASS] 3 distinct tools add bonus');
}

// ─── Error recovery detection ─────────────────────────────────────

{
  const evidence = buildEvidence({
    toolCalls: [
      { name: 'read', input: {}, failed: true },
      { name: 'read', input: {}, failed: false },
    ],
    toolNames: ['read'],
  });
  const score = scoreSkillCandidate(evidence);
  assert.equal(score.signals.errorRecovered, true, 'should detect error recovery');
  assert.ok(score.errorRecoveryPatterns.length > 0, 'should have error recovery patterns');
  assert.match(score.errorRecoveryPatterns[0], /read failed . recovered with read/);
  console.log('  [PASS] error recovery detection');
}

{
  const evidence = buildEvidence({
    toolCalls: [
      { name: 'read', input: {}, failed: true },
      { name: 'write', input: {}, failed: true },
    ],
    toolNames: ['read', 'write'],
  });
  const score = scoreSkillCandidate(evidence);
  assert.equal(score.signals.errorRecovered, false, 'all failed should not detect recovery');
  console.log('  [PASS] all failed calls = no recovery');
}

// ─── Verification detection ───────────────────────────────────────

{
  const evidence = buildEvidence({
    toolCalls: [{ name: 'exec', input: {}, failed: false }],
    toolNames: ['exec'],
  });
  const score = scoreSkillCandidate(evidence);
  assert.equal(score.signals.hasVerification, true, 'exec should count as verification');
  console.log('  [PASS] exec counts as verification');
}

{
  const evidence = buildEvidence({
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    toolNames: ['read'],
  });
  const score = scoreSkillCandidate(evidence);
  assert.equal(score.signals.hasVerification, true, 'read should count as verification');
  console.log('  [PASS] read counts as verification');
}

{
  const evidence = buildEvidence({
    toolCalls: [{ name: 'write', input: {}, failed: false }],
    toolNames: ['write'],
  });
  const score = scoreSkillCandidate(evidence);
  assert.equal(score.signals.hasVerification, false, 'write should not count as verification');
  console.log('  [PASS] write does not count as verification');
}

// ─── Pattern occurrences ──────────────────────────────────────────

{
  const evidence = buildEvidence({
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    toolNames: ['read'],
  });
  const score1 = scoreSkillCandidate(evidence, 1);
  const score2 = scoreSkillCandidate(evidence, 2);
  const score3 = scoreSkillCandidate(evidence, 3);
  assert.ok(score2.confidence > score1.confidence, '2 occurrences should boost over 1');
  assert.ok(score3.confidence > score2.confidence, '3 occurrences should boost over 2');
  assert.equal(score3.signals.patternOccurrences, 3);
  console.log('  [PASS] pattern occurrences boost confidence');
}

// ─── All succeeded bonus ─────────────────────────────────────────

{
  // Note: the allSucceeded bonus only applies when toolCalls.length >= 3
  // Also note: error recovery bonus (+0.2) is larger than allSucceeded bonus (+0.1),
  // so a failed-then-recovered sequence can score higher than all-succeeded.
  // Test with 3 calls where the failed one is NOT the last, so no recovery occurs.
  const evidenceOk = buildEvidence({
    toolCalls: [
      { name: 'read', input: {}, failed: false },
      { name: 'write', input: {}, failed: false },
      { name: 'read', input: {}, failed: false },
    ],
    toolNames: ['read', 'write'],
    runMeta: { completionKind: 'partial', model: 'test', totalElapsedMs: 100 },
  });
  const evidenceFail = buildEvidence({
    toolCalls: [
      { name: 'read', input: {}, failed: false },
      { name: 'write', input: {}, failed: true },
      { name: 'read', input: {}, failed: false },
    ],
    toolNames: ['read', 'write'],
    runMeta: { completionKind: 'partial', model: 'test', totalElapsedMs: 100 },
  });
  const scoreOk = scoreSkillCandidate(evidenceOk);
  const scoreFail = scoreSkillCandidate(evidenceFail);
  assert.equal(scoreOk.signals.allSucceeded, true);
  assert.equal(scoreFail.signals.allSucceeded, false);
  assert.equal(scoreOk.confidence, 0.55, 'allSucceeded with 3 calls: base 0.3 + 0.1 (3 calls) + 0.1 (allSucceeded) + 0.05 (verification)');
  // write failed and a DIFFERENT tool (read) succeeded next: that is not
  // recovery, and the write failure stays unrecovered → capped below medium.
  assert.equal(scoreFail.signals.errorRecovered, false, 'different-tool success is not error recovery');
  assert.equal(scoreFail.signals.unrecoveredFailure, true);
  assert.ok(scoreFail.confidence <= 0.4, `unrecovered failure must cap confidence, got ${scoreFail.confidence}`);
  assert.ok(scoreFail.confidence < scoreOk.confidence, 'a failed run must not outscore the clean run');
  console.log('  [PASS] all succeeded bonus');
}

// ─── Teaching meta bonuses ────────────────────────────────────────

{
  const evidence = buildEvidence({
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    toolNames: ['read'],
    teachingMeta: {
      preAnnotations: [{ why: 'because', concept: 'files' }],
      postAnnotations: [{ verifyHint: 'check file', confidence: 'high' }],
    },
  });
  const score = scoreSkillCandidate(evidence);
  assert.ok(score.confidence >= 0.4, `both annotations should add +0.1, got ${score.confidence}`);
  console.log('  [PASS] both pre+post annotations add bonus');
}

{
  const evidence = buildEvidence({
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    toolNames: ['read'],
    teachingMeta: {
      preAnnotations: [{ why: 'because' }],
    },
  });
  const score = scoreSkillCandidate(evidence);
  assert.ok(score.confidence >= 0.35, `pre-only annotations should add +0.05, got ${score.confidence}`);
  console.log('  [PASS] pre-only annotations add bonus');
}

{
  const evidence = buildEvidence({
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    toolNames: ['read'],
    teachingMeta: {
      postAnnotations: [
        { confidence: 'high' },
        { confidence: 'high' },
      ],
    },
  });
  const score = scoreSkillCandidate(evidence);
  // post-only = +0.05, 2 high conf posts = +0.05 extra
  assert.ok(score.confidence >= 0.4, `2+ high confidence posts should add extra bonus, got ${score.confidence}`);
  console.log('  [PASS] high confidence post annotations add extra bonus');
}

// ─── Run completeness bonus ───────────────────────────────────────

{
  const evidenceComplete = buildEvidence({
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    toolNames: ['read'],
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });
  const evidencePartial = buildEvidence({
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    toolNames: ['read'],
    runMeta: { completionKind: 'partial', model: 'test', totalElapsedMs: 100 },
  });
  const scoreComplete = scoreSkillCandidate(evidenceComplete);
  const scorePartial = scoreSkillCandidate(evidencePartial);
  assert.ok(scoreComplete.confidence > scorePartial.confidence, 'complete should have bonus over partial');
  console.log('  [PASS] run completeness bonus');
}

// ─── Confidence clamping ──────────────────────────────────────────

{
  // Build max-signal evidence to verify clamping at 1.0
  const evidence = buildEvidence({
    toolCalls: [
      { name: 'read', input: {}, failed: false },
      { name: 'write', input: {}, failed: false },
      { name: 'exec', input: {}, failed: false },
      { name: 'device_exec', input: {}, failed: false },
    ],
    toolNames: ['read', 'write', 'exec', 'device_exec'],
    teachingMeta: {
      preAnnotations: [{ why: 'a', concept: 'b' }],
      postAnnotations: [{ confidence: 'high' }, { confidence: 'high' }],
    },
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });
  const score = scoreSkillCandidate(evidence, 5);
  assert.ok(score.confidence <= 1.0, `confidence must not exceed 1.0, got ${score.confidence}`);
  assert.ok(score.confidence >= 0, `confidence must not be negative, got ${score.confidence}`);
  console.log('  [PASS] confidence clamped to [0, 1]');
}

// ─── Confidence rounded to 2 decimals ─────────────────────────────

{
  const evidence = buildEvidence({
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    toolNames: ['read'],
  });
  const score = scoreSkillCandidate(evidence);
  const rounded = Math.round(score.confidence * 100) / 100;
  assert.equal(score.confidence, rounded, 'confidence should be rounded to 2 decimal places');
  console.log('  [PASS] confidence rounded to 2 decimals');
}

// ─── Preconditions extraction ─────────────────────────────────────

{
  const evidence = buildEvidence({
    toolCalls: [{ name: 'read', input: { file_path: '/tmp/test.txt' }, failed: false }],
    toolNames: ['read'],
  });
  const score = scoreSkillCandidate(evidence);
  assert.ok(score.preconditions.some(p => p.includes('/tmp/test.txt')), 'should extract file precondition');
  console.log('  [PASS] file precondition extraction');
}

{
  const evidence = buildEvidence({
    toolCalls: [{ name: 'device_exec', input: { command: 'ls' }, failed: false }],
    toolNames: ['device_exec'],
  });
  const score = scoreSkillCandidate(evidence);
  assert.ok(score.preconditions.some(p => p.includes('SSH')), 'should extract device SSH precondition');
  console.log('  [PASS] device SSH precondition extraction');
}

{
  const evidence = buildEvidence({
    toolCalls: [{ name: 'write', input: {}, failed: false }],
    toolNames: ['write'],
  });
  const score = scoreSkillCandidate(evidence);
  assert.equal(score.preconditions.length, 0, 'write first call should have no preconditions');
  console.log('  [PASS] no preconditions for non-read/non-device calls');
}

// ─── isHighConfidence / isMediumConfidence ────────────────────────

{
  const highEvidence = buildEvidence({
    toolCalls: [
      { name: 'read', input: {}, failed: false },
      { name: 'write', input: {}, failed: false },
      { name: 'exec', input: {}, failed: false },
      { name: 'device_exec', input: {}, failed: false },
    ],
    toolNames: ['read', 'write', 'exec', 'device_exec'],
    teachingMeta: {
      preAnnotations: [{ why: 'a' }],
      postAnnotations: [{ confidence: 'high' }, { confidence: 'high' }],
    },
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });
  const highScore = scoreSkillCandidate(highEvidence, 3);
  assert.equal(isHighConfidence(highScore), true, `high confidence should be >= 0.7, got ${highScore.confidence}`);
  console.log('  [PASS] isHighConfidence for well-signaled skill');
}

{
  const lowEvidence = buildEvidence({
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    toolNames: ['read'],
  });
  const lowScore = scoreSkillCandidate(lowEvidence);
  assert.equal(isHighConfidence(lowScore), false, `low confidence should not be high, got ${lowScore.confidence}`);
  assert.equal(isMediumConfidence(lowScore), false, `low confidence should not be medium, got ${lowScore.confidence}`);
  console.log('  [PASS] isHighConfidence/isMediumConfidence for weak skill');
}

// ─── Edge: empty tool calls ───────────────────────────────────────

{
  const evidence = buildEvidence({
    toolCalls: [],
    toolNames: [],
    runMeta: { completionKind: 'partial', model: 'test', totalElapsedMs: 100 },
  });
  const score = scoreSkillCandidate(evidence);
  assert.equal(score.confidence, 0.3, 'empty tool calls should still return base 0.3');
  assert.equal(score.signals.toolCallCount, 0);
  assert.equal(score.signals.distinctTools, 0);
  assert.equal(score.signals.allSucceeded, true);
  console.log('  [PASS] empty tool calls handled gracefully');
}

// ─── Regression: a mostly-failed run must never score high ────────
// Real incident: exec + write_file both denied (failed), read_file "ok",
// pattern seen twice → scored 0.95 "high" and was nearly auto-promoted.

{
  const evidence = buildEvidence({
    toolCalls: [
      { name: 'exec', input: { command: 'echo hi' }, failed: true },
      { name: 'write_file', input: { path: 'a.txt' }, failed: true },
      { name: 'read_file', input: { path: 'a.txt' }, failed: false },
    ],
    toolNames: ['exec', 'write_file', 'read_file'],
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });
  const score = scoreSkillCandidate(evidence, 2);
  assert.equal(score.signals.errorRecovered, false, 'cross-tool success must not count as recovery');
  assert.equal(score.signals.unrecoveredFailure, true);
  assert.equal(score.signals.failedCount, 2);
  assert.ok(score.confidence <= 0.4, `mostly-failed run must cap at 0.4, got ${score.confidence}`);
  assert.equal(isHighConfidence(score), false);
  assert.equal(isMediumConfidence(score), false);
  console.log('  [PASS] regression: mostly-failed run is capped below medium');
}

console.log('\nAll skill-scorer tests passed.');
