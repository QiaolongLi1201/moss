#!/usr/bin/env node
/**
 * File-based custom slash commands (.moss/commands/*.md). Verifies frontmatter
 * parsing, argument expansion, two-root precedence, built-in collision guard,
 * and registry dispatch through submitPrompt. See docs/slash-command-architecture.md.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseCommandFile,
  expandCommandBody,
  loadCustomCommands,
  reservedBuiltinNames,
} from '../dist/cli/commands/custom-commands.js';
import { runRegistryCommand } from '../dist/cli/commands/registry.js';

// ── frontmatter parsing ──────────────────────────────────────────────────────
{
  const p = parseCommandFile('---\ndescription: Deploy check\nargument-hint: <env>\n---\nRun the deploy checklist for $1.');
  assert.equal(p.description, 'Deploy check');
  assert.equal(p.argumentHint, '<env>');
  assert.equal(p.body, 'Run the deploy checklist for $1.');

  const noFm = parseCommandFile('Just a body, no frontmatter.\n');
  assert.equal(noFm.description, undefined);
  assert.equal(noFm.body, 'Just a body, no frontmatter.');

  // Quoted values are unwrapped; unknown keys ignored.
  const q = parseCommandFile('---\ndescription: "Quoted desc"\ncolor: blue\n---\nBody');
  assert.equal(q.description, 'Quoted desc');
}

// ── argument expansion ───────────────────────────────────────────────────────
{
  assert.equal(expandCommandBody('Check $1 and $2', 'alpha beta'), 'Check alpha and beta');
  assert.equal(expandCommandBody('All: $ARGUMENTS', 'one two three'), 'All: one two three');
  // No placeholder + args → appended.
  assert.equal(expandCommandBody('Summarize the project', 'focus on tests'), 'Summarize the project\n\nfocus on tests');
  // No placeholder + no args → body unchanged.
  assert.equal(expandCommandBody('Plain body', ''), 'Plain body');
  // Missing positionals expand to empty (no "undefined").
  assert.equal(expandCommandBody('X$1Y', '').trim(), 'XY');
}

// ── loading, precedence, and collision guard ─────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-cmds-'));
const wsCmds = path.join(tmp, 'ws', '.moss', 'commands');
const userCmds = path.join(tmp, 'cfg', 'commands');
fs.mkdirSync(wsCmds, { recursive: true });
fs.mkdirSync(userCmds, { recursive: true });

fs.writeFileSync(path.join(wsCmds, 'deploy.md'), '---\ndescription: WS deploy\n---\nWorkspace deploy body $ARGUMENTS');
fs.writeFileSync(path.join(userCmds, 'deploy.md'), 'User deploy body (should be shadowed by workspace)');
fs.writeFileSync(path.join(userCmds, 'note.md'), 'Take a note: $ARGUMENTS');
// Must be ignored: reserved built-in name, bad name, empty body, non-md.
fs.writeFileSync(path.join(userCmds, 'status.md'), 'I try to hijack /status');
fs.writeFileSync(path.join(userCmds, 'memory.md'), 'I try to hijack the hidden /memory');
fs.writeFileSync(path.join(userCmds, 'bad name.md'), 'invalid token');
fs.writeFileSync(path.join(userCmds, 'empty.md'), '   \n  ');
fs.writeFileSync(path.join(userCmds, 'readme.txt'), 'not markdown');

const reserved = reservedBuiltinNames();
assert.ok(reserved.has('/status') && reserved.has('/connect') && reserved.has('/help'));
// Hidden legacy commands must be reserved too (they omit from the menu list but
// still dispatch), or a custom file would shadow them.
assert.ok(reserved.has('/memory') && reserved.has('/skills') && reserved.has('/rewind') && reserved.has('/context'), 'hidden legacy commands are reserved');

const specs = loadCustomCommands({ workspace: path.join(tmp, 'ws'), configDir: path.join(tmp, 'cfg'), reservedNames: reserved });
const byName = new Map(specs.map((s) => [s.name, s]));

assert.ok(byName.has('/deploy'), 'workspace deploy loaded');
assert.ok(byName.has('/note'), 'user note loaded');
assert.ok(!byName.has('/status'), 'reserved built-in name is not hijacked');
assert.ok(!byName.has('/memory'), 'reserved hidden command is not hijacked');
assert.ok(!byName.has('/bad name') && !byName.has('/bad'), 'invalid filename skipped');
assert.ok(!byName.has('/empty'), 'empty body skipped');
assert.ok(!byName.has('/readme'), 'non-markdown skipped');
// Workspace wins precedence.
assert.match(byName.get('/deploy').summary, /WS deploy/);

// ── dispatch through the registry + submitPrompt ─────────────────────────────
{
  const submitted = [];
  const said = [];
  const ctx = {
    agent: {}, runtime: {}, sessionKey: 't', workspace: tmp, surface: 'repl',
    say: (kind, text) => said.push({ kind, text }),
    prefillInput: () => {},
    submitPrompt: (text) => submitted.push(text),
  };
  const handled = await runRegistryCommand('/deploy staging', ctx, specs);
  assert.equal(handled, true, 'custom command is dispatched by the registry');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0], 'Workspace deploy body staging');

  // A built-in name still wins even if a custom spec with that name is passed in.
  const ctx2 = { ...ctx, say: () => {}, submitPrompt: (t) => submitted.push(`CUSTOM:${t}`) };
  submitted.length = 0;
  await runRegistryCommand('/version', ctx2, specs);
  assert.equal(submitted.length, 0, 'built-in /version is not overridden by any custom spec');
}

// ── no commands dir → empty, never throws ────────────────────────────────────
{
  const none = loadCustomCommands({ workspace: path.join(tmp, 'does-not-exist'), configDir: path.join(tmp, 'nope'), reservedNames: reserved });
  assert.deepEqual(none, []);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[PASS] custom commands: frontmatter, arg expansion, precedence, collision guard, dispatch');
