import { test } from 'node:test';
import assert from 'node:assert';
import { SkillLearner } from '../dist/skill-learner.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

test('extractToolCalls does not falsely attribute unmatched errors to last call', async () => {
  const testDir = join(tmpdir(), `skills-${Date.now()}`);
  const learner = new SkillLearner({ skillsDir: testDir });
  
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_1', name: 'exec', input: {} },
        { type: 'tool_use', id: 'call_2', name: 'read', input: {} },
        { type: 'tool_use', id: 'call_3', name: 'write', input: {} },
      ]
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', is_error: false },
        { type: 'tool_result', tool_use_id: 'unknown_id_1', is_error: true },
        { type: 'tool_result', tool_use_id: 'call_3', is_error: false },
      ]
    }
  ];
  
  const toolCalls = learner.extractToolCalls(messages);
  
  assert.strictEqual(toolCalls[0].failed, false, 'exec succeeded');
  assert.strictEqual(toolCalls[1].failed, false, 'read should not be marked failed');
  assert.strictEqual(toolCalls[2].failed, false, 'write succeeded');
  
  rmSync(testDir, { recursive: true, force: true });
});
