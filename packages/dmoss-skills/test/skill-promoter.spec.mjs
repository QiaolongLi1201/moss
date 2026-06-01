#!/usr/bin/env node
/**
 * Skill promoter unit tests — file system operations.
 *
 * Run:
 *   npm run build -w @rdk-moss/skills
 *   node packages/dmoss-skills/test/skill-promoter.spec.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  writeSkillCandidate,
  getCandidatesRoot,
} from '../dist/skill-candidate-store.js';
import { promoteSkillCandidate } from '../dist/skill-promoter.js';
import { MOSS_SKILL_META_FILE } from '../dist/skill-metadata.js';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-promoter-'));

// ─── promoteSkillCandidate: basic promotion ───────────────────────

{
  // First, write a candidate
  const writeResult = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'promote-session-1',
    turnHash: 'ph1',
    gate: 'strict',
    toolCalls: [
      { name: 'read', input: { path: '/tmp/test' }, failed: false },
      { name: 'write', input: { path: '/tmp/out' }, failed: false },
    ],
    userMessage: 'promote test basic workflow',
    assistantText: 'completed successfully',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  const candidateId = writeResult.candidateId;

  // Now promote it
  const result = await promoteSkillCandidate({
    workspaceDir: tmpDir,
    candidateId,
    confidence: 0.75,
  });

  assert.ok(result, 'promotion should return a result');
  assert.ok(result.skillId, 'should have skillId');
  assert.ok(result.skillPath, 'should have skillPath');
  assert.equal(result.candidateId, candidateId);
  assert.equal(result.confidence, 0.75);
  assert.ok(result.promotedAt > 0, 'should have promotedAt timestamp');
  assert.equal(result.validation.valid, true, 'validation should pass');

  // Verify skill file was written
  const skillContent = await fs.readFile(result.skillPath, 'utf-8');
  assert.match(skillContent, /---/);
  assert.match(skillContent, /name:/);

  // Verify metadata file was written
  const skillDir = path.dirname(result.skillPath);
  const metaPath = path.join(skillDir, MOSS_SKILL_META_FILE);
  const metaRaw = await fs.readFile(metaPath, 'utf-8');
  const meta = JSON.parse(metaRaw);
  assert.equal(meta.sourceKind, 'conversation');
  assert.equal(meta.status, 'promoted');
  assert.equal(meta.sourceCandidateId, candidateId);
  assert.equal(meta.sourceSessionKey, 'promote-session-1');
  assert.equal(meta.confidence, 0.75);

  // Verify candidate was removed
  const candidatesRoot = getCandidatesRoot(tmpDir);
  const candidateDir = path.join(candidatesRoot, candidateId);
  try {
    await fs.access(candidateDir);
    assert.fail('candidate directory should have been removed');
  } catch {
    // Expected: directory should not exist
  }

  console.log('  [PASS] promoteSkillCandidate basic promotion');
}

// ─── promoteSkillCandidate: nonexistent candidate returns null ────

{
  const result = await promoteSkillCandidate({
    workspaceDir: tmpDir,
    candidateId: 'nonexistent-candidate-xyz',
  });
  assert.equal(result, null, 'should return null for nonexistent candidate');
  console.log('  [PASS] promoteSkillCandidate returns null for nonexistent candidate');
}

// ─── promoteSkillCandidate: onPromoted callback ───────────────────

{
  // Write a new candidate
  const writeResult = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'promote-callback',
    turnHash: 'pcb1',
    gate: 'strict',
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    userMessage: 'promote test callback',
    assistantText: 'done',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  let callbackCalled = false;
  let callbackResult = null;

  const result = await promoteSkillCandidate({
    workspaceDir: tmpDir,
    candidateId: writeResult.candidateId,
    onPromoted: (r) => {
      callbackCalled = true;
      callbackResult = r;
    },
  });

  assert.equal(callbackCalled, true, 'onPromoted callback should be called');
  assert.equal(callbackResult.skillId, result.skillId);
  console.log('  [PASS] promoteSkillCandidate onPromoted callback');
}

// ─── promoteSkillCandidate: sanitizes skill ID ────────────────────

{
  // Write a candidate that will produce a special-character ID
  const writeResult = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'promote-sanitize',
    turnHash: 'ps1',
    gate: 'strict',
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    userMessage: 'promote test SANITIZE id',
    assistantText: 'done',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  const result = await promoteSkillCandidate({
    workspaceDir: tmpDir,
    candidateId: writeResult.candidateId,
  });

  // skillId should be lowercase, no special chars
  assert.equal(result.skillId, result.skillId.toLowerCase());
  assert.ok(!/[A-Z]/.test(result.skillId), 'skillId should be lowercase');
  assert.ok(result.skillId.length <= 64, 'skillId should be <= 64 chars');
  console.log('  [PASS] promoteSkillCandidate sanitizes skill ID');
}

// ─── promoteSkillCandidate: generates markdown from evidence if no draft ──

{
  // Write a candidate but don't create a SKILL.draft.md
  const writeResult = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'promote-gen-md',
    turnHash: 'pgm1',
    gate: 'strict',
    toolCalls: [
      { name: 'read', input: { path: '/tmp/test' }, failed: false },
      { name: 'exec', input: { command: 'ls' }, failed: false },
    ],
    userMessage: 'promote test generate markdown from evidence',
    assistantText: 'generated markdown test',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  // Ensure no draft exists
  const candidatesRoot = getCandidatesRoot(tmpDir);
  const draftPath = path.join(candidatesRoot, writeResult.candidateId, 'SKILL.draft.md');
  try {
    await fs.unlink(draftPath);
  } catch {
    // Expected: no draft
  }

  const result = await promoteSkillCandidate({
    workspaceDir: tmpDir,
    candidateId: writeResult.candidateId,
  });

  assert.ok(result, 'should succeed even without draft');
  assert.equal(result.validation.valid, true);

  // The generated markdown should contain tool steps
  const skillContent = await fs.readFile(result.skillPath, 'utf-8');
  assert.match(skillContent, /read/);
  assert.match(skillContent, /exec/);
  console.log('  [PASS] promoteSkillCandidate generates markdown from evidence');
}

// ─── Cleanup ──────────────────────────────────────────────────────

await fs.rm(tmpDir, { recursive: true, force: true });

console.log('\nAll skill-promoter tests passed.');
