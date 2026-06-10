#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-install-skill-toolcall.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../dist/cli.js');

test('CLI can execute an install_skill tool call and register the resulting SKILL.md', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-install-skill-cwd-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-install-skill-config-'));
  let requestCount = 0;
  const requestBodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      requestCount += 1;
      requestBodies.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      if (requestCount === 1) {
        res.end(JSON.stringify({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_install_skill',
                    type: 'function',
                    function: {
                      name: 'install_skill',
                      arguments: JSON.stringify({
                        name: 'truth-check',
                        description: 'Check evidence gaps before final answers.',
                        tags: ['truth', 'verification'],
                        trigger: ['score moss', 'evidence gaps'],
                        risk: 'low',
                        permissions: ['workspace_read'],
                        body: '# Truth Check\n\nSeparate verified facts from assumptions before final answers.',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }));
        return;
      }
      res.end(JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'installed-ok' },
          },
        ],
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    fs.writeFileSync(
      path.join(configDir, 'community-auth.json'),
      JSON.stringify({
        schema: 'dmoss_community_auth.v1',
        ssoBaseUrl: 'https://sso.d-robotics.cc',
        accessToken: 'test-community-token',
        user: { id: 'test-user', name: 'Test User' },
        expiresAt: Date.now() + 60 * 60 * 1000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    // Model env vars are ignored by design (IGNORED_MODEL_ENV_VARS), so the
    // API key must come from the config file, not DMOSS_API_KEY.
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ apiKey: 'test-key' }), { mode: 0o600 });
    const { port } = server.address();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cliPath,
        '--quiet',
        '--provider',
        'openai-compatible',
        '--base-url',
        `http://127.0.0.1:${port}/v1`,
        '--model',
        'install-skill-test-model',
        'Install the truth-check skill.',
      ], {
        cwd,
        env: {
          ...process.env,
          DMOSS_CONFIG_DIR: configDir,
          DMOSS_NO_BUNDLED_DEFAULT: '1',
          DMOSS_TRUSTED_TOOLS: 'install_skill',
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`CLI install_skill smoke timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
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

    assert.equal(result.status, 0, `CLI install_skill smoke should exit cleanly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /installed-ok/);
    assert.equal(requestBodies.length, 2, 'tool result should trigger a follow-up model request');
    const toolResultMessage = requestBodies[1].messages.find((message) => (
      message.role === 'tool' ||
      (message.role === 'user' && JSON.stringify(message).includes('call_install_skill'))
    ));
    assert.ok(toolResultMessage, 'second request should include install_skill tool result');
    const skillPath = path.join(cwd, '.moss', 'skills', 'truth-check', 'SKILL.md');
    assert.match(fs.readFileSync(skillPath, 'utf-8'), /name: truth-check/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
