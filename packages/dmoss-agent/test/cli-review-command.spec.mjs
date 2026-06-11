#!/usr/bin/env node
/**
 * /review builds a structured code-review prompt over a diff and submits it as
 * the next turn. Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findRegistryCommand, runRegistryCommand } from '../dist/cli/commands/registry.js';

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(withChange) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-review-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const x = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  if (withChange) fs.writeFileSync(path.join(dir, 'a.js'), 'export const x = 2; // changed\n');
  return dir;
}

function fakeCtx(workspace) {
  const said = [];
  const submitted = [];
  return {
    said, submitted,
    agent: { config: { model: 'qwen3-max', extraPromptLayers: [] }, tools: { size: 0, getAll: () => [], getNames: () => [] } },
    runtime: {}, sessionKey: 'test', workspace, locale: undefined, surface: 'repl',
    say(kind, text) { said.push({ kind, text }); },
    prefillInput() {},
    submitPrompt(text) { submitted.push(text); },
  };
}

{
  const match = findRegistryCommand('/review');
  assert.equal(match?.spec.name, '/review', '/review must resolve in the registry');
  const withArg = findRegistryCommand('/review 42');
  assert.equal(withArg?.spec.name, '/review');
  assert.equal(withArg?.args, '42', 'PR number is parsed as the argument');
}

{
  const dir = makeRepo(true);
  const ctx = fakeCtx(dir);
  try {
    assert.equal(await runRegistryCommand('/review', ctx), true, '/review must be registry-handled');
    assert.equal(ctx.submitted.length, 1, '/review submits exactly one prompt');
    const prompt = ctx.submitted[0];
    assert.match(prompt, /Correctness & bugs/);
    assert.match(prompt, /Security/);
    assert.match(prompt, /Simplification/);
    assert.match(prompt, /Type design/);
    assert.match(prompt, /--- BEGIN DIFF ---/);
    assert.match(prompt, /changed/, 'the working-tree change is included in the diff');
    assert.match(prompt, /--- END DIFF ---/);
    assert.ok(ctx.said.some((s) => /Reviewing local working tree/.test(s.text)), 'announces the review scope');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = makeRepo(false);
  const ctx = fakeCtx(dir);
  try {
    assert.equal(await runRegistryCommand('/review', ctx), true);
    assert.equal(ctx.submitted.length, 0, 'nothing to review → no prompt submitted');
    assert.match(ctx.said[0].text, /No changes to review/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = makeRepo(true);
  const ctx = fakeCtx(dir);
  try {
    assert.equal(await runRegistryCommand('/review not-a-number', ctx), true);
    assert.equal(ctx.submitted.length, 0);
    assert.equal(ctx.said[0].kind, 'error');
    assert.match(ctx.said[0].text, /Usage: \/review/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('[PASS] /review: recognized command builds and submits a structured review prompt');
