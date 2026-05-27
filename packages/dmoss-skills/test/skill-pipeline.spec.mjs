#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SkillPipeline } from '../dist/skill-pipeline.js';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-pipeline-'));

function makeMessages(toolCalls, userText, assistantText) {
  const msgs = [];
  msgs.push({ role: 'user', content: userText });
  const assistantContent = [];
  for (const tc of toolCalls) {
    assistantContent.push({
      type: 'tool_use',
      id: `call_${tc.name}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
          content: tc.failed ? 'error: failed' : 'ok',
          is_error: tc.failed || false,
        },
      ],
    });
  }
  return msgs;
}

// ─── Test 1: pipeline skips sessions with < 2 tool calls ───
{
  const pipeline = new SkillPipeline({ workspaceDir: tmpDir, model: 'test-model' });
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: { path: '/tmp' } }, { type: 'text', text: 'done' }] },
  ];
  const result = await pipeline.processSession('short-session', messages);
  assert.equal(result, null, 'should return null for < 2 tool calls');
  console.log('  [PASS] pipeline skips sessions with < 2 tool calls');
}

// ─── Test 2: pipeline writes candidate and distills ───
{
  const pipeline = new SkillPipeline({ workspaceDir: tmpDir, model: 'test-model' });
  const messages = makeMessages(
    [
      { name: 'read', input: { path: '/tmp/config.yaml' } },
      { name: 'exec', input: { command: 'cat /tmp/config.yaml' } },
      { name: 'write', input: { path: '/tmp/config.yaml', content: 'updated' } },
    ],
    'Update the config file on the device',
    'Done. The config file has been updated successfully.',
  );
  const result = await pipeline.processSession('pipeline-session-1', messages);
  assert.ok(result, 'should return a result');
  assert.ok(result.candidateId, 'should have candidateId');
  assert.ok(result.candidatePath, 'should have candidatePath');
  assert.ok(result.distill, 'should have distill result');
  assert.ok(result.distill.score, 'should have score');
  assert.ok(typeof result.distill.score.confidence === 'number', 'confidence should be a number');
  console.log(`  [PASS] pipeline writes candidate and distills (confidence=${result.distill.score.confidence})`);
}

// ─── Test 3: pipeline auto-promotes high confidence (with patternOccurrences >= 2) ───
{
  const pipeline = new SkillPipeline({ workspaceDir: tmpDir, model: 'test-model', autoPromoteHighConfidence: true });
  const toolPattern = [
    { name: 'read', input: { path: '/src/main.py' } },
    { name: 'exec', input: { command: 'python3 /src/main.py' } },
    { name: 'read', input: { path: '/src/output.log' } },
    { name: 'write', input: { path: '/src/main.py', content: 'fixed' } },
    { name: 'exec', input: { command: 'python3 /src/main.py' } },
  ];
  const firstMessages = makeMessages(
    toolPattern,
    'Debug and fix the Python script that crashes on startup',
    'Done. The script was missing an import statement. Added it and verified the script runs successfully.',
  );
  await pipeline.processSession('pipeline-session-2a', firstMessages);

  const messages = makeMessages(
    toolPattern.map((tc) => ({ ...tc, input: { ...tc.input } })),
    'Debug and fix the Python script that crashes on startup again',
    'Done. Fixed another import issue and verified the script runs.',
  );
  const result = await pipeline.processSession('pipeline-session-2b', messages);
  assert.ok(result, 'should return a result');
  assert.ok(result.distill, 'should have distill result');
  if (result.distill.score.confidence >= 0.7) {
    assert.ok(result.promoted, 'high confidence with patternOccurrences >= 2 should auto-promote');
    assert.ok(result.promoted.skillPath, 'promoted results should have skillPath');
    const skillExists = await fs.access(result.promoted.skillPath).then(() => true).catch(() => false);
    assert.ok(skillExists, 'promoted SKILL.md should exist on disk');
    console.log(`  [PASS] pipeline auto-promotes high confidence (${result.distill.score.confidence})`);
  } else {
    assert.equal(result.promoted, null, 'below threshold should not promote');
    console.log(`  [PASS] pipeline correctly skips promote for medium confidence (${result.distill.score.confidence})`);
  }
}

// ─── Test 4: pipeline with autoPromoteHighConfidence=false ───
{
  const pipeline = new SkillPipeline({ workspaceDir: tmpDir, model: 'test-model', autoPromoteHighConfidence: false });
  const messages = makeMessages(
    [
      { name: 'device_exec', input: { command: 'ls /opt/hobot' } },
      { name: 'device_file_read', input: { path: '/opt/hobot/config' } },
      { name: 'write', input: { path: '/tmp/deploy.sh', content: '#!/bin/bash' } },
    ],
    'Deploy the application to the RDK board',
    'Done. Application deployed successfully to the board.',
  );
  const result = await pipeline.processSession('pipeline-session-3', messages);
  assert.ok(result, 'should return a result');
  assert.equal(result.promoted, null, 'autoPromote=false should never promote');
  console.log('  [PASS] pipeline respects autoPromoteHighConfidence=false');
}

// ─── Test 5: pipeline skips when no user message ───
{
  const pipeline = new SkillPipeline({ workspaceDir: tmpDir, model: 'test-model' });
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }, { type: 'tool_use', id: 'c2', name: 'exec', input: {} }, { type: 'text', text: 'done' }] },
  ];
  const result = await pipeline.processSession('no-user-msg', messages);
  assert.equal(result, null, 'should return null when no user message');
  console.log('  [PASS] pipeline skips when no user message');
}

// ─── Cleanup ───
await fs.rm(tmpDir, { recursive: true, force: true });

console.log('\nAll skill-pipeline integration tests passed.');
