#!/usr/bin/env node
/**
 * CLI identity layer test.
 *
 * Regression for the agent introducing itself as another assistant: the standalone CLI
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
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DmossAgent, InMemorySessionStore } from '../dist/core/index.js';
import { PiAiLLMProvider } from '../dist/provider/index.js';
import { DMOSS_CLI_IDENTITY, buildDmossCliIdentity } from '../dist/cli/identity.js';

// Persona is kept (do not role-play as a different assistant product), but the
// underlying model is disclosed honestly (no substituting "Moss" for the model).
const UNIQUE_CLAUSE = /do not role-play as a different assistant product/;
const MODEL_HONESTY = /be honest about the model/i;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../dist/cli.js');

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

test('DMOSS_CLI_IDENTITY keeps the Moss persona but is honest about the model', () => {
  assert.match(DMOSS_CLI_IDENTITY, /\bMoss\b/);
  assert.match(DMOSS_CLI_IDENTITY, /D-Robotics/);
  assert.match(DMOSS_CLI_IDENTITY, /地瓜机器人/);
  assert.match(DMOSS_CLI_IDENTITY, UNIQUE_CLAUSE);
  assert.match(DMOSS_CLI_IDENTITY, MODEL_HONESTY, 'identity must allow honest model disclosure');
  // bilingual: includes the Chinese identity too
  assert.match(DMOSS_CLI_IDENTITY, /地瓜机器人（D-Robotics）研发的 Agent/);
});

test('buildDmossCliIdentity names the actual model (honest, not substituted with "Moss")', () => {
  const withModel = buildDmossCliIdentity({ model: 'deepseek-v4-pro' });
  assert.match(withModel, /\bMoss\b/, 'persona name is still Moss');
  assert.match(withModel, /deepseek-v4-pro/, 'the real model name is disclosed');
  assert.match(withModel, MODEL_HONESTY);
  // bundled gateway: honestly says built-in gateway rather than a fake model name
  const bundled = buildDmossCliIdentity({ usingBundledDefault: true, model: 'Moss' });
  assert.match(bundled, /built-in model gateway/);
});

test('without an identity baseSystemPrompt the system prompt has no identity (bug baseline)', () => {
  const frame = newAgent().buildSystemPrompt();
  assert.doesNotMatch(frame, UNIQUE_CLAUSE);
});

test('CLI identity lands in buildSystemPrompt when passed as baseSystemPrompt', () => {
  const frame = newAgent({ baseSystemPrompt: DMOSS_CLI_IDENTITY }).buildSystemPrompt();
  assert.match(frame, /\bMoss\b/);
  assert.match(frame, /D-Robotics/);
  assert.match(frame, /地瓜机器人/);
  assert.match(frame, UNIQUE_CLAUSE);
});

test('CLI process sends the Moss identity in the provider system prompt', async () => {
  let requestBody;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      requestBody = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'identity-ok' },
          },
        ],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-identity-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-identity-config-'));
    fs.writeFileSync(path.join(configDir, 'community-auth.json'), JSON.stringify({
      schema: 'dmoss_community_auth.v1',
      ssoBaseUrl: 'https://sso.d-robotics.cc',
      accessToken: 'test-community-token',
      user: { id: 'test-user', name: 'Test User' },
      expiresAt: Date.now() + 60 * 60 * 1000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    // Model env vars are ignored by design (IGNORED_MODEL_ENV_VARS), so the
    // API key must come from the config file, not DMOSS_API_KEY.
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ apiKey: 'test-key' }), { mode: 0o600 });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cliPath,
        '--quiet',
        '--provider',
        'openai-compatible',
        '--base-url',
        `http://127.0.0.1:${port}/v1`,
        '--model',
        'identity-test-model',
        'Who developed Moss?',
      ], {
        cwd,
        env: {
          ...process.env,
          DMOSS_CONFIG_DIR: configDir,
          DMOSS_NO_BUNDLED_DEFAULT: '1',
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`CLI identity smoke timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, 20_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });

    assert.equal(
      result.status,
      0,
      `dmoss identity smoke should exit cleanly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /identity-ok/);
    const system = requestBody?.messages?.find((m) => m.role === 'system')?.content;
    assert.equal(typeof system, 'string', 'expected CLI request to include a system message');
    assert.match(system, /\bMoss\b/);
    assert.match(system, /D-Robotics/);
    assert.match(system, /地瓜机器人/);
    assert.match(system, UNIQUE_CLAUSE);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
