#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-mcp.spec.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerConfiguredMcpTools } from '../dist/cli/mcp.js';
import { ToolRegistry } from '../dist/core/index.js';

function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

{
  const agent = { tools: new ToolRegistry() };
  const connections = await registerConfiguredMcpTools(agent, {
    mcpEnabled: false,
    mcpConfigPath: '/tmp/dmoss-mcp-disabled.json',
  });

  assert.deepEqual(connections, []);
  assert.equal(agent.tools.size, 0);
}

console.log('  [PASS] CLI MCP registration is disabled by default');

{
  const dir = mkdtempSync(join(tmpdir(), 'dmoss-cli-mcp-'));
  const serverPath = join(dir, 'mock-mcp-server.mjs');
  const configPath = join(dir, 'mcp.json');
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
        serverInfo: { name: 'cli-mock-server', version: '1.0.0' },
      });
      break;
    case 'tools/list':
      respond(msg.id, {
        tools: [{
          name: 'ping',
          description: 'Ping from CLI MCP config',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
        }],
      });
      break;
    case 'tools/call':
      respond(msg.id, {
        content: [{ type: 'text', text: 'pong: ' + msg.params.arguments.message }],
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
  writeFileSync(serverPath, serverCode);
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        mock: {
          command: 'node',
          args: [serverPath],
        },
      },
    }),
  );

  const agent = { tools: new ToolRegistry() };
  let connections = [];
  try {
    connections = await withTimeout(
      registerConfiguredMcpTools(agent, { mcpEnabled: true, mcpConfigPath: configPath }),
      10000,
      'registerConfiguredMcpTools',
    );

    assert.equal(connections.length, 1);
    assert.equal(agent.tools.has('mock__ping'), true);
    assert.equal(agent.tools.getGroupForTool('mock__ping'), 'mcp:mock');

    const result = await withTimeout(
      agent.tools.get('mock__ping').execute(
        { message: 'hello' },
        { workspaceDir: dir, sessionKey: 'cli-mcp-test' },
      ),
      5000,
      'mock__ping.execute',
    );
    assert.equal(result, 'pong: hello');
  } finally {
    await Promise.allSettled(connections.map((connection) => connection.close()));
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('  [PASS] CLI MCP config registers and executes MCP tools');

{
  const agent = { tools: new ToolRegistry() };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const connections = await registerConfiguredMcpTools(agent, {
      mcpEnabled: true,
      mcpConfigPath: '/tmp/dmoss-missing-mcp-config.json',
    });
    assert.deepEqual(connections, []);
    assert.equal(agent.tools.size, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /MCP is enabled but no valid config was found/);
  } finally {
    console.warn = originalWarn;
  }
}

console.log('  [PASS] CLI MCP config warns and skips missing config');
