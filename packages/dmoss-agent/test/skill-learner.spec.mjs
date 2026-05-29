#!/usr/bin/env node
/**
 * SkillLearner self-test: confidence scoring, dedup, and pattern detection.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/skill-learner.spec.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkillLearner } from '../dist/core/index.js';

async function makeTmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-learner-spec-'));
  return dir;
}

function makeAssistantMessage(toolCalls, text = '') {
  return {
    role: 'assistant',
    content: [
      ...toolCalls.map((tc, i) => ({
        type: 'tool_use',
        id: `call_${i}`,
        name: tc.name,
        input: tc.input ?? {},
      })),
      ...(text ? [{ type: 'text', text }] : []),
    ],
  };
}

function makeUserToolResult(callIdx, failed = false) {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: `call_${callIdx}`,
        content: failed ? 'error: command failed' : 'ok',
        is_error: failed,
      },
    ],
  };
}

// 1. Insufficient tool calls → no skill learned
{
  const skillsDir = await makeTmpDir();
  const learner = new SkillLearner({ skillsDir });
  const messages = [
    { role: 'user', content: '帮我打开网页 example.com' },
    makeAssistantMessage([{ name: 'web_fetch' }], 'done'),
    makeUserToolResult(0),
  ];
  const skill = await learner.maybeLearnFromSession('s1', messages);
  assert.equal(skill, null, 'single tool call should not produce a skill');
}

// 2. Multi-step success → skill learned (with sufficient confidence)
{
  const skillsDir = await makeTmpDir();
  const learner = new SkillLearner({ skillsDir, minConfidence: 0.3 });
  const messages = [
    { role: 'user', content: '部署 yolo 服务到板端' },
    makeAssistantMessage([{ name: 'read', input: { file_path: 'config.yaml' } }]),
    makeUserToolResult(0),
    makeAssistantMessage([{ name: 'device_exec', input: { command: 'systemctl start yolo' } }]),
    makeUserToolResult(0),
    makeAssistantMessage([{ name: 'device_exec', input: { command: 'curl localhost:8080/health' } }], '部署完成，服务已就绪'),
    makeUserToolResult(0),
  ];
  const skillPath = await learner.maybeLearnFromSession('s2', messages);
  assert.ok(skillPath, 'multi-step success should produce a skill');
  const content = await fs.readFile(skillPath, 'utf-8');
  assert.match(content, /confidence:\s*0\.\d+/, 'skill file must include confidence');
  assert.match(content, /occurrence_count:\s*\d+/, 'skill file must include occurrence count');
  assert.match(content, /tools:[\s\S]*read[\s\S]*device_exec/, 'tools list should include all used tools');
}

// 3. Error recovery pattern → boosts confidence and is recorded
{
  const skillsDir = await makeTmpDir();
  const learner = new SkillLearner({ skillsDir, minConfidence: 0.3 });
  const messages = [
    { role: 'user', content: '修复 ssh 连接问题' },
    makeAssistantMessage([{ name: 'device_exec', input: { command: 'ssh test' } }]),
    makeUserToolResult(0, true),
    makeAssistantMessage([{ name: 'exec', input: { command: 'ssh-keygen -R' } }]),
    makeUserToolResult(0),
    makeAssistantMessage([{ name: 'device_exec', input: { command: 'ssh retry' } }], '已修复连接'),
    makeUserToolResult(0),
  ];
  const skillPath = await learner.maybeLearnFromSession('s3', messages);
  assert.ok(skillPath, 'error recovery flow should produce a skill');
  const content = await fs.readFile(skillPath, 'utf-8');
  assert.match(content, /## Error Recovery/, 'recovery pattern should be captured');
  assert.match(content, /device_exec failed.*recovered with exec/, 'specific recovery pattern format');
}

// 4. Dedup: similar tool chain doesn't create duplicate skill
{
  const skillsDir = await makeTmpDir();
  const learner = new SkillLearner({ skillsDir, minConfidence: 0.3 });
  const baseMessages = [
    { role: 'user', content: '查日志找错' },
    makeAssistantMessage([{ name: 'read', input: { file_path: 'log.txt' } }]),
    makeUserToolResult(0),
    makeAssistantMessage([{ name: 'grep', input: { pattern: 'error' } }]),
    makeUserToolResult(0),
    makeAssistantMessage([{ name: 'exec', input: { command: 'tail -100' } }], '已定位'),
    makeUserToolResult(0),
  ];
  const first = await learner.maybeLearnFromSession('s4a', baseMessages);
  assert.ok(first, 'first instance should be persisted');

  const learner2 = new SkillLearner({ skillsDir, minConfidence: 0.3 });
  const second = await learner2.maybeLearnFromSession('s4b', baseMessages);
  assert.equal(second, null, 'duplicate skill (same tool overlap >= 80%) should be skipped');
}

// 5. listLearnedSkills enumerates persisted skills
{
  const skillsDir = await makeTmpDir();
  const learner = new SkillLearner({ skillsDir, minConfidence: 0.3 });
  const messages = [
    { role: 'user', content: '部署' },
    makeAssistantMessage([{ name: 'read' }]),
    makeUserToolResult(0),
    makeAssistantMessage([{ name: 'write' }]),
    makeUserToolResult(0),
    makeAssistantMessage([{ name: 'exec' }], 'done'),
    makeUserToolResult(0),
  ];
  await learner.maybeLearnFromSession('s5', messages);
  const list = await learner.listLearnedSkills();
  assert.equal(list.length, 1, 'one skill should be listed');
  assert.match(list[0], /\.md$/, 'skill file must end with .md');
}

console.log('[PASS] SkillLearner: confidence, dedup, error recovery, pattern detection');
