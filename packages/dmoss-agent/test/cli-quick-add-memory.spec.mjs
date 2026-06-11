#!/usr/bin/env node
/**
 * `#text` quick-add memory: drives the real DmossTui and asserts the line is
 * appended to AGENTS.md and the model is NOT called. Run after build.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { DmossTui } from '../dist/cli/tui.js';

Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

let streamCalls = 0;
const agent = {
  config: { model: 'm', provider: 'p', sessionStore: { listSessions: async () => [], loadMessages: async () => [] } },
  asyncTasks: { list: () => [], readCompletion: () => undefined },
  tools: { getAll: () => [], size: 0 },
  async getGoal() { return undefined; },
  async compactSession() { return { compacted: false, summaryChars: 0, droppedMessages: 0, tokensAfter: 0 }; },
  registerPreToolHook() {},
  registerPostToolHook() {},
  // eslint-disable-next-line require-yield
  async *streamChat() { streamCalls++; },
};
const skillLearner = { async maybeLearnFromSession() {} };

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-quickmem-'));
try {
  const { stdin, lastFrame } = render(React.createElement(DmossTui, {
    agent, skillLearner, runtime: { workspace: ws, configDir: path.join(ws, 'cfg'), runtimeDir: path.join(ws, 'rt') }, sessionKey: 'k',
  }));
  await wait(160);
  stdin.write('# board ip is 192.0.2.10');
  await wait();
  stdin.write('\r');
  await wait(220);

  assert.equal(streamCalls, 0, '#-quick-add must NOT call streamChat');
  assert.match(strip(lastFrame()), /Added to project memory/, 'a confirmation is shown');
  const agentsMd = path.join(ws, 'AGENTS.md');
  assert.ok(fs.existsSync(agentsMd), 'AGENTS.md is created');
  assert.match(fs.readFileSync(agentsMd, 'utf8'), /- board ip is 192\.0\.2\.10/, 'the fact is appended under ## Memories');
  cleanup();
  console.log('[PASS] cli-quick-add-memory: #-line appends to AGENTS.md without calling the model');
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}
