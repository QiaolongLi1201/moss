#!/usr/bin/env node
/**
 * In-TUI /help (commandList) must name /resume — the command that actually
 * switches into a saved conversation. Before this fix /help listed /sessions
 * ("conversations you can resume") but never told the user the verb is /resume.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-help-resume-discoverability.spec.mjs
 */

import assert from 'node:assert/strict';
import { commandList } from '../dist/cli/tui.js';

const text = commandList();

assert.match(
  text,
  /\/resume/,
  '/help must name /resume so users can discover how to switch into a saved session',
);
// The pairing with /sessions should remain so list-then-switch reads as one flow.
assert.match(text, /\/sessions/, '/help should still list /sessions');

console.log('  [PASS] in-TUI /help surfaces /resume next to /sessions');
