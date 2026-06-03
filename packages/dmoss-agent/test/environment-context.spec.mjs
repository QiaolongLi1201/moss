#!/usr/bin/env node
/**
 * Test: environment context layer (buildEnvironmentContextLayer) and MOSS.md
 * project-instruction loading via WorkspaceMemory.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildEnvironmentContextLayer } from '../dist/context/environment.js';
import { WorkspaceMemory } from '../dist/core/memory/workspace-memory.js';

const fixedNow = () => new Date('2026-06-04T12:00:00Z');

console.log('[TEST] environment layer on a non-git directory');
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-env-'));
  await fs.writeFile(path.join(dir, 'README.md'), 'x');
  await fs.mkdir(path.join(dir, 'src'));
  const out = await buildEnvironmentContextLayer(dir, { now: fixedNow });
  assert.match(out, /# Environment/);
  assert.match(out, /Working directory:/);
  assert.match(out, /Platform:/);
  assert.match(out, /Today's date: 2026-06-04/);
  assert.match(out, /Top-level entries:.*README\.md/);
  assert.match(out, /Top-level entries:.*src\//);
  assert.match(out, /not a git repository/);
  await fs.rm(dir, { recursive: true, force: true });
}

console.log('[TEST] environment layer surfaces git branch, status, and commits');
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-envgit-'));
  const run = (a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  run(['init', '-q']);
  run(['config', 'user.email', 't@example.com']);
  run(['config', 'user.name', 'tester']);
  await fs.writeFile(path.join(dir, 'a.txt'), '1');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'initial commit']);
  await fs.writeFile(path.join(dir, 'b.txt'), '2'); // uncommitted

  const out = await buildEnvironmentContextLayer(dir, { now: fixedNow });
  assert.match(out, /Git branch:/, 'should report the current branch');
  assert.match(out, /Git status: 1 uncommitted change/, 'should count uncommitted changes');
  assert.match(out, /b\.txt/, 'should list the changed file');
  assert.match(out, /Recent commits:/);
  assert.match(out, /initial commit/, 'should include recent commit subject');
  await fs.rm(dir, { recursive: true, force: true });
}

console.log('[TEST] includeGit=false skips git probing');
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-envnog-'));
  const out = await buildEnvironmentContextLayer(dir, { now: fixedNow, includeGit: false });
  assert.doesNotMatch(out, /Git/, 'no git lines when includeGit is false');
  await fs.rm(dir, { recursive: true, force: true });
}

console.log('[TEST] WorkspaceMemory loads MOSS.md as project instructions');
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-md-'));
  await fs.writeFile(path.join(dir, 'MOSS.md'), '# My Project\nAlways use pnpm.');
  await fs.writeFile(path.join(dir, 'AGENTS.md'), 'Follow repo conventions.');
  const wm = new WorkspaceMemory({ workspaceDir: dir });
  const ctx = await wm.loadContext();
  assert.ok(ctx.projectInstructions?.includes('Always use pnpm'), 'MOSS.md should populate projectInstructions');
  assert.ok(ctx.agentRules?.includes('Follow repo conventions'), 'AGENTS.md should still load');
  const layer = wm.buildPromptLayer(ctx);
  assert.match(layer, /## Project Instructions \(MOSS\.md\)/);
  assert.match(layer, /Always use pnpm/);
  assert.ok(
    layer.indexOf('Project Instructions') < layer.indexOf('Agent Rules'),
    'project instructions should lead the workspace context',
  );
  await fs.rm(dir, { recursive: true, force: true });
}

console.log('\n[PASS] environment + MOSS.md context tests');
