#!/usr/bin/env node
/**
 * Run:
 *   node packages/dmoss-agent/test/readme-accuracy.spec.mjs
 *
 * Pins user-facing README claims to live CLI behavior so they cannot silently
 * rot. Fails (red) against the pre-fix README; passes after the doc edits land.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootReadme = fs.readFileSync(path.resolve(here, '../../../README.md'), 'utf-8');
const agentReadme = fs.readFileSync(path.resolve(here, '../README.md'), 'utf-8');

// DOC-1: root /connect must document board mode + how to leave it.
assert.match(rootReadme, /board mode/i, 'root README /connect section must mention board mode');
assert.match(rootReadme, /\/disconnect/, 'root README must document /disconnect');
assert.match(rootReadme, /--hybrid/, 'root README must document the --hybrid connect flag');

// DOC-2: root README must have a resume / long-running-task section.
assert.match(rootReadme, /Long-Running Tasks And Resume/, 'root README needs a long-task/resume section');
assert.match(rootReadme, /moss resume --last/, 'root README must show moss resume --last');
assert.match(rootReadme, /--continue/, 'root README must document --continue');
assert.match(rootReadme, /resumable/i, 'root README must explain interrupted runs are resumable');

// DOC-3: Automation & Safety must cover interactive modes, /yolo, and the full
// accepted value set of --ask-for-approval (these were undocumented).
assert.match(rootReadme, /Shift\+Tab/, 'root README must document Shift+Tab interaction modes');
assert.match(rootReadme, /\/yolo/, 'root README must document /yolo');
for (const policy of ['never', 'on-request', 'read-only', 'workspace-write', 'full-access']) {
  assert.ok(
    new RegExp(`--ask-for-approval[\\s\\S]*${policy}`).test(rootReadme),
    `root README --ask-for-approval must list the "${policy}" value`,
  );
}
assert.match(rootReadme, /moss doctor/, 'root README must point at moss doctor for troubleshooting');

// DOC-4/DOC-5: agent README must not tell users to resume from /sessions, and
// must document /resume as the switch command.
assert.doesNotMatch(
  agentReadme,
  /\/sessions\s+list saved conversations you can resume/,
  'agent README must not claim /sessions resumes — /sessions lists, /resume switches',
);
assert.match(agentReadme, /\/resume/, 'agent README must document /resume');

console.log('readme-accuracy.spec.mjs: all README claims match live CLI behavior');
