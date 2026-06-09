#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/install-skill-tool.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installSkillTool, builtinTools } from '../dist/tools/builtin.js';
import { SkillRegistry } from '../dist/skills/index.js';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-install-skill-tool-'));
const workspaceDir = path.join(tmpRoot, 'workspace');
const ctx = { workspaceDir, sessionKey: 'install-skill-tool-test' };

try {
  await fs.mkdir(workspaceDir, { recursive: true });

  assert.equal(builtinTools.some((tool) => tool.name === 'install_skill'), true);

  const result = await installSkillTool.execute({
    name: 'truth-review',
    description: 'Review answers for evidence gaps before finalizing.',
    tags: ['truth', 'review'],
    trigger: ['score current answer', 'evidence gap'],
    risk: 'low',
    permissions: ['workspace_read'],
    approval_level: 'confirm',
    body: [
      '# Truth Review',
      '',
      'Check what was actually verified, what remains inference, and what should be reported as uncertain.',
    ].join('\n'),
  }, ctx);

  assert.match(result, /Installed skill truth-review/);
  assert.match(result, /\.moss\/skills\/truth-review\/SKILL\.md/);

  const skillPath = path.join(workspaceDir, '.moss', 'skills', 'truth-review', 'SKILL.md');
  const raw = await fs.readFile(skillPath, 'utf-8');
  assert.match(raw, /name: truth-review/);
  assert.match(raw, /description: Review answers for evidence gaps before finalizing\./);
  assert.match(raw, /tags: truth, review/);
  assert.match(raw, /permissions: workspace_read/);
  assert.match(raw, /# Truth Review/);

  const registry = new SkillRegistry({ workspaceDir, includeBuiltin: false });
  const installed = registry.reload().find((skill) => skill.name === 'truth-review');
  assert.ok(installed, 'installed skill should be visible through SkillRegistry');
  assert.equal(installed.description, 'Review answers for evidence gaps before finalizing.');
  assert.deepEqual(installed.tags, ['truth', 'review']);
  assert.deepEqual(installed.trigger, ['score current answer', 'evidence gap']);
  assert.equal(installed.risk, 'low');
  assert.equal(installed.permissions.workspaceRead, true);

  const duplicate = await installSkillTool.execute({
    name: 'truth-review',
    description: 'Duplicate should be rejected.',
    body: '# Duplicate',
  }, ctx);
  assert.match(duplicate, /already exists/);
  assert.doesNotMatch(await fs.readFile(skillPath, 'utf-8'), /Duplicate should be rejected/);

  const invalid = await installSkillTool.execute({
    name: '../escape',
    description: 'Bad path',
    body: '# Bad',
  }, ctx);
  assert.match(invalid, /Error:/);
  await assert.rejects(fs.stat(path.join(workspaceDir, '.moss', 'skills', 'escape', 'SKILL.md')), /ENOENT/);
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

console.log('[PASS] install_skill installs SKILL.md into .moss/skills');
