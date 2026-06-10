#!/usr/bin/env node
/**
 * Candidate-id traversal guard tests.
 *
 * Regression for the `'.'` gap: the guards rejected `/`, `\` and `..` but let
 * a bare `'.'` through. `path.join(candidatesRoot, '.')` resolves to the
 * candidates root itself, so `removeCandidate(ws, '.')` recursively deleted
 * EVERY candidate, and `promoteSkillCandidate({ candidateId: '.' })` could do
 * the same after promoting a stray root-level candidate.json.
 *
 * Run:
 *   npm run build -w @rdk-moss/skills
 *   node packages/dmoss-skills/test/candidate-id-guard.spec.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  writeSkillCandidate,
  removeCandidate,
  getCandidatesRoot,
} from '../dist/skill-candidate-store.js';
import { promoteSkillCandidate } from '../dist/skill-promoter.js';

function makeCandidateInput(workspaceDir, n) {
  return {
    workspaceDir,
    sessionKey: `guard-session-${n}`,
    turnHash: `gh${n}`,
    gate: 'strict',
    toolCalls: [
      { name: 'read', input: { path: '/tmp/in' }, failed: false },
      { name: 'write', input: { path: '/tmp/out' }, failed: false },
    ],
    userMessage: `guard test workflow ${n}`,
    assistantText: 'completed successfully',
    runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 50 },
  };
}

// ─── removeCandidate('.') must throw and leave the store intact ───

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-guard-'));
  const { candidateId } = await writeSkillCandidate(makeCandidateInput(tmpDir, 1));
  const candidatesRoot = getCandidatesRoot(tmpDir);

  await assert.rejects(
    () => removeCandidate(tmpDir, '.'),
    /Invalid candidate ID/,
    "removeCandidate('.') must be rejected as an invalid id",
  );

  const survivor = path.join(candidatesRoot, candidateId, 'candidate.json');
  await fs.access(survivor); // throws if the store was wiped
  console.log('  [PASS] removeCandidate(".") rejected, store intact');
}

// ─── promoteSkillCandidate with '.' must throw, even with a stray root candidate.json ───

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-guard-'));
  const { candidateId } = await writeSkillCandidate(makeCandidateInput(tmpDir, 2));
  const candidatesRoot = getCandidatesRoot(tmpDir);

  // Simulate the dangerous state: a stray candidate.json at the candidates
  // root makes '.' look like a real candidate directory.
  const realCandidateJson = await fs.readFile(
    path.join(candidatesRoot, candidateId, 'candidate.json'),
    'utf-8',
  );
  await fs.writeFile(path.join(candidatesRoot, 'candidate.json'), realCandidateJson, 'utf-8');

  await assert.rejects(
    () => promoteSkillCandidate({ workspaceDir: tmpDir, candidateId: '.' }),
    /Invalid candidate ID/,
    "promoteSkillCandidate('.') must be rejected as an invalid id",
  );

  const survivor = path.join(candidatesRoot, candidateId, 'candidate.json');
  await fs.access(survivor); // throws if promote('.') wiped the root
  console.log('  [PASS] promoteSkillCandidate(".") rejected, store intact');
}

// ─── concurrent writeSkillCandidate: no torn candidate.json, no leaked .tmp ───

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-guard-'));
  const input = makeCandidateInput(tmpDir, 3);
  const results = await Promise.all(
    Array.from({ length: 12 }, () => writeSkillCandidate(input)),
  );
  const ids = new Set(results.map((r) => r.candidateId));
  assert.equal(ids.size, 1, 'identical input must dedupe to one candidate id');

  const candidatesRoot = getCandidatesRoot(tmpDir);
  const candidateDir = path.join(candidatesRoot, [...ids][0]);
  const body = await fs.readFile(path.join(candidateDir, 'candidate.json'), 'utf-8');
  JSON.parse(body); // throws if a concurrent write tore the file

  const leftovers = (await fs.readdir(candidateDir)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'no temp files may survive concurrent writes');
  console.log('  [PASS] concurrent writeSkillCandidate keeps candidate.json whole');
}

console.log('candidate-id-guard: all tests passed');
