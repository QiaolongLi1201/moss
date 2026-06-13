#!/usr/bin/env node
/**
 * Low-value run gate: SkillPipeline must NOT persist trivial info-gathering or
 * clarification turns, but MUST still persist runs with mutating/meaningful work.
 * Run: npm run build -w @rdk-moss/skills && node packages/dmoss-skills/test/skill-pipeline-quality-gate.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SkillPipeline } from '../dist/skill-pipeline.js';

function makeMessages(toolCalls, userText, assistantText) {
  const msgs = [{ role: 'user', content: userText }];
  const assistantContent = [];
  for (const tc of toolCalls) {
    assistantContent.push({
      type: 'tool_use',
      id: `call_${tc.name}_${Math.random().toString(36).slice(2, 8)}`,
      name: tc.name,
      input: tc.input || {},
    });
  }
  assistantContent.push({ type: 'text', text: assistantText });
  msgs.push({ role: 'assistant', content: assistantContent });
  for (const tc of toolCalls) {
    msgs.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: assistantContent.find((b) => b.name === tc.name)?.id || '',
          content: tc.failed ? 'error' : 'ok',
          is_error: tc.failed || false,
        },
      ],
    });
  }
  return msgs;
}

async function countCandidates(dir) {
  try {
    const entries = await fs.readdir(path.join(dir, '.moss', 'skills', 'candidates'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

// (a) All read-only info-gathering ending in a clarifying question → skip.
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-gate-a-'));
  const pipeline = new SkillPipeline({ workspaceDir: tmp, model: 'test' });
  const messages = makeMessages(
    [
      { name: 'memory_read', input: { query: 'board ip' } },
      { name: 'read_file', input: { path: '/etc/config' } },
    ],
    'How do I connect to the board?',
    'Which board are you targeting — the RDK X5 or the X3?',
  );
  const result = await pipeline.processSession('gate-a', messages);
  assert.equal(result, null, 'clarifying-question turn must not persist a candidate');
  assert.equal(await countCandidates(tmp), 0, 'no candidate dir should be written');
  await fs.rm(tmp, { recursive: true, force: true });
  console.log('  [PASS] skips all-readonly run that ends in a clarifying question');
}

// (b) All read-only info-gathering, declarative final text → still skip.
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-gate-b-'));
  const pipeline = new SkillPipeline({ workspaceDir: tmp, model: 'test' });
  const messages = makeMessages(
    [
      { name: 'read_file', input: { path: '/a' } },
      { name: 'search_code', input: { query: 'foo' } },
    ],
    'Where is foo defined?',
    'foo is defined in src/foo.ts.',
  );
  const result = await pipeline.processSession('gate-b', messages);
  assert.equal(result, null, 'all-readonly info-gathering run must not persist a candidate');
  assert.equal(await countCandidates(tmp), 0, 'no candidate dir should be written');
  await fs.rm(tmp, { recursive: true, force: true });
  console.log('  [PASS] skips all-readonly info-gathering run (declarative text)');
}

// (c) Clarifying question even with a mutating tool → skip (task not finished).
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-gate-c-'));
  const pipeline = new SkillPipeline({ workspaceDir: tmp, model: 'test' });
  const messages = makeMessages(
    [
      { name: 'read_file', input: { path: '/a' } },
      { name: 'write_file', input: { path: '/a', content: 'x' } },
    ],
    'Set up the deploy script',
    'Before I continue, should this target staging or production?',
  );
  const result = await pipeline.processSession('gate-c', messages);
  assert.equal(result, null, 'clarifying-question final turn must not persist even with a write');
  await fs.rm(tmp, { recursive: true, force: true });
  console.log('  [PASS] skips clarifying-question turn even with a mutating tool');
}

// (d) Control: read + mutating write, declarative result → STILL persists.
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-gate-d-'));
  const pipeline = new SkillPipeline({ workspaceDir: tmp, model: 'test' });
  const messages = makeMessages(
    [
      { name: 'read_file', input: { path: '/tmp/config.yaml' } },
      { name: 'exec', input: { command: 'cat /tmp/config.yaml' } },
      { name: 'write_file', input: { path: '/tmp/config.yaml', content: 'updated' } },
    ],
    'Update the config file on the device',
    'Done. The config file has been updated successfully.',
  );
  const result = await pipeline.processSession('gate-d', messages);
  assert.ok(result, 'a run with mutating work and a declarative result must still persist');
  assert.ok(result.candidateId, 'should have a candidateId');
  assert.ok(await countCandidates(tmp) >= 1, 'a candidate dir should be written');
  await fs.rm(tmp, { recursive: true, force: true });
  console.log('  [PASS] still persists runs with mutating/meaningful work');
}

console.log('\nAll skill-pipeline quality-gate tests passed.');
