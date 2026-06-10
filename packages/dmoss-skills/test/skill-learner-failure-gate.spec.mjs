#!/usr/bin/env node
/**
 * Regressions for the conversation SkillLearner (learned/ pipeline):
 *  1. A run where most tool calls FAILED must not be saved as a learned skill
 *     (a 3-of-5-failed run used to score 0.75 and land in learned/).
 *  2. Cross-tool success after a failure is NOT error recovery.
 *  3. A post-compaction synthetic summary must never become the skill's
 *     user-request text (used to produce "the-conversation-history-before-…").
 *
 * Run:
 *   npm run build -w @rdk-moss/skills
 *   node packages/dmoss-skills/test/skill-learner-failure-gate.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkillLearner } from '../dist/skill-learner.js';
import { isCompactionSummaryText } from '../dist/llm-message.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-learner-gate-'));

function toolUse(id, name, input = {}) {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] };
}
function toolResult(id, content, isError) {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] };
}

// ── 1. mostly-failed run is rejected ──────────────────────────────
{
  const learner = new SkillLearner({ skillsDir: path.join(tmp, 'a') });
  const messages = [
    { role: 'user', content: 'set up the memory entries' },
    toolUse('t1', 'memory_write', { content: 'x' }),
    toolResult('t1', 'missing required parameter "content"', true),
    toolUse('t2', 'memory_read', { q: 'x' }),
    toolResult('t2', 'missing required parameter "query"', true),
    toolUse('t3', 'memory_delete', { key: 'x' }),
    toolResult('t3', 'missing required parameter "id"', true),
    toolUse('t4', 'install_skill', { name: 's', description: 'd', body: 'b' }),
    toolResult('t4', 'Installed skill s', false),
    toolUse('t5', 'subagent_status', { taskId: 'x' }),
    toolResult('t5', 'no such task', false),
    { role: 'assistant', content: 'Done — everything finished successfully.' },
  ];
  const saved = await learner.maybeLearnFromSession('sess-failures', messages);
  assert.equal(saved, null, `mostly-failed run must not be learned, got ${saved}`);
  console.log('  [PASS] mostly-failed run is not saved to learned/');
}

// ── 2. compaction summary is not the user request ─────────────────
{
  assert.equal(
    isCompactionSummaryText('The conversation history before this point was compacted into the following summary:\n\n<summary>…'),
    true,
  );
  assert.equal(isCompactionSummaryText('build the demo project'), false);

  const learner = new SkillLearner({ skillsDir: path.join(tmp, 'b'), minConfidence: 0.1 });
  const messages = [
    {
      role: 'user',
      content:
        'The conversation history before this point was compacted into the following summary:\n\n<summary>\nbuilt files\n</summary>',
    },
    { role: 'user', content: '[Steering] Extended tool loop detected — you have made many calls.' },
    { role: 'user', content: '<dmoss_working_context_checkpoint version="1">state</dmoss_working_context_checkpoint>' },
    { role: 'user', content: 'LONG: build the demo project step by step' },
    toolUse('t1', 'exec', { command: 'echo a' }),
    toolResult('t1', 'a', false),
    toolUse('t2', 'write_file', { path: 'a.txt', content: 'x' }),
    toolResult('t2', 'ok', false),
    toolUse('t3', 'read_file', { path: 'a.txt' }),
    toolResult('t3', 'x', false),
    { role: 'assistant', content: 'Done — project built successfully.' },
  ];
  const saved = await learner.maybeLearnFromSession('sess-compacted', messages);
  assert.ok(saved, 'clean run should be learned');
  const md = await fs.readFile(saved, 'utf8');
  assert.doesNotMatch(md, /conversation-history-before/i, 'skill name must not come from the summary');
  assert.doesNotMatch(md, /steering/i, 'skill name must not come from steering injections');
  assert.match(md, /build the demo project/i, 'skill should reference the real user request');
  console.log('  [PASS] synthetic user messages never become the skill request text');
}

await fs.rm(tmp, { recursive: true, force: true });
console.log('[PASS] skill-learner failure gates');
