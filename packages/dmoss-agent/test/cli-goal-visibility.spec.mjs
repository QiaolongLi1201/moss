#!/usr/bin/env node
/**
 * Regression for CLI goal-mode discoverability.
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
assert.ok(INTERACTIVE_COMMANDS.includes('/version'), 'readline command list should include /version');
assert.ok(completeInteractiveCommand('/go')[0].includes('/goal'), 'readline completion should find /goal');

const interactiveHelp = renderCliInteractiveHelp();
assert.match(interactiveHelp, /\/goal\s+show the current session goal/);
assert.match(interactiveHelp, /\/goal set <objective>/);
assert.match(interactiveHelp, /\/version\s+show dmoss version/);

assert.equal(commandSuggestion('/goa'), '/goal');
assert.equal(completeSlashCommandInput('/go', 3)?.value, '/goal');

const help = spawnSync(process.execPath, [cliPath, '--help'], {
  encoding: 'utf8',
  env: { ...process.env, DMOSS_NO_COLOR: '1' },
});
assert.equal(help.status, 0, help.stderr);
const helpText = `${help.stdout}\n${help.stderr}`;
assert.match(helpText, /\/goal\s+show the current session goal/);
assert.match(helpText, /\/goal set\s+<objective>/);
assert.match(helpText, /\/version\s+show dmoss version/);

console.log('[PASS] CLI goal commands are discoverable');
