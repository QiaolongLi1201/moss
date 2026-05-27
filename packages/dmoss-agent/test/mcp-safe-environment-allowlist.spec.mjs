#!/usr/bin/env node
/**
 * Test: MCP subprocesses use a closed environment allowlist.
 *
 * MCP servers are third-party subprocesses. They should receive only minimal
 * runtime environment plus explicit per-server config.env grants.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMcpServers } from '../dist/mcp/index.js';
import { safeMcpChildEnv } from '../dist/utils/safe-child-env.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function withEnv(vars, fn) {
  const previous = new Map();
  for (const key of Object.keys(vars)) {
    previous.set(key, process.env[key]);
    process.env[key] = vars[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

const syntheticSecret = `XYZ_SECRET_${Date.now()}`;
const hostSecrets = {
  OPENROUTER_API_KEY: 'host-openrouter-secret',
  TOGETHER_API_KEY: 'host-together-secret',
  DEEPSEEK_API_KEY: 'host-deepseek-secret',
  GH_TOKEN: 'host-gh-secret',
  DATABASE_URL: 'postgres://user:pass@localhost/db',
  NPM_TOKEN: 'host-npm-secret',
  HTTP_PROXY: 'http://user:pass@proxy.local:8080',
  SAFE_VAR: 'ordinary-host-value',
  [syntheticSecret]: 'synthetic-secret',
};

console.log('[TEST] safeMcpChildEnv strips host secrets and preserves explicit config env');
await withEnv(hostSecrets, async () => {
  const env = safeMcpChildEnv({
    MCP_CUSTOM_VAR: 'custom-value',
    OPENROUTER_API_KEY: 'explicit-mcp-secret',
  });

  assert.equal(env.TOGETHER_API_KEY, undefined, 'TOGETHER_API_KEY should not be inherited');
  assert.equal(env.DEEPSEEK_API_KEY, undefined, 'DEEPSEEK_API_KEY should not be inherited');
  assert.equal(env.GH_TOKEN, undefined, 'GH_TOKEN should not be inherited');
  assert.equal(env.DATABASE_URL, undefined, 'DATABASE_URL should not be inherited');
  assert.equal(env.NPM_TOKEN, undefined, 'NPM_TOKEN should not be inherited');
  assert.equal(env.HTTP_PROXY, undefined, 'HTTP_PROXY should not be inherited');
  assert.equal(env.SAFE_VAR, undefined, 'arbitrary host env should not be inherited');
  assert.equal(env[syntheticSecret], undefined, 'synthetic host secret should not be inherited');

  assert.equal(env.MCP_CUSTOM_VAR, 'custom-value', 'explicit MCP env should be applied');
  assert.equal(env.OPENROUTER_API_KEY, 'explicit-mcp-secret', 'explicit provider key should be applied');
  if (process.env.PATH) assert.equal(env.PATH, process.env.PATH, 'PATH should be preserved');
  if (process.env.HOME) assert.equal(env.HOME, process.env.HOME, 'HOME should be preserved');
});
console.log('  ✓ safeMcpChildEnv uses a closed allowlist plus explicit overrides');

console.log('[TEST] connectMcpServers launches MCP subprocess with allowlisted environment');
await withEnv(hostSecrets, async () => {
  const mockServerPath = join(__dirname, '_mock_mcp_env.tmp.mjs');
  const serverCode = `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;

  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'env-server', version: '1.0.0' },
      },
    }) + '\\n');
    return;
  }

  if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [{
          name: 'env',
          description: 'Return selected environment variables',
          inputSchema: { type: 'object', properties: {} },
        }],
      },
    }) + '\\n');
    return;
  }

  if (msg.method === 'tools/call') {
    const selected = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      TOGETHER_API_KEY: process.env.TOGETHER_API_KEY,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      GH_TOKEN: process.env.GH_TOKEN,
      DATABASE_URL: process.env.DATABASE_URL,
      NPM_TOKEN: process.env.NPM_TOKEN,
      HTTP_PROXY: process.env.HTTP_PROXY,
      SAFE_VAR: process.env.SAFE_VAR,
      SYNTHETIC_SECRET: process.env.${syntheticSecret},
      MCP_CUSTOM_VAR: process.env.MCP_CUSTOM_VAR,
      PATH_PRESENT: Boolean(process.env.PATH),
      HOME_PRESENT: Boolean(process.env.HOME),
    };
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: JSON.stringify(selected) }] },
    }) + '\\n');
    return;
  }
});
`;

  writeFileSync(mockServerPath, serverCode);

  let connections = [];
  try {
    connections = await withTimeout(
      connectMcpServers({
        mcpServers: {
          envtest: {
            command: 'node',
            args: [mockServerPath],
            env: {
              MCP_CUSTOM_VAR: 'custom-value',
              OPENROUTER_API_KEY: 'explicit-mcp-secret',
            },
          },
        },
      }),
      10000,
      'connectMcpServers(envtest)',
    );

    const tool = connections[0].tools.find((candidate) => candidate.name === 'envtest__env');
    assert.ok(tool, 'expected envtest__env tool');
    const result = await withTimeout(
      tool.execute({}, { workspaceDir: tmpdir(), sessionKey: 'mcp-env-test' }),
      5000,
      'envtest__env.execute',
    );
    const env = JSON.parse(result);

    assert.equal(env.OPENROUTER_API_KEY, 'explicit-mcp-secret', 'explicit provider key should reach MCP subprocess');
    assert.equal(env.MCP_CUSTOM_VAR, 'custom-value', 'explicit MCP env should reach MCP subprocess');
    assert.equal(env.TOGETHER_API_KEY, undefined, 'TOGETHER_API_KEY should not reach MCP subprocess');
    assert.equal(env.DEEPSEEK_API_KEY, undefined, 'DEEPSEEK_API_KEY should not reach MCP subprocess');
    assert.equal(env.GH_TOKEN, undefined, 'GH_TOKEN should not reach MCP subprocess');
    assert.equal(env.DATABASE_URL, undefined, 'DATABASE_URL should not reach MCP subprocess');
    assert.equal(env.NPM_TOKEN, undefined, 'NPM_TOKEN should not reach MCP subprocess');
    assert.equal(env.HTTP_PROXY, undefined, 'HTTP_PROXY should not reach MCP subprocess');
    assert.equal(env.SAFE_VAR, undefined, 'arbitrary host env should not reach MCP subprocess');
    assert.equal(env.SYNTHETIC_SECRET, undefined, 'synthetic host secret should not reach MCP subprocess');
    assert.equal(env.PATH_PRESENT, true, 'PATH should be available so command launchers keep working');
  } finally {
    await Promise.allSettled(connections.map((connection) => connection.close()));
    rmSync(mockServerPath, { force: true });
  }
});
console.log('  ✓ connectMcpServers does not leak ambient host env to MCP subprocesses');

console.log('[PASS] MCP allowlisted environment tests');
