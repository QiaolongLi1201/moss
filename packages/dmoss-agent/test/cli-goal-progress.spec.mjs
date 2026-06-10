#!/usr/bin/env node
/**
 * Long-run goal visibility: while /goal is active the status line must show
 * structured progress (objective + turn/tool counters + latest
 * working-context checkpoint), not just a spinner with elapsed seconds.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-goal-progress.spec.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { DmossTui } from '../dist/cli/tui.js';

const require = createRequire(import.meta.url);
const inkEntry = require.resolve('ink');
const { default: CursorContext } = await import(
  pathToFileURL(path.join(path.dirname(inkEntry), 'components/CursorContext.js')).href,
);
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-goal-progress-'));

function makeAgent() {
  let goal;
  return {
    config: {
      model: 'm',
      provider: 'openai-compatible',
      sessionStore: { listSessions: async () => [], loadMessages: async () => [] },
    },
    asyncTasks: { list: () => [], readCompletion: () => undefined },
    tools: { getAll: () => [], getNames: () => [], size: 0 },
    async getGoal() { return goal; },
    async setGoal(sessionKey, objective) {
      goal = { sessionKey, objective, status: 'active', createdAt: '', updatedAt: '' };
      return goal;
    },
    async pauseGoal() { return goal; },
    async resumeGoal() { return goal; },
    async completeGoal() { return goal; },
    async blockGoal() { return goal; },
    async clearGoal() { goal = undefined; },
    async compactSession() { return { compacted: false, summaryChars: 0, droppedMessages: 0, tokensAfter: 1 }; },
    registerPreToolHook() {}, registerPostToolHook() {},
    async *streamChat() {
      yield { type: 'turn_start', turn: 1 };
      yield { type: 'tool_start', toolCallId: 't1', toolName: 'exec', input: { command: 'echo hi' } };
      yield { type: 'tool_end', toolCallId: 't1', toolName: 'exec', result: 'hi', isError: false };
      yield { type: 'working_context_checkpoint', status: 'in_progress', nextAction: 're-run the failing test' };
      yield { type: 'turn_start', turn: 2 };
      // keep the goal running: no finish_goal call, just end the stream
      yield { type: 'done', result: { text: 'working', toolCalls: [], stopReason: 'end_turn' } };
    },
  };
}

const runtime = {
  workspace: scratch,
  configDir: scratch,
  runtimeDir: path.join(scratch, '.moss'),
  config: { provider: 'openai-compatible', safetyMode: 'workspace-write', approvalPolicy: 'prompt' },
};

const { stdin, frames } = render(React.createElement(
  CursorContext.Provider, { value: { setCursorPosition() {} } },
  React.createElement(DmossTui, {
    agent: makeAgent(),
    skillLearner: { async maybeLearnFromSession() {} },
    runtime,
    sessionKey: 'goal-progress',
  }),
));
await wait(300);
stdin.write('/goal finish the demo project');
await wait(150);
stdin.write('\r');
await wait(900);

const all = frames.map(strip).join('\n');
// The status line wraps at terminal width — collapse whitespace before matching.
const flat = all.replace(/\s+/g, ' ');
assert.match(flat, /goal: finish the demo project/, 'status line must show the goal objective');
assert.match(flat, /turns [1-9]\d* · tools [1-9]\d*/, 'counters must actually advance during the run');
assert.match(flat, /next: re-run the failing test/, 'status line must surface the latest checkpoint next action');

cleanup();
fs.rmSync(scratch, { recursive: true, force: true });
console.log('  [PASS] goal status line shows objective, counters, and checkpoint');
console.log('[PASS] goal structured progress');
process.exit(0);
