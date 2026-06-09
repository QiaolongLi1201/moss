#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/default-workflow.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMossDefaultWorkflowPrompt } from '../dist/context/default-workflow.js';
import { buildRuntimeCapabilitiesPrompt, isCodeGraphToolName } from '../dist/context/runtime-capabilities.js';
import { SkillRegistry } from '../dist/skills/index.js';

{
  const prompt = buildMossDefaultWorkflowPrompt();
  assert.match(prompt, /Moss Default Workflow/);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /superpower/);
  assert.match(prompt, /CodeGraph/);
  assert.match(prompt, /failing test/i);
  assert.match(prompt, /existing user data/);
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-default-skills-'));
  try {
    const registry = new SkillRegistry({ workspaceDir: workspace });
    const skills = registry.list();
    assert(skills.some((skill) => skill.name === 'superpower-methodical-builder'));
    assert(skills.some((skill) => skill.name === 'superpower-systematic-debugging'));
    assert(skills.some((skill) => skill.name === 'codegraph-structural-navigation'));
    assert(skills.some((skill) => skill.name === 'moss-upgrade-and-migration-contract'));
    assert.deepEqual(
      registry.matchByText('use codegraph to find callers').map((skill) => skill.name),
      ['codegraph-structural-navigation'],
    );
    assert.deepEqual(
      registry.matchByText('plan a workspace path migration without losing user data').map((skill) => skill.name),
      ['moss-upgrade-and-migration-contract'],
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

{
  const prompt = buildRuntimeCapabilitiesPrompt({
    tools: [{ name: 'read_file' }, { name: 'search_code' }, { name: 'codegraph__codegraph_search' }],
    mcpEnabled: true,
    mcpServerNames: ['codegraph'],
  });
  assert.match(prompt, /Runtime Capabilities/);
  assert.match(prompt, /read_file, search_code/);
  assert.match(prompt, /CodeGraph: available/);
  assert.equal(isCodeGraphToolName('codegraph_search'), true);
  assert.equal(isCodeGraphToolName('codegraph__search'), true);
  assert.equal(isCodeGraphToolName('codegraph__codegraph_search'), true);
  assert.equal(isCodeGraphToolName('server__codegraph_search'), true);
  assert.equal(isCodeGraphToolName('search_code'), false);
}

{
  const prompt = buildRuntimeCapabilitiesPrompt({
    tools: [{ name: 'read_file' }],
    mcpEnabled: false,
  });
  assert.match(prompt, /CodeGraph: unavailable/);
  assert.match(prompt, /read_file/);
  assert.doesNotMatch(prompt, /search_code/);
}

console.log('[PASS] default Moss workflow prompt and built-in skills are available');
