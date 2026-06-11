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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERACTIVE_COMMANDS, completeInteractiveCommand } from '../dist/cli/repl.js';
import { renderCliInteractiveHelp } from '../dist/cli/onboarding.js';
import { commandSuggestion, completeSlashCommandInput } from '../dist/cli/tui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../dist/cli.js');
const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));

assert.equal(packageJson.bin.moss, 'dist/cli.js', 'package should install the preferred `moss` binary');
assert.equal(packageJson.bin.dmoss, 'dist/cli.js', 'package should keep the compatible `dmoss` binary');

assert.ok(INTERACTIVE_COMMANDS.includes('/goal'), 'readline command list should include /goal');
assert.ok(INTERACTIVE_COMMANDS.includes('/compact'), 'readline command list should include /compact');
assert.ok(INTERACTIVE_COMMANDS.includes('/connect'), 'readline command list should include /connect');
assert.ok(!INTERACTIVE_COMMANDS.includes('/context'), 'readline command list should keep advanced /context out of default completion');
assert.ok(INTERACTIVE_COMMANDS.includes('/sessions'), 'readline command list should include /sessions');
assert.ok(!INTERACTIVE_COMMANDS.includes('/version'), 'readline command list should keep /version out of default completion');
assert.ok(INTERACTIVE_COMMANDS.includes('/auth'), 'readline command list should include /auth');
assert.ok(!INTERACTIVE_COMMANDS.includes('/logout'), 'readline command list should keep /logout out of default completion');
assert.ok(completeInteractiveCommand('/go')[0].includes('/goal'), 'readline completion should find /goal');
assert.ok(completeInteractiveCommand('/com')[0].includes('/compact'), 'readline completion should find /compact');
assert.ok(completeInteractiveCommand('/con')[0].includes('/connect'), 'readline completion should find /connect');

const interactiveHelp = renderCliInteractiveHelp();
assert.match(interactiveHelp, /\/goal\s+show or manage the active goal runner/);
assert.match(interactiveHelp, /\/model\s+choose or switch the active model for this session/);
assert.match(interactiveHelp, /\/goal <condition>\s+run until this goal condition is met/);
assert.match(interactiveHelp, /\/compact\s+compress older conversation history into a summary/);
assert.match(interactiveHelp, /\/auth login\s+optional: link a D-Robotics developer community account/);
assert.match(interactiveHelp, /\/connect <ip>\s+connect an RDK board/);
assert.match(interactiveHelp, /Advanced commands still work when needed: .*\/context/);
assert.doesNotMatch(interactiveHelp, /\/logout\s+log out of the D-Robotics/);
assert.doesNotMatch(interactiveHelp, /\/version\s+show the installed Moss version/);

assert.equal(commandSuggestion('/goa'), '/goal');
assert.equal(completeSlashCommandInput('/go', 3)?.value, '/goal');
assert.equal(commandSuggestion('/compct'), '/compact');
assert.equal(completeSlashCommandInput('/com', 4)?.value, '/compact');
assert.equal(commandSuggestion('/auth logi'), '/auth');
assert.equal(commandSuggestion('/auth logo'), '/auth');
assert.equal(completeSlashCommandInput('/auth logi', 10), null);

const help = spawnSync(process.execPath, [cliPath, '--help'], {
  encoding: 'utf8',
  env: { ...process.env, DMOSS_NO_COLOR: '1' },
});
assert.equal(help.status, 0, help.stderr);
const helpText = `${help.stdout}\n${help.stderr}`;
assert.match(helpText, /Most useful/);
assert.match(helpText, /Inside Moss/);
assert.match(helpText, /\/model\s+choose\/switch model for this session/);
assert.match(helpText, /\/connect <ip>\s+connect an RDK board/);
assert.match(helpText, /Model configuration/);
assert.match(helpText, /Built-in: no model API key or community login is required/);
assert.match(helpText, /optional browserless community login/);
assert.doesNotMatch(helpText, /SSH\/board login/);
assert.match(helpText, /OpenAI-compatible example/);
assert.match(helpText, /Priority: CLI flags\/-c > project \.moss\/config\.json > user config > built-in default/);
assert.match(helpText, /Model settings are never read from environment variables/);
assert.match(helpText, /moss --help --all/);
assert.doesNotMatch(helpText, /\/context\s+show current context-window usage/);

const fullHelp = spawnSync(process.execPath, [cliPath, '--help', '--all'], {
  encoding: 'utf8',
  env: { ...process.env, DMOSS_NO_COLOR: '1' },
});
assert.equal(fullHelp.status, 0, fullHelp.stderr);
assert.match(`${fullHelp.stdout}\n${fullHelp.stderr}`, /\/context\s+show current context-window usage/);

console.log('[PASS] CLI slash commands are discoverable');
