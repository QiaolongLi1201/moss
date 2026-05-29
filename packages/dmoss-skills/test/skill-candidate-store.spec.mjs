#!/usr/bin/env node
/**
 * Skill candidate store unit tests — file system operations.
 *
 * Run:
 *   npm run build -w @rdk-moss/skills
 *   node packages/dmoss-skills/test/skill-candidate-store.spec.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  writeSkillCandidate,
  listCandidates,
  removeCandidate,
  getCandidatesRoot,
} from '../dist/skill-candidate-store.js';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-candidate-store-'));

// ─── getCandidatesRoot ────────────────────────────────────────────

{
  const root = getCandidatesRoot(tmpDir);
  assert.equal(root, path.join(tmpDir, 'skill-candidates'));
  console.log('  [PASS] getCandidatesRoot returns correct path');
}

// ─── writeSkillCandidate: basic write ─────────────────────────────

{
  const result = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'test-session-1',
    turnHash: 'hash1',
    gate: 'strict',
    toolCalls: [
      { name: 'read', input: { path: '/tmp/a' }, failed: false },
      { name: 'write', input: { path: '/tmp/b' }, failed: false },
    ],
    userMessage: 'test user message for candidate write',
    assistantText: 'test assistant text',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });
  assert.ok(result, 'writeSkillCandidate should return a result');
  assert.ok(result.candidateId, 'should have candidateId');
  assert.ok(result.path, 'should have path');
  assert.equal(result.isNew, true, 'first write should be isNew');

  // Verify file was written
  const raw = await fs.readFile(result.path, 'utf-8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.sourceKind, 'conversation');
  assert.equal(parsed.gate, 'strict');
  assert.deepEqual(parsed.toolNames, ['read', 'write']);
  console.log('  [PASS] writeSkillCandidate basic write');
}

// ─── writeSkillCandidate: rejects empty tool calls ────────────────

{
  const result = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'test-session-2',
    turnHash: 'hash2',
    gate: 'strict',
    toolCalls: [],
    userMessage: 'test user message',
    assistantText: 'test assistant text',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });
  assert.equal(result, null, 'should return null for empty tool calls');
  console.log('  [PASS] writeSkillCandidate rejects empty tool calls');
}

// ─── writeSkillCandidate: redacts sensitive fields ────────────────

{
  const result = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'test-session-redact',
    turnHash: 'hash_redact',
    gate: 'strict',
    toolCalls: [
      { name: 'exec', input: { api_key: 'secret123', token: 'tok456', path: '/safe' }, failed: false },
    ],
    userMessage: 'test redaction',
    assistantText: 'done',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });
  const raw = await fs.readFile(result.path, 'utf-8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.toolCalls[0].input.api_key, '[redacted]');
  assert.equal(parsed.toolCalls[0].input.token, '[redacted]');
  assert.equal(parsed.toolCalls[0].input.path, '/safe');
  console.log('  [PASS] writeSkillCandidate redacts sensitive input fields');
}

// ─── writeSkillCandidate: custom slug ─────────────────────────────

{
  const result = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'test-session-slug',
    turnHash: 'hash_slug',
    gate: 'intent',
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    userMessage: 'test custom slug',
    assistantText: 'done',
    customSlug: 'my-custom-skill',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });
  assert.ok(result.candidateId.startsWith('my-custom-skill'), `candidateId should start with slug, got: ${result.candidateId}`);
  console.log('  [PASS] writeSkillCandidate with custom slug');
}

// ─── writeSkillCandidate: deduplication ───────────────────────────

{
  const dedupWorkspace = path.join(tmpDir, 'dedup-test');
  // First write
  const first = await writeSkillCandidate({
    workspaceDir: dedupWorkspace,
    sessionKey: 'dedup-session',
    turnHash: 'dedup-hash',
    gate: 'strict',
    toolCalls: [
      { name: 'read', input: {}, failed: false },
      { name: 'write', input: {}, failed: false },
    ],
    userMessage: 'first write for dedup test',
    assistantText: 'done',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  // Second write with same session, turnHash, toolNames
  const second = await writeSkillCandidate({
    workspaceDir: dedupWorkspace,
    sessionKey: 'dedup-session',
    turnHash: 'dedup-hash',
    gate: 'strict',
    toolCalls: [
      { name: 'read', input: {}, failed: false },
      { name: 'write', input: {}, failed: false },
    ],
    userMessage: 'second write for dedup test',
    assistantText: 'done again',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  assert.equal(second.isNew, false, 'dedup write should not be isNew');
  assert.ok(second.dedupedFrom, 'should have dedupedFrom');
  assert.equal(second.candidateId, first.candidateId, 'dedup should reuse candidateId');
  console.log('  [PASS] writeSkillCandidate deduplication');
}

// ─── listCandidates: basic listing ────────────────────────────────

{
  const listWorkspace = path.join(tmpDir, 'list-test');
  await writeSkillCandidate({
    workspaceDir: listWorkspace,
    sessionKey: 'list-s1',
    turnHash: 'lh1',
    gate: 'strict',
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    userMessage: 'list test alpha',
    assistantText: 'done',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });
  await writeSkillCandidate({
    workspaceDir: listWorkspace,
    sessionKey: 'list-s2',
    turnHash: 'lh2',
    gate: 'intent',
    toolCalls: [{ name: 'write', input: {}, failed: false }],
    userMessage: 'list test beta',
    assistantText: 'done',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  const all = await listCandidates(listWorkspace);
  assert.equal(all.length, 2, 'should list 2 candidates');
  // Should be sorted by createdAt desc
  assert.ok(all[0].createdAt >= all[1].createdAt, 'should be sorted by createdAt desc');
  console.log('  [PASS] listCandidates basic listing');
}

// ─── listCandidates: filter by gate ───────────────────────────────

{
  const listWorkspace = path.join(tmpDir, 'list-filter-gate');
  await writeSkillCandidate({
    workspaceDir: listWorkspace,
    sessionKey: 'fg-s1',
    turnHash: 'fgh1',
    gate: 'strict',
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    userMessage: 'filter gate test strict',
    assistantText: 'done',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });
  await writeSkillCandidate({
    workspaceDir: listWorkspace,
    sessionKey: 'fg-s2',
    turnHash: 'fgh2',
    gate: 'intent',
    toolCalls: [{ name: 'write', input: {}, failed: false }],
    userMessage: 'filter gate test intent',
    assistantText: 'done',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  const strictOnly = await listCandidates(listWorkspace, { gate: 'strict' });
  assert.equal(strictOnly.length, 1);
  assert.equal(strictOnly[0].gate, 'strict');

  const intentOnly = await listCandidates(listWorkspace, { gate: 'intent' });
  assert.equal(intentOnly.length, 1);
  assert.equal(intentOnly[0].gate, 'intent');
  console.log('  [PASS] listCandidates filter by gate');
}

// ─── listCandidates: filter by toolName ───────────────────────────

{
  const listWorkspace = path.join(tmpDir, 'list-filter-tool');
  await writeSkillCandidate({
    workspaceDir: listWorkspace,
    sessionKey: 'ft-s1',
    turnHash: 'fth1',
    gate: 'strict',
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    userMessage: 'filter tool test read',
    assistantText: 'done',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });
  await writeSkillCandidate({
    workspaceDir: listWorkspace,
    sessionKey: 'ft-s2',
    turnHash: 'fth2',
    gate: 'strict',
    toolCalls: [{ name: 'exec', input: {}, failed: false }],
    userMessage: 'filter tool test exec',
    assistantText: 'done',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  const readOnly = await listCandidates(listWorkspace, { toolName: 'read' });
  assert.equal(readOnly.length, 1);
  assert.ok(readOnly[0].toolNames.includes('read'));

  const execOnly = await listCandidates(listWorkspace, { toolName: 'exec' });
  assert.equal(execOnly.length, 1);
  assert.ok(execOnly[0].toolNames.includes('exec'));

  const missing = await listCandidates(listWorkspace, { toolName: 'nonexistent' });
  assert.equal(missing.length, 0);
  console.log('  [PASS] listCandidates filter by toolName');
}

// ─── listCandidates: empty directory ──────────────────────────────

{
  const emptyWorkspace = path.join(tmpDir, 'empty-list');
  const results = await listCandidates(emptyWorkspace);
  assert.equal(results.length, 0, 'should return empty for nonexistent dir');
  console.log('  [PASS] listCandidates handles empty/missing directory');
}

// ─── removeCandidate ──────────────────────────────────────────────

{
  const rmWorkspace = path.join(tmpDir, 'rm-test');
  const result = await writeSkillCandidate({
    workspaceDir: rmWorkspace,
    sessionKey: 'rm-s1',
    turnHash: 'rmh1',
    gate: 'strict',
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    userMessage: 'remove candidate test',
    assistantText: 'done',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });

  const before = await listCandidates(rmWorkspace);
  assert.equal(before.length, 1);

  const removed = await removeCandidate(rmWorkspace, result.candidateId);
  assert.equal(removed, true);

  const after = await listCandidates(rmWorkspace);
  assert.equal(after.length, 0);
  console.log('  [PASS] removeCandidate removes candidate');
}

// ─── removeCandidate: nonexistent ─────────────────────────────────

{
  const removed = await removeCandidate(tmpDir, 'nonexistent-candidate-xyz');
  assert.equal(removed, true, 'removing nonexistent should still return true (rm force)');
  console.log('  [PASS] removeCandidate handles nonexistent gracefully');
}

// ─── writeSkillCandidate: truncates long messages ─────────────────

{
  const longMsg = 'x'.repeat(800);
  const longAssistant = 'y'.repeat(900);
  const result = await writeSkillCandidate({
    workspaceDir: tmpDir,
    sessionKey: 'trunc-session',
    turnHash: 'trunc-hash',
    gate: 'strict',
    toolCalls: [{ name: 'read', input: {}, failed: false }],
    userMessage: longMsg,
    assistantText: longAssistant,
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 100 },
  });
  const raw = await fs.readFile(result.path, 'utf-8');
  const parsed = JSON.parse(raw);
  assert.ok(parsed.userMessage.length <= 600, `userMessage should be truncated to 600, got ${parsed.userMessage.length}`);
  assert.ok(parsed.assistantText.length <= 700, `assistantText should be truncated to 700, got ${parsed.assistantText.length}`);
  console.log('  [PASS] writeSkillCandidate truncates long messages');
}

// ─── Cleanup ──────────────────────────────────────────────────────

await fs.rm(tmpDir, { recursive: true, force: true });

console.log('\nAll skill-candidate-store tests passed.');
