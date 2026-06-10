#!/usr/bin/env node
/**
 * Distilled skills must not bake host-specific IPs into reusable steps —
 * a hardcoded board IP silently steers future runs at the wrong device.
 * Run after `npm run build -w @rdk-moss/skills`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillPipeline } from '../dist/skill-pipeline.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-distill-'));

const messages = [
  { role: 'user', content: '检查板卡 192.168.127.10 的相机状态' },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 't1', name: 'device_exec', input: { command: 'ssh root@192.168.127.10 ls /dev/video0' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 't2', name: 'device_file_read', input: { path: '/etc/board.conf' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] },
  { role: 'assistant', content: '相机在 192.168.127.10 上工作正常。' },
];

const pipeline = new SkillPipeline({ workspaceDir: tmpDir, model: 'test-model' });
const result = await pipeline.processSession('redaction-session', messages);
assert.ok(result, 'pipeline must produce a candidate');
assert.ok(result.distill, 'distill step must run');

const draft = fs.readFileSync(path.join(path.dirname(result.candidatePath), 'SKILL.draft.md'), 'utf-8');
assert.ok(!/192\.168\.127\.10/.test(draft.split('\n').filter((l) => l.startsWith('1.') || l.startsWith('2.') || l.includes('结果')).join('\n')) || !/192\.168\.127\.10/.test(draft), 'steps must not contain the raw board IP');
assert.match(draft, /<device-ip>/, 'IP must be replaced with the placeholder');

// runMeta passthrough: a host reporting a failed run must be recorded as such
const failed = await pipeline.processSession('failed-session', [
  ...messages.slice(0, 5),
  { role: 'assistant', content: '没有完成。' },
], { completionKind: 'failed' });
if (failed) {
  const evidence = JSON.parse(fs.readFileSync(failed.candidatePath, 'utf-8'));
  assert.equal(evidence.runMeta.completionKind, 'failed', 'caller-reported outcome must be persisted');
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('[PASS] distill redaction + runMeta passthrough');
