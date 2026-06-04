#!/usr/bin/env node
/**
 * CLI identity layer test.
 *
 * Regression for the agent introducing itself as "Codex": the standalone CLI
 * had no identity in its system prompt. The fix passes DMOSS_CLI_IDENTITY as the
 * agent's baseSystemPrompt. These tests check the identity text and that it
 * actually lands in buildSystemPrompt() (enforce), with a without-identity
 * baseline that would have failed before the fix.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-identity.spec.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { DmossAgent, InMemorySessionStore } from '../dist/core/index.js';
import { PiAiLLMProvider } from '../dist/provider/index.js';
import { DMOSS_CLI_IDENTITY } from '../dist/cli/identity.js';

const UNIQUE_CLAUSE = /never claim to be any other assistant/;

function newAgent(extra = {}) {
  const provider = new PiAiLLMProvider({
    apiKey: 'test-key',
    model: { api: 'openai-chat', provider: 'identity-test', id: 'identity-test-model' },
    streamFn: async function* () { throw new Error('provider should not be called'); },
  });
  return new DmossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    model: 'identity-test-model',
    enableCompaction: false,
    enableContextPruning: false,
    ...extra,
  });
}

test('DMOSS_CLI_IDENTITY names Moss and D-Robotics and forbids other names', () => {
  assert.match(DMOSS_CLI_IDENTITY, /\bMoss\b/);
  assert.match(DMOSS_CLI_IDENTITY, /D-Robotics/);
  assert.match(DMOSS_CLI_IDENTITY, UNIQUE_CLAUSE);
  // bilingual: includes the Chinese identity too
  assert.match(DMOSS_CLI_IDENTITY, /D-Robotics 的 Agent/);
});

test('without an identity baseSystemPrompt the system prompt has no identity (bug baseline)', () => {
  const frame = newAgent().buildSystemPrompt();
  assert.doesNotMatch(frame, UNIQUE_CLAUSE);
});

test('CLI identity lands in buildSystemPrompt when passed as baseSystemPrompt', () => {
  const frame = newAgent({ baseSystemPrompt: DMOSS_CLI_IDENTITY }).buildSystemPrompt();
  assert.match(frame, /\bMoss\b/);
  assert.match(frame, /D-Robotics/);
  assert.match(frame, UNIQUE_CLAUSE);
});
