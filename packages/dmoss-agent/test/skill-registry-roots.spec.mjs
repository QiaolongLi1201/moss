#!/usr/bin/env node
/**
 * SkillRegistry extra-root discovery + frontmatter robustness.
 * Run: npm run build -w @rdk-moss/agent && node packages/dmoss-agent/test/skill-registry-roots.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SkillRegistry,
  resolveDefaultSkillRoots,
  expandTilde,
} from '../dist/skills/index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skill-roots-'));
function writeSkill(dir, name, frontmatter, body = 'do the thing') {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`);
  return path.join(skillDir, 'SKILL.md');
}

let failures = 0;
const test = (label, fn) => {
  try { fn(); process.stderr.write(`  ok  ${label}\n`); }
  catch (err) { failures++; process.stderr.write(`  FAIL ${label}\n       ${err?.stack?.split('\n').slice(0,3).join('\n       ') ?? err}\n`); }
};

test('expandTilde resolves ~ and ~/ to home', () => {
  const home = '/home/tester';
  assert.equal(expandTilde('~', home), home);
  assert.equal(expandTilde('~/.claude/skills', home), path.join(home, '.claude/skills'));
  assert.equal(expandTilde('/abs/path', home), '/abs/path');
});

test('resolveDefaultSkillRoots tilde-expands, keeps only existing dirs, dedupes', () => {
  const home = tmp;
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  // ~/.agents/skills intentionally absent → dropped.
  const roots = resolveDefaultSkillRoots(undefined, home);
  assert.deepEqual(roots, [path.join(home, '.claude', 'skills')]);
  // Duplicate + nonexistent entries collapse / drop.
  const custom = resolveDefaultSkillRoots(
    ['~/.claude/skills', path.join(home, '.claude', 'skills'), '~/does/not/exist'],
    home,
  );
  assert.deepEqual(custom, [path.join(home, '.claude', 'skills')]);
  // An explicit empty array is honored (no home defaults scanned).
  assert.deepEqual(resolveDefaultSkillRoots([], home), []);
});

test('an extra root SKILL.md is discovered', () => {
  const ws = fs.mkdtempSync(path.join(tmp, 'ws-'));
  const extra = fs.mkdtempSync(path.join(tmp, 'extra-'));
  writeSkill(extra, 'remote-helper', 'name: remote-helper\ndescription: A helper from another agent');
  const reg = new SkillRegistry({ workspaceDir: ws, extraDirs: [extra] });
  const names = reg.list().map((s) => s.name);
  assert.ok(names.includes('remote-helper'), `extra-root skill should appear; saw ${names}`);
});

test('the same SKILL.md path is parsed once (dedupe by resolved path)', () => {
  const ws = fs.mkdtempSync(path.join(tmp, 'ws2-'));
  const skillsDir = path.join(ws, '.moss', 'skills');
  const file = writeSkill(skillsDir, 'dup', 'name: dup\ndescription: only once');
  const reg = new SkillRegistry({
    workspaceDir: ws,
    extraDirs: [skillsDir], // duplicate source (same path reachable two ways)
    includeBuiltin: false,
  });
  const dups = reg.list().filter((s) => path.resolve(s.sourcePath) === path.resolve(file));
  assert.equal(dups.length, 1, 'the same SKILL.md path must be parsed exactly once');
});

test('frontmatter: surrounding quotes stripped, nested YAML ignored', () => {
  const ws = fs.mkdtempSync(path.join(tmp, 'ws3-'));
  const extra = fs.mkdtempSync(path.join(tmp, 'extra3-'));
  writeSkill(
    extra,
    'fancy',
    [
      'name: "fancy-skill"',
      "description: 'Quoted description with: a colon'",
      'metadata:',
      '  author: someone',
      '  nested: should-not-leak',
      'allowed-tools:',
      '  - read_file',
      'risk: high',
    ].join('\n'),
  );
  const reg = new SkillRegistry({ workspaceDir: ws, extraDirs: [extra], includeBuiltin: false });
  const skill = reg.list().find((s) => s.name === 'fancy-skill');
  assert.ok(skill, 'quoted name should be unquoted to fancy-skill');
  assert.equal(skill.description, 'Quoted description with: a colon');
  assert.equal(skill.risk, 'high', 'top-level keys after a nested block still parse');
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) { console.error(`[FAIL] ${failures} skill-registry-root tests failed`); process.exit(1); }
console.log('[PASS] SkillRegistry extra-root discovery + frontmatter robustness');
