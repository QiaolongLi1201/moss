#!/usr/bin/env node
/**
 * detectSkillLearningIntent unit tests — pure function, no file system.
 *
 * Run:
 *   npm run build -w @dmoss/skills
 *   node packages/dmoss-skills/test/detect-skill-learning-intent.spec.mjs
 */

import assert from 'node:assert/strict';
import { detectSkillLearningIntent } from '../dist/conversation-skill-learner.js';

// ─── No intent ────────────────────────────────────────────────────

{
  const result = detectSkillLearningIntent('help me fix this file');
  assert.equal(result.detected, false);
  console.log('  [PASS] no intent in normal task message');
}

{
  const result = detectSkillLearningIntent('');
  assert.equal(result.detected, false);
  console.log('  [PASS] empty message returns no intent');
}

// ─── Chinese intent patterns ──────────────────────────────────────

{
  const result = detectSkillLearningIntent('把这个流程沉淀为技能');
  assert.equal(result.detected, true);
  console.log('  [PASS] Chinese: 把这个流程沉淀为技能');
}

{
  const result = detectSkillLearningIntent('帮我沉淀这个技能');
  assert.equal(result.detected, true);
  console.log('  [PASS] Chinese: 帮我沉淀这个技能');
}

{
  const result = detectSkillLearningIntent('记住这套流程');
  assert.equal(result.detected, true);
  console.log('  [PASS] Chinese: 记住这套流程');
}

{
  const result = detectSkillLearningIntent('记住这个方法');
  assert.equal(result.detected, true);
  console.log('  [PASS] Chinese: 记住这个方法');
}

{
  const result = detectSkillLearningIntent('请把这个做成skill');
  assert.equal(result.detected, true);
  console.log('  [PASS] Chinese: 请把这个做成skill');
}

{
  const result = detectSkillLearningIntent('把这个流程存为工作流');
  assert.equal(result.detected, true);
  console.log('  [PASS] Chinese: 把这个流程存为工作流');
}

// ─── English intent patterns ──────────────────────────────────────

{
  const result = detectSkillLearningIntent('save this as a skill');
  assert.equal(result.detected, true);
  console.log('  [PASS] English: save this as a skill');
}

{
  const result = detectSkillLearningIntent('persist this workflow as a skill');
  assert.equal(result.detected, true);
  console.log('  [PASS] English: persist this workflow as a skill');
}

{
  const result = detectSkillLearningIntent('turn this into a workflow');
  assert.equal(result.detected, true);
  console.log('  [PASS] English: turn this into a workflow');
}

{
  const result = detectSkillLearningIntent('learn this as a skill');
  assert.equal(result.detected, true);
  console.log('  [PASS] English: learn this as a skill');
}

// ─── Inline patterns ──────────────────────────────────────────────

{
  const result = detectSkillLearningIntent('沉淀技能');
  assert.equal(result.detected, true);
  console.log('  [PASS] inline: 沉淀技能');
}

{
  const result = detectSkillLearningIntent('save this as a skill');
  assert.equal(result.detected, true);
  console.log('  [PASS] inline: save this as a skill');
}

// ─── Custom slug extraction (Chinese) ────────────────────────────

{
  const result = detectSkillLearningIntent('沉淀为 yolo-bench 技能');
  assert.equal(result.detected, true);
  assert.equal(result.customSlug, 'yolo-bench');
  console.log('  [PASS] Chinese slug extraction: yolo-bench');
}

{
  const result = detectSkillLearningIntent('存为 my-skill 技能');
  assert.equal(result.detected, true);
  assert.equal(result.customSlug, 'my-skill');
  console.log('  [PASS] Chinese slug extraction: my-skill');
}

// ─── Custom slug extraction (English) ─────────────────────────────

{
  const result = detectSkillLearningIntent('save as bench-tool skill');
  assert.equal(result.detected, true);
  assert.equal(result.customSlug, 'bench-tool');
  console.log('  [PASS] English slug extraction: bench-tool');
}

{
  const result = detectSkillLearningIntent('persist as my-workflow workflow');
  assert.equal(result.detected, true);
  assert.equal(result.customSlug, 'my-workflow');
  console.log('  [PASS] English slug extraction: my-workflow');
}

// ─── Slug sanitization ────────────────────────────────────────────

{
  const result = detectSkillLearningIntent('沉淀为 MY_SKILL 技能');
  assert.equal(result.detected, true);
  assert.equal(result.customSlug, 'my-skill');
  console.log('  [PASS] slug sanitized to lowercase with hyphens');
}

// ─── No slug extraction when not present ──────────────────────────

{
  const result = detectSkillLearningIntent('把这个流程沉淀为技能');
  assert.equal(result.detected, true);
  assert.equal(result.customSlug, undefined);
  console.log('  [PASS] no slug when not specified');
}

// ─── Edge cases ───────────────────────────────────────────────────

{
  const result = detectSkillLearningIntent('   ');
  assert.equal(result.detected, false);
  console.log('  [PASS] whitespace-only message returns no intent');
}

{
  const result = detectSkillLearningIntent('我想要沉淀这个');
  assert.equal(result.detected, false, '沉淀 alone without 技能/skill should not match zh pattern');
  console.log('  [PASS] 沉淀 without 技能 does not trigger intent');
}

console.log('\nAll detect-skill-learning-intent tests passed.');
