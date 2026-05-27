#!/usr/bin/env node
/**
 * MCP client — unit and integration tests.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/mcp-client.spec.mjs
 */

import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMcpConfig, connectMcpServers } from '../dist/mcp/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ── loadMcpConfig: valid config file ──

{
  const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  try {
    const configPath = join(dir, 'mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
            env: { KEY: 'value' },
          },
        },
      }),
    );
    const config = loadMcpConfig(configPath);
    assert.notEqual(config, null);
    assert.ok(config.mcpServers['test-server']);
    assert.equal(config.mcpServers['test-server'].command, 'node');
    assert.deepEqual(config.mcpServers['test-server'].args, ['server.js']);
    assert.deepEqual(config.mcpServers['test-server'].env, { KEY: 'value' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('  [PASS] loadMcpConfig with valid config file');

// ── loadMcpConfig: invalid JSON ──

{
  const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  try {
    const configPath = join(dir, 'mcp.json');
    writeFileSync(configPath, '{ this is not valid json }}}');
    const config = loadMcpConfig(configPath);
    assert.equal(config, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('  [PASS] loadMcpConfig with invalid JSON returns null');

// ── loadMcpConfig: valid JSON but missing mcpServers ──

{
  const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  try {
    const configPath = join(dir, 'mcp.json');
    writeFileSync(configPath, JSON.stringify({ servers: {} }));
    const config = loadMcpConfig(configPath);
    assert.equal(config, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  try {
    const configPath = join(dir, 'mcp.json');
    writeFileSync(configPath, JSON.stringify({ mcpServers: 'not-an-object' }));
    const config = loadMcpConfig(configPath);
    assert.equal(config, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('  [PASS] loadMcpConfig with missing/invalid mcpServers returns null');

// ── loadMcpConfig: non-existent file ──

{
  const config = loadMcpConfig('/tmp/nonexistent-mcp-config-xyz-123.json');
  assert.equal(config, null);
}

console.log('  [PASS] loadMcpConfig with non-existent file returns null');

// ── connectMcpServers: non-existent command ──

{
  const config = {
    mcpServers: {
      'bad-server': {
        command: 'nonexistent-binary-xyz-12345',
      },
    },
  };

  let caught = false;
  try {
    await withTimeout(connectMcpServers(config), 10000, 'connectMcpServers');
  } catch (err) {
    caught = true;
    assert.ok(
      err.message.includes('bad-server'),
      `error should mention server name, got: ${err.message}`,
    );
  }
  assert.ok(caught, 'should have thrown for non-existent binary');
}

console.log('  [PASS] connectMcpServers handles non-existent command gracefully');

// ── Real MCP server: tool listing, namespacing, and tool calling ──

{
  const mockServerPath = join(__dirname, '_mock_mcp_server.tmp.mjs');
  const serverCode = `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;

  let response;
  switch (msg.method) {
    case 'initialize':
      response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-server', version: '1.0.0' },
        },
      };
      break;
    case 'tools/list':
      response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'greet',
              description: 'Say hello',
              inputSchema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
              },
            },
            {
              name: 'add',
              description: 'Add two numbers',
              inputSchema: {
                type: 'object',
                properties: { a: { type: 'number' }, b: { type: 'number' } },
                required: ['a', 'b'],
              },
            },
          ],
        },
      };
      break;
    case 'tools/call': {
      const args = msg.params.arguments || {};
      let text;
      if (msg.params.name === 'greet') {
        text = 'Hello, ' + args.name + '!';
      } else if (msg.params.name === 'add') {
        text = String((args.a || 0) + (args.b || 0));
      } else {
        text = 'unknown tool';
      }
      response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text }] },
      };
      break;
    }
    default:
      response = {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      };
  }
  process.stdout.write(JSON.stringify(response) + '\\n');
});
`;
  writeFileSync(mockServerPath, serverCode);

  try {
    const config = {
      mcpServers: {
        mock: {
          command: 'node',
          args: [mockServerPath],
        },
      },
    };

    const connections = await withTimeout(
      connectMcpServers(config),
      10000,
      'connectMcpServers(mock)',
    );

    assert.equal(connections.length, 1);
    assert.equal(connections[0].serverName, 'mock');

    const tools = connections[0].tools;
    assert.equal(tools.length, 2);

    const greetTool = tools.find((t) => t.name === 'mock__greet');
    const addTool = tools.find((t) => t.name === 'mock__add');
    assert.ok(greetTool, 'should have namespaced greet tool (mock__greet)');
    assert.ok(addTool, 'should have namespaced add tool (mock__add)');

    assert.equal(greetTool.description, 'Say hello');
    assert.equal(greetTool.inputSchema.type, 'object');
    assert.deepEqual(greetTool.inputSchema.required, ['name']);
    assert.equal(greetTool.metadata.sideEffectClass, 'external_message');

    const ctx = { workspaceDir: '/tmp', sessionKey: 'test-session' };

    const greetResult = await withTimeout(
      greetTool.execute({ name: 'World' }, ctx),
      5000,
      'greet.execute',
    );
    assert.equal(greetResult, 'Hello, World!');

    const addResult = await withTimeout(
      addTool.execute({ a: 3, b: 4 }, ctx),
      5000,
      'add.execute',
    );
    assert.equal(addResult, '7');

    await withTimeout(connections[0].close(), 5000, 'close');
  } finally {
    rmSync(mockServerPath, { force: true });
  }
}

console.log('  [PASS] real MCP server: tool listing, namespacing, and tool calling');

// ── Real MCP server: tool error response ──

{
  const mockServerPath = join(__dirname, '_mock_mcp_error.tmp.mjs');
  const serverCode = `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;

  let response;
  switch (msg.method) {
    case 'initialize':
      response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: { name: 'error-server', version: '1.0.0' },
        },
      };
      break;
    case 'tools/list':
      response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [{
            name: 'fail_tool',
            description: 'Always fails',
            inputSchema: { type: 'object', properties: {}, required: [] },
          }],
        },
      };
      break;
    case 'tools/call':
      response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: 'Something went wrong' }],
          isError: true,
        },
      };
      break;
    default:
      response = {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      };
  }
  process.stdout.write(JSON.stringify(response) + '\\n');
});
`;
  writeFileSync(mockServerPath, serverCode);

  try {
    const config = {
      mcpServers: {
        errserver: {
          command: 'node',
          args: [mockServerPath],
        },
      },
    };

    const connections = await withTimeout(
      connectMcpServers(config),
      10000,
      'connectMcpServers(errserver)',
    );

    const failTool = connections[0].tools.find((t) => t.name === 'errserver__fail_tool');
    assert.ok(failTool);

    let caught = false;
    try {
      await withTimeout(failTool.execute({}, { workspaceDir: '/tmp', sessionKey: 's' }), 5000, 'failTool.execute');
    } catch (err) {
      caught = true;
      assert.ok(
        err.message.includes('Something went wrong'),
        `error should contain server message, got: ${err.message}`,
      );
    }
    assert.ok(caught, 'tool execute should throw on isError response');

    await withTimeout(connections[0].close(), 5000, 'close');
  } finally {
    rmSync(mockServerPath, { force: true });
  }
}

console.log('  [PASS] real MCP server: tool error (isError) propagates as thrown error');

// ── Real MCP server: rich content is exposed through executeStructured ──

{
  const mockServerPath = join(__dirname, '_mock_mcp_rich.tmp.mjs');
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
        serverInfo: { name: 'rich-server', version: '1.0.0' },
      });
      break;
    case 'tools/list':
      respond(msg.id, {
        tools: [{
          name: 'rich_result',
          description: 'Returns mixed content',
          inputSchema: { type: 'object', properties: {}, required: [] },
        }],
      });
      break;
    case 'tools/call':
      respond(msg.id, {
        content: [
          { type: 'text', text: 'plain detail' },
          { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png', alt: 'fake image' },
          {
            type: 'resource',
            resource: {
              uri: 'file:///tmp/rich.txt',
              name: 'rich.txt',
              mimeType: 'text/plain',
              text: 'resource text',
            },
          },
        ],
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
  writeFileSync(mockServerPath, serverCode);

  try {
    const connections = await withTimeout(
      connectMcpServers({
        mcpServers: {
          richserver: {
            command: 'node',
            args: [mockServerPath],
          },
        },
      }),
      10000,
      'connectMcpServers(richserver)',
    );

    const richTool = connections[0].tools.find((t) => t.name === 'richserver__rich_result');
    assert.ok(richTool);
    assert.equal(typeof richTool.executeStructured, 'function');

    const structured = await richTool.executeStructured({}, { workspaceDir: '/tmp', sessionKey: 'rich' });
    assert.deepEqual(structured, {
      content: [
        { type: 'text', text: 'plain detail' },
        { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png', alt: 'fake image' },
        {
          type: 'resource',
          uri: 'file:///tmp/rich.txt',
          name: 'rich.txt',
          mimeType: 'text/plain',
          text: 'resource text',
        },
      ],
    });

    const text = await richTool.execute({}, { workspaceDir: '/tmp', sessionKey: 'rich' });
    assert.equal(text, 'plain detail\nresource text');

    await withTimeout(connections[0].close(), 5000, 'close');
  } finally {
    rmSync(mockServerPath, { force: true });
  }
}

console.log('  [PASS] real MCP server: rich content maps to structured tool blocks');

console.log('All MCP client checks passed.');
