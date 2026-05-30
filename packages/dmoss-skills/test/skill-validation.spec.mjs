#!/usr/bin/env node
/**
 * Skill validation unit tests — pure functions, no file system.
 *
 * Run:
 *   npm run build -w @rdk-moss/skills
 *   node packages/dmoss-skills/test/skill-validation.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  mergeSkillFrontmatterDefaults,
  validateSkillContent,
  generateSkillTemplate,
} from '../dist/skill-validation.js';

// ─── validateSkillContent: empty content ──────────────────────────

{
  const result = validateSkillContent('');
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('不能为空')));
  console.log('  [PASS] empty content is invalid');
}

{
  const result = validateSkillContent('   ');
  assert.equal(result.valid, false);
  console.log('  [PASS] whitespace-only content is invalid');
}

// ─── validateSkillContent: missing frontmatter ────────────────────

{
  const result = validateSkillContent('# My Skill\n\nSome body text here.');
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('缺少 YAML frontmatter')));
  console.log('  [PASS] missing frontmatter is invalid');
}

// ─── validateSkillContent: minimal valid skill ────────────────────

{
  const md = `---
name: test-skill
description: A valid skill description that is long enough to pass the minimum length check.
version: 1.0.0
trigger: test, skill
risk: low
permissions: workspace_read
delegate_preference: local
requires_board: false
approval_level: none
cooldown_seconds: 0
scheduler_template: none
category: Conversation
---

# Test Skill

## 执行流程
1. Step one
2. Step two
3. Verify result
`;
  const result = validateSkillContent(md);
  assert.equal(result.valid, true, `expected valid, got errors: ${JSON.stringify(result.errors)}`);
  console.log('  [PASS] minimal valid skill passes validation');
}

// ─── validateSkillContent: missing required fields ────────────────

{
  const md = `---
name: test-skill
description: A valid skill description that is long enough.
version: 1.0.0
---

# Test Skill

## 执行流程
1. Step one with enough content to pass body check.
`;
  const result = validateSkillContent(md);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('trigger')));
  assert.ok(result.errors.some(e => e.includes('risk')));
  assert.ok(result.errors.some(e => e.includes('permissions')));
  console.log('  [PASS] missing required fields detected');
}

// ─── validateSkillContent: description too short ──────────────────

{
  const md = `---
name: test-skill
description: Too short.
version: 1.0.0
trigger: test, skill
risk: low
permissions: workspace_read
delegate_preference: local
requires_board: false
approval_level: none
cooldown_seconds: 0
scheduler_template: none
category: Conversation
---

# Test Skill

## 执行流程
1. Step one with enough content to pass body check.
`;
  const result = validateSkillContent(md);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('太短')));
  console.log('  [PASS] short description is rejected');
}

// ─── validateSkillContent: invalid enum values ────────────────────

{
  const md = `---
name: test-skill
description: A valid skill description that is long enough to pass.
version: 1.0.0
trigger: test, skill
risk: extreme
permissions: workspace_read
delegate_preference: local
requires_board: false
approval_level: none
cooldown_seconds: 0
scheduler_template: none
category: Conversation
---

# Test Skill

## 执行流程
1. Step one with enough content to pass body check.
`;
  const result = validateSkillContent(md);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('risk') && e.includes('无效')));
  console.log('  [PASS] invalid risk value is rejected');
}

{
  const md = `---
name: test-skill
description: A valid skill description that is long enough to pass.
version: 1.0.0
trigger: test, skill
risk: low
permissions: workspace_read
delegate_preference: teleport
requires_board: false
approval_level: none
cooldown_seconds: 0
scheduler_template: none
category: Conversation
---

# Test Skill

## 执行流程
1. Step one with enough content to pass body check.
`;
  const result = validateSkillContent(md);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('delegate_preference') && e.includes('无效')));
  console.log('  [PASS] invalid delegate_preference is rejected');
}

{
  const md = `---
name: test-skill
description: A valid skill description that is long enough to pass.
version: 1.0.0
trigger: test, skill
risk: low
permissions: workspace_read
delegate_preference: local
requires_board: false
approval_level: maybe
cooldown_seconds: 0
scheduler_template: none
category: Conversation
---

# Test Skill

## 执行流程
1. Step one with enough content to pass body check.
`;
  const result = validateSkillContent(md);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('approval_level') && e.includes('无效')));
  console.log('  [PASS] invalid approval_level is rejected');
}

{
  const md = `---
name: test-skill
description: A valid skill description that is long enough to pass.
version: 1.0.0
trigger: test, skill
risk: high
permissions: workspace_read,device_exec
delegate_preference: board
requires_board: true
approval_level: strict
cooldown_seconds: 0
scheduler_template: none
category: Conversation
---

# Test Skill

## 执行流程
1. Step one with enough content to pass body check.
`;
  const result = validateSkillContent(md);
  assert.equal(result.valid, true, `expected strict approval to pass, got errors: ${JSON.stringify(result.errors)}`);
  console.log('  [PASS] strict approval level is accepted');
}

{
  const md = `---
name: test-skill
description: A valid skill description that is long enough to pass.
version: 1.0.0
trigger: test, skill
risk: medium
permissions: workspace_read,device_exec
delegate_preference: board
requires_board: true
approval_level: auto
cooldown_seconds: 0
scheduler_template: none
category: Conversation
---

# Test Skill

## 执行流程
1. Step one with enough content to pass body check.
`;
  const result = validateSkillContent(md);
  assert.equal(result.valid, true, `expected legacy auto approval to warn, got errors: ${JSON.stringify(result.errors)}`);
  assert.ok(result.warnings.some(e => e.includes('approval_level') && e.includes('遗留别名') && e.includes('confirm')));
  console.log('  [PASS] legacy auto approval level is accepted with warning');
}

// ─── validateSkillContent: camelCase warnings ─────────────────────

{
  const md = `---
name: test-skill
description: A valid skill description that is long enough.
version: 1.0.0
trigger: test, skill
risk: low
permissions: workspace_read
delegatePreference: local
requiresBoard: false
approvalLevel: none
cooldownSeconds: 0
schedulerTemplate: none
category: Conversation
---

# Test Skill

## 执行流程
1. Step one with enough content to pass body check.
`;
  const result = validateSkillContent(md);
  assert.ok(result.warnings.some(w => w.includes('delegatePreference') && w.includes('delegate_preference')));
  console.log('  [PASS] camelCase field warnings generated');
}

// ─── validateSkillContent: trigger warning ────────────────────────

{
  const md = `---
name: test-skill
description: A valid skill description that is long enough.
version: 1.0.0
trigger: onlyonetrigger
risk: low
permissions: workspace_read
delegate_preference: local
requires_board: false
approval_level: none
cooldown_seconds: 0
scheduler_template: none
category: Conversation
---

# Test Skill

## 执行流程
1. Step one with enough content to pass body check.
`;
  const result = validateSkillContent(md);
  assert.ok(result.warnings.some(w => w.includes('少于 2 个')));
  console.log('  [PASS] single trigger keyword warning');
}

// ─── validateSkillContent: body quality warnings ──────────────────

{
  const md = `---
name: test-skill
description: A valid skill description that is long enough.
version: 1.0.0
trigger: test, skill
risk: low
permissions: workspace_read
delegate_preference: local
requires_board: false
approval_level: none
cooldown_seconds: 0
scheduler_template: none
category: Conversation
---

# Short
Tiny.
`;
  const result = validateSkillContent(md);
  assert.ok(result.warnings.some(w => w.includes('正文内容过短')));
  assert.ok(result.warnings.some(w => w.includes('执行流程')));
  console.log('  [PASS] body quality warnings');
}

// ─── validateSkillContent: description starts with weak verbs ────

{
  const md = `---
name: test-skill
description: 帮助用户处理一些事情这是足够长的描述说明.
version: 1.0.0
trigger: test, skill
risk: low
permissions: workspace_read
delegate_preference: local
requires_board: false
approval_level: none
cooldown_seconds: 0
scheduler_template: none
category: Conversation
---

# Test Skill

## 执行流程
1. Step one with enough content to pass body check.
`;
  const result = validateSkillContent(md);
  assert.ok(result.warnings.some(w => w.includes('空泛动词')));
  console.log('  [PASS] weak verb description warning');
}

// ─── mergeSkillFrontmatterDefaults: adds missing fields ───────────

{
  const md = `---
name: my-skill
description: Short.
---

# Body text`;
  const merged = mergeSkillFrontmatterDefaults(md, { skillId: 'my-skill' });
  assert.match(merged, /^---\nname: my-skill/m);
  assert.match(merged, /version: 1\.0\.0/);
  assert.match(merged, /risk: low/);
  assert.match(merged, /delegate_preference: local/);
  assert.match(merged, /scheduler_template: none/);
  // Body should be preserved
  assert.match(merged, /# Body text/);
  console.log('  [PASS] mergeSkillFrontmatterDefaults adds missing fields');
}

// ─── mergeSkillFrontmatterDefaults: preserves existing fields ─────

{
  const md = `---
name: my-skill
description: A good and sufficiently long description here.
version: 2.0.0
trigger: test, skill
risk: medium
permissions: workspace_read,device_exec
delegate_preference: board
requires_board: true
approval_level: confirm
cooldown_seconds: 30
scheduler_template: none
category: Device
---

# Body text`;
  const merged = mergeSkillFrontmatterDefaults(md, { skillId: 'my-skill' });
  assert.match(merged, /version: 2\.0\.0/);
  assert.match(merged, /risk: medium/);
  assert.match(merged, /delegate_preference: board/);
  assert.match(merged, /requires_board: true/);
  console.log('  [PASS] mergeSkillFrontmatterDefaults preserves existing values');
}

// ─── mergeSkillFrontmatterDefaults: no frontmatter ────────────────

{
  const md = `# Just a heading\n\nSome text.`;
  const merged = mergeSkillFrontmatterDefaults(md, { skillId: 'fallback-skill' });
  assert.match(merged, /^---\nname: fallback-skill/);
  assert.match(merged, /# Just a heading/);
  console.log('  [PASS] mergeSkillFrontmatterDefaults handles no frontmatter');
}

// ─── mergeSkillFrontmatterDefaults: preserves extra frontmatter ───

{
  const md = `---
name: my-skill
description: A good and sufficiently long description here.
version: 1.0.0
trigger: test, skill
risk: low
permissions: workspace_read
delegate_preference: local
requires_board: false
approval_level: none
cooldown_seconds: 0
scheduler_template: none
category: Conversation
example_query: test this out
visible_in_empty: false
---

# Body`;
  const merged = mergeSkillFrontmatterDefaults(md, { skillId: 'my-skill' });
  assert.match(merged, /example_query: test this out/);
  assert.match(merged, /visible_in_empty: false/);
  console.log('  [PASS] mergeSkillFrontmatterDefaults preserves extra frontmatter keys');
}

// ─── generateSkillTemplate: basic template ────────────────────────

{
  const md = generateSkillTemplate({
    name: 'test-skill',
    description: 'A test skill that does something useful for testing.',
    category: 'Test',
    requiresBoard: false,
    triggers: ['test', 'skill'],
  });
  assert.match(md, /name: test-skill/);
  assert.match(md, /risk: low/);
  assert.match(md, /delegate_preference: local/);
  assert.match(md, /requires_board: false/);
  assert.match(md, /permissions: workspace_read/);
  assert.match(md, /category: Test/);
  assert.match(md, /trigger: test,skill/);
  assert.match(md, /## 执行流程/);
  assert.match(md, /## 工具映射/);
  assert.match(md, /## 适用场景/);
  assert.match(md, /## 示例/);
  assert.match(md, /## 失败与降级/);
  assert.match(md, /## 禁止事项/);
  // Should NOT have device_exec when requiresBoard is false
  assert.ok(!md.includes('device_exec'), 'should not include device_exec when requiresBoard is false');
  console.log('  [PASS] generateSkillTemplate basic template');
}

// ─── generateSkillTemplate: board skill ───────────────────────────

{
  const md = generateSkillTemplate({
    name: 'board-skill',
    description: 'A board skill that requires device access for testing.',
    category: 'Device',
    requiresBoard: true,
    triggers: ['board', 'device'],
    delegatePreference: 'board',
  });
  assert.match(md, /requires_board: true/);
  assert.match(md, /delegate_preference: board/);
  assert.match(md, /permissions: workspace_read,device_exec/);
  assert.match(md, /已连接 RDK 设备/);
  console.log('  [PASS] generateSkillTemplate board skill');
}

// ─── generateSkillTemplate: custom options ────────────────────────

{
  const md = generateSkillTemplate({
    name: 'custom-skill',
    description: 'A custom skill with explicit options for testing.',
    category: 'Custom',
    requiresBoard: false,
    triggers: ['custom'],
    risk: 'high',
    permissions: ['workspace_read', 'workspace_write', 'network'],
    delegatePreference: 'hybrid',
  });
  assert.match(md, /risk: high/);
  assert.match(md, /permissions: workspace_read,workspace_write,network/);
  assert.match(md, /delegate_preference: hybrid/);
  console.log('  [PASS] generateSkillTemplate with custom options');
}

// ─── generateSkillTemplate: empty triggers fallback ───────────────

{
  const md = generateSkillTemplate({
    name: 'no-trigger-skill',
    description: 'A skill with no triggers specified for testing fallback.',
    category: 'Test',
    requiresBoard: false,
    triggers: [],
  });
  assert.match(md, /trigger: no-trigger-skill/);
  console.log('  [PASS] generateSkillTemplate empty triggers fallback to name');
}

console.log('\nAll skill-validation tests passed.');
