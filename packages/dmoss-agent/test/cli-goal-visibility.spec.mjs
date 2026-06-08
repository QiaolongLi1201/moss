#!/usr/bin/env node
/**
 * Regression for CLI slash-command discoverability.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-goal-visibility.spec.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERACTIVE_COMMANDS, completeInteractiveCommand } from '../dist/cli/repl.js';
import { renderCliInteractiveHelp } from '../dist/cli/onboarding.js';
import { commandSuggestion, completeSlashCommandInput } from '../dist/cli/tui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../dist/cli.js');

assert.ok(INTERACTIVE_COMMANDS.includes('/goal'), 'readline command list should include /goal');
assert.ok(INTERACTIVE_COMMANDS.includes('/goal set'), 'readline command list should include /goal set');
assert.ok(INTERACTIVE_COMMANDS.includes('/compact'), 'readline command list should include /compact');
assert.ok(INTERACTIVE_COMMANDS.includes('/context'), 'readline command list should include /context');
assert.ok(INTERACTIVE_COMMANDS.includes('/sessions'), 'readline command list should include /sessions');
assert.ok(INTERACTIVE_COMMANDS.includes('/version'), 'readline command list should include /version');
assert.ok(completeInteractiveCommand('/go')[0].includes('/goal'), 'readline completion should find /goal');
assert.ok(completeInteractiveCommand('/com')[0].includes('/compact'), 'readline completion should find /compact');

const interactiveHelp = renderCliInteractiveHelp();
assert.match(interactiveHelp, /\/goal\s+show or manage the persistent session goal/);
assert.match(interactiveHelp, /\/model\s+choose or switch the active model for this session/);
assert.match(interactiveHelp, /\/goal set <objective>\s+set the goal Moss should keep in context/);
assert.match(interactiveHelp, /\/compact\s+compress older conversation history into a summary/);
assert.match(interactiveHelp, /\/context\s+show current context-window usage/);
assert.match(interactiveHelp, /\/version\s+show the installed dmoss version/);

assert.equal(commandSuggestion('/goa'), '/goal');
assert.equal(completeSlashCommandInput('/go', 3)?.value, '/goal');
assert.equal(commandSuggestion('/compct'), '/compact');
assert.equal(completeSlashCommandInput('/com', 4)?.value, '/compact');

const help = spawnSync(process.execPath, [cliPath, '--help'], {
  encoding: 'utf8',
  env: { ...process.env, DMOSS_NO_COLOR: '1' },
});
assert.equal(help.status, 0, help.stderr);
const helpText = `${help.stdout}\n${help.stderr}`;
assert.match(helpText, /dmoss\s+# interactive TUI; built-in D-Robotics model, no key required/);
assert.match(helpText, /\/goal\s+show or manage the persistent session goal/);
assert.match(helpText, /\/model\s+choose or switch the active model for this session/);
assert.match(helpText, /\/goal set <objective>\s+set the goal Moss should keep in context/);
assert.match(helpText, /\/compact\s+compress older conversation history into a summary/);
assert.match(helpText, /\/context\s+show current context-window usage/);
assert.match(helpText, /\/version\s+show the installed dmoss version/);

console.log('[PASS] CLI slash commands are discoverable');
