#!/usr/bin/env node
/**
 * Skill distiller unit tests — file system operations.
 *
 * Run:
 *   npm run build -w @rdk-moss/skills
 *   node packages/dmoss-skills/test/skill-distiller.spec.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeSkillCandidate, getCandidatesRoot } from '../dist/skill-candidate-store.js';
import { distillCandidate } from '../dist/skill-distiller.js';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-distiller-'));

// ─── distillCandidate: basic distillation ─────────────────────────

{
  const writeResult = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'distill-session-1',
    turnHash: 'dh1',
    gate: 'strict',
    toolCalls: [
      { name: 'read', input: { path: '/tmp/a' }, failed: false },
      { name: 'write', input: { path: '/tmp/b' }, failed: false },
      { name: 'exec', input: { command: 'ls' }, failed: false },
    ],
    userMessage: 'distill test basic workflow for testing',
    assistantText: 'completed the workflow successfully',
    runMeta: { completionKind: 'complete', model: 'test-model', totalElapsedMs: 100 },
  });

  const result = await distillCandidate(tmpDir, writeResult.candidateId);

  assert.ok(result, 'distillCandidate should return a result');
  assert.equal(result.candidateId, writeResult.candidateId);
  assert.ok(result.draftPath, 'should have draftPath');
  assert.ok(result.score, 'should have score');
  assert.ok(result.markdown, 'should have markdown');

  // Verify draft file was written
  const draftContent = await fs.readFile(result.draftPath, 'utf-8');
  assert.equal(draftContent, result.markdown);

  // Verify markdown structure
  assert.match(result.markdown, /---/);
  assert.match(result.markdown, /name:/);
  assert.match(result.markdown, /description:/);
  assert.match(result.markdown, /quality:/);
  assert.match(result.markdown, /confidence:/);
  assert.match(result.markdown, /## 执行流程/);
  assert.match(result.markdown, /## 工具映射/);
  assert.match(result.markdown, /## 沉淀来源/);
  console.log('  [PASS] distillCandidate basic distillation');
}

// ─── distillCandidate: nonexistent candidate returns null ─────────

{
  const result = await distillCandidate(tmpDir, 'nonexistent-candidate-xyz');
  assert.equal(result, null, 'should return null for nonexistent candidate');
  console.log('  [PASS] distillCandidate returns null for nonexistent candidate');
}

// ─── distillCandidate: includes quality label ─────────────────────

{
  // High confidence candidate (many signals)
  const writeResult = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'distill-quality-high',
    turnHash: 'dqh1',
    gate: 'strict',
    toolCalls: [
      { name: 'read', input: {}, failed: false },
      { name: 'write', input: {}, failed: false },
      { name: 'exec', input: {}, failed: false },
      { name: 'device_exec', input: {}, failed: false },
    ],
    userMessage: 'high quality skill test for distillation',
    assistantText: 'completed successfully',
    teachingMeta: {
      preAnnotations: [{ why: 'reason', concept: 'concept' }],
      postAnnotations: [{ confidence: 'high', verifyHint: 'check it' }],
    },
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  const result = await distillCandidate(tmpDir, writeResult.candidateId);
  assert.ok(result);
  assert.ok(result.score.confidence >= 0.5, `expected medium+ confidence, got ${result.score.confidence}`);
  assert.match(result.markdown, /quality: (high|medium)/);
  console.log('  [PASS] distillCandidate includes quality label');
}

// ─── distillCandidate: includes error recovery section ────────────

{
  const writeResult = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'distill-err-recovery',
    turnHash: 'der1',
    gate: 'strict',
    toolCalls: [
      { name: 'read', input: {}, failed: true },
      { name: 'read', input: {}, failed: false },
      { name: 'write', input: {}, failed: false },
    ],
    userMessage: 'error recovery skill test for distillation',
    assistantText: 'recovered and completed successfully',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  const result = await distillCandidate(tmpDir, writeResult.candidateId);
  assert.ok(result);
  assert.ok(result.score.errorRecoveryPatterns.length > 0);
  assert.match(result.markdown, /## 错误恢复模式/);
  console.log('  [PASS] distillCandidate includes error recovery section');
}

// ─── distillCandidate: includes preconditions section ─────────────

{
  const writeResult = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'distill-precond',
    turnHash: 'dp1',
    gate: 'strict',
    toolCalls: [
      { name: 'read', input: { file_path: '/tmp/important.txt' }, failed: false },
      { name: 'write', input: {}, failed: false },
    ],
    userMessage: 'precondition skill test for distillation',
    assistantText: 'completed',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  const result = await distillCandidate(tmpDir, writeResult.candidateId);
  assert.ok(result);
  assert.ok(result.score.preconditions.length > 0);
  assert.match(result.markdown, /## 前置条件/);
  assert.match(result.markdown, /important\.txt/);
  console.log('  [PASS] distillCandidate includes preconditions section');
}

// ─── distillCandidate: includes teaching annotations ──────────────

{
  const writeResult = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'distill-teaching',
    turnHash: 'dt1',
    gate: 'strict',
    toolCalls: [
      { name: 'read', input: {}, failed: false },
      { name: 'write', input: {}, failed: false },
    ],
    userMessage: 'teaching annotation skill test',
    assistantText: 'completed',
    teachingMeta: {
      preAnnotations: [{ why: 'this is why', concept: 'this is the concept', pitfalls: ['pitfall1', 'pitfall2'] }],
      postAnnotations: [{ verifyHint: 'verify this', confidence: 'high', nextStepIfFails: 'retry', rollbackHint: 'undo it' }],
    },
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  const result = await distillCandidate(tmpDir, writeResult.candidateId);
  assert.ok(result);
  assert.match(result.markdown, /## 教学注解/);
  assert.match(result.markdown, /### 执行要点/);
  assert.match(result.markdown, /### 验证与恢复/);
  assert.match(result.markdown, /this is why/);
  assert.match(result.markdown, /verify this/);
  console.log('  [PASS] distillCandidate includes teaching annotations');
}

// ─── distillCandidate: infers risk from tool names ────────────────

{
  const writeResult = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'distill-risk',
    turnHash: 'dr1',
    gate: 'strict',
    toolCalls: [
      { name: 'device_exec', input: {}, failed: false },
      { name: 'delete', input: {}, failed: false },
    ],
    userMessage: 'risky skill test for distillation',
    assistantText: 'completed',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  const result = await distillCandidate(tmpDir, writeResult.candidateId);
  assert.ok(result);
  assert.match(result.markdown, /risk: medium/);
  assert.match(result.markdown, /approval_level: confirm/);
  console.log('  [PASS] distillCandidate infers risk from tool names');
}

// ─── Regression: host-side exec must not imply a board ────────────
// Bare `exec`/`write_file`/`read_file` are host tools; requires_board used to
// flip to true (and delegate_preference to board) for every shell-using skill.

{
  const writeResult = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'distill-host-exec',
    turnHash: 'he1',
    gate: 'strict',
    toolCalls: [
      { name: 'exec', input: { command: 'echo hi' }, failed: false },
      { name: 'write_file', input: { path: 'a.txt' }, failed: false },
      { name: 'read_file', input: { path: 'a.txt' }, failed: false },
    ],
    userMessage: 'host-only exec skill',
    assistantText: 'completed',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  const result = await distillCandidate(tmpDir, writeResult.candidateId);
  assert.ok(result);
  assert.match(result.markdown, /requires_board: false/);
  assert.match(result.markdown, /delegate_preference: local/);
  assert.doesNotMatch(result.markdown, /permissions: [^\n]*device_exec/);
  console.log('  [PASS] regression: host exec does not imply requires_board');
}

// ─── Regression: failed steps must not be described as error-free ─

{
  const writeResult = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'distill-failed-run',
    turnHash: 'fr1',
    gate: 'strict',
    toolCalls: [
      { name: 'exec', input: { command: 'echo hi' }, failed: true },
      { name: 'write_file', input: { path: 'a.txt' }, failed: true },
      { name: 'read_file', input: { path: 'a.txt' }, failed: false },
    ],
    userMessage: 'failed run skill',
    assistantText: 'claimed done',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  const result = await distillCandidate(tmpDir, writeResult.candidateId);
  assert.ok(result);
  assert.doesNotMatch(result.markdown, /quality: high/);
  assert.doesNotMatch(result.markdown, /无错误/);
  assert.doesNotMatch(result.markdown, /成功工具链/);
  assert.match(result.markdown, /工具步骤失败/);
  console.log('  [PASS] regression: failed run is not described as error-free');
}

// ─── Cleanup ──────────────────────────────────────────────────────

await fs.rm(tmpDir, { recursive: true, force: true });

console.log('\nAll skill-distiller tests passed.');
