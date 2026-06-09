#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-runtime-capabilities.spec.mjs
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

function startMockProvider() {
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
            message: { role: 'assistant', content: 'runtime-ok' },
          },
        ],
      }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        getRequestBody: () => requestBody,
      });
    });
  });
}

function runCli({ cwd, configDir, port, extraEnv = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      cliPath,
      '--quiet',
      '--provider',
      'openai-compatible',
      '--base-url',
      `http://127.0.0.1:${port}/v1`,
      '--model',
      'runtime-test-model',
      '只回答 runtime-ok',
    ], {
      cwd,
      env: {
        ...process.env,
        DMOSS_CONFIG_DIR: configDir,
        DMOSS_NO_BUNDLED_DEFAULT: '1',
        DMOSS_API_KEY: 'test-key',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI runtime capability smoke timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
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
}

function writeMockCodeGraphMcpConfig(dir) {
  const serverPath = path.join(dir, 'mock-codegraph-mcp-server.mjs');
  const configPath = path.join(dir, 'mcp.json');
  const serverCode = `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;

  switch (msg.method) {
    case 'initialize':
      respond(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-codegraph', version: '1.0.0' },
      });
      break;
    case 'tools/list':
      respond(msg.id, {
        tools: [{
          name: 'codegraph_search',
          description: 'Search CodeGraph symbols',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        }],
      });
      break;
    case 'tools/call':
      respond(msg.id, {
        content: [{ type: 'text', text: 'symbol: ' + msg.params.arguments.query }],
      });
      break;
    default:
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      }) + '\\n');
  }
});
`;
  fs.writeFileSync(serverPath, serverCode);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        codegraph: {
          command: process.execPath,
          args: [serverPath],
        },
      },
    }),
  );
  return configPath;
}

test('CLI system prompt includes real runtime tools, project AGENTS, and honest CodeGraph status', async () => {
  const mock = await startMockProvider();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-runtime-cwd-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-runtime-config-'));
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
    fs.writeFileSync(
      path.join(cwd, 'AGENTS.md'),
      [
        '# Project Instructions',
        '',
        '- PROJECT_AGENTS_SENTINEL: always load project AGENTS.md before coding.',
      ].join('\n'),
    );

    const result = await runCli({ cwd, configDir, port: mock.port });
    assert.equal(
      result.status,
      0,
      `dmoss runtime capability smoke should exit cleanly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /runtime-ok/);

    const system = mock.getRequestBody()?.messages?.find((m) => m.role === 'system')?.content;
    assert.equal(typeof system, 'string', 'expected CLI request to include a system message');
    assert.match(system, /PROJECT_AGENTS_SENTINEL/);
    assert.equal(system.match(/PROJECT_AGENTS_SENTINEL/g)?.length, 1);
    assert.match(system, /## Runtime Capabilities/);
    assert.match(system, /Available tools:/);
    assert.match(system, /\bread_file\b/);
    assert.match(system, /\bapply_patch\b/);
    assert.match(system, /\binstall_skill\b/);
    assert.match(system, /\bsearch_code\b/);
    assert.match(system, /Do not invent tool names/);
    assert.match(system, /CodeGraph: unavailable/);
  } finally {
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('CLI system prompt marks CodeGraph available only when registered MCP tools prove it', async () => {
  const mock = await startMockProvider();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-runtime-codegraph-cwd-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-cli-runtime-codegraph-config-'));
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
    const mcpConfigPath = writeMockCodeGraphMcpConfig(configDir);

    const result = await runCli({
      cwd,
      configDir,
      port: mock.port,
      extraEnv: {
        DMOSS_MCP_ENABLED: '1',
        DMOSS_MCP_CONFIG: mcpConfigPath,
      },
    });
    assert.equal(
      result.status,
      0,
      `dmoss CodeGraph runtime capability smoke should exit cleanly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /runtime-ok/);

    const system = mock.getRequestBody()?.messages?.find((m) => m.role === 'system')?.content;
    assert.equal(typeof system, 'string', 'expected CLI request to include a system message');
    assert.match(system, /MCP: enabled; connected servers: codegraph/);
    assert.match(system, /codegraph__codegraph_search/);
    assert.match(system, /CodeGraph: available via codegraph__codegraph_search/);
  } finally {
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
