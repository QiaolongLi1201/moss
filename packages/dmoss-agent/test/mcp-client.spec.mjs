#!/usr/bin/env node
/**
 * MCP client — unit and integration tests.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/mcp-client.spec.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
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
            cwd: dir,
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
    assert.equal(config.mcpServers['test-server'].cwd, dir);
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

// ── Real MCP server: cwd is passed to the spawned stdio process ──

{
  const dir = mkdtempSync(join(tmpdir(), 'mcp-cwd-'));
  const mockServerPath = join(dir, 'mock-mcp-cwd-server.mjs');
  const workdir = join(dir, 'workdir');
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
        serverInfo: { name: 'cwd-server', version: '1.0.0' },
      });
      break;
    case 'tools/list':
      respond(msg.id, {
        tools: [{
          name: 'pwd',
          description: 'Return process cwd',
          inputSchema: { type: 'object', properties: {}, required: [] },
        }],
      });
      break;
    case 'tools/call':
      respond(msg.id, { content: [{ type: 'text', text: process.cwd() }] });
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
  mkdirSync(workdir, { recursive: true });

  let connections = [];
  try {
    connections = await withTimeout(
      connectMcpServers({
        mcpServers: {
          cwdserver: {
            command: 'node',
            args: [mockServerPath],
            cwd: workdir,
          },
        },
      }),
      10000,
      'connectMcpServers(cwdserver)',
    );

    const pwdTool = connections[0].tools.find((t) => t.name === 'cwdserver__pwd');
    assert.ok(pwdTool);
    const result = await withTimeout(
      pwdTool.execute({}, { workspaceDir: '/tmp', sessionKey: 'mcp-cwd' }),
      5000,
      'pwd.execute',
    );
    assert.equal(realpathSync(String(result)), realpathSync(workdir));
  } finally {
    await Promise.allSettled(connections.map((connection) => connection.close()));
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('  [PASS] real MCP server: cwd is passed to the spawned stdio process');

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

// ── Real MCP server: malformed stdout fails pending request promptly ──

{
  const mockServerPath = join(__dirname, '_mock_mcp_malformed_stdout.tmp.mjs');
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
        serverInfo: { name: 'malformed-stdout-server', version: '1.0.0' },
      });
      break;
    case 'tools/list':
      respond(msg.id, {
        tools: [{
          name: 'bad_stdout',
          description: 'Writes malformed stdout instead of JSON-RPC',
          inputSchema: { type: 'object', properties: {}, required: [] },
        }],
      });
      break;
    case 'tools/call':
      process.stdout.write('this is not json-rpc\\n');
      break;
  }
});
`;
  writeFileSync(mockServerPath, serverCode);

  let connections = [];
  try {
    connections = await withTimeout(
      connectMcpServers({
        mcpServers: {
          badstdout: {
            command: 'node',
            args: [mockServerPath],
            requestTimeoutMs: 500,
          },
        },
      }),
      10000,
      'connectMcpServers(badstdout)',
    );

    const badTool = connections[0].tools.find((t) => t.name === 'badstdout__bad_stdout');
    assert.ok(badTool);
    await assert.rejects(
      withTimeout(
        badTool.execute({}, { workspaceDir: '/tmp', sessionKey: 'mcp-bad-stdout' }),
        2000,
        'bad_stdout.execute',
      ),
      /timeout|timed out|aborted/i,
    );
  } finally {
    await Promise.allSettled(connections.map((connection) => connection.close()));
    rmSync(mockServerPath, { force: true });
  }
}

console.log('  [PASS] real MCP server: malformed stdout is skipped, request times out (not all pending failed)');

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

// ── Real MCP server: abort sends MCP cancellation notification ──

{
  const dir = mkdtempSync(join(tmpdir(), 'mcp-cancel-test-'));
  const mockServerPath = join(dir, 'mock_mcp_cancel.mjs');
  const cancelledPath = join(dir, 'cancelled.json');
  const sideEffectPath = join(dir, 'side-effect.txt');
  const serverCode = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const rl = createInterface({ input: process.stdin });
let active = null;

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === 'notifications/cancelled') {
    if (active && msg.params && msg.params.requestId === active.id) {
      clearTimeout(active.sideEffectTimer);
      clearTimeout(active.responseTimer);
      writeFileSync(${JSON.stringify(cancelledPath)}, JSON.stringify(msg));
      active = null;
    }
    return;
  }

  if (msg.id === undefined || msg.id === null) return;

  switch (msg.method) {
    case 'initialize':
      respond(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'cancel-server', version: '1.0.0' },
      });
      break;
    case 'tools/list':
      respond(msg.id, {
        tools: [{
          name: 'slow_side_effect',
          description: 'Delayed side effect',
          inputSchema: { type: 'object', properties: {}, required: [] },
        }],
      });
      break;
    case 'tools/call':
      active = {
        id: msg.id,
        sideEffectTimer: setTimeout(() => {
          writeFileSync(${JSON.stringify(sideEffectPath)}, 'side effect happened');
        }, 900),
        responseTimer: setTimeout(() => {
          respond(msg.id, { content: [{ type: 'text', text: 'done' }] });
          active = null;
        }, 900),
      };
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
          cancelserver: {
            command: 'node',
            args: [mockServerPath],
          },
        },
      }),
      10000,
      'connectMcpServers(cancelserver)',
    );

    const slowTool = connections[0].tools.find((t) => t.name === 'cancelserver__slow_side_effect');
    assert.ok(slowTool);

    const ac = new AbortController();
    const executePromise = slowTool.execute(
      {},
      { workspaceDir: '/tmp', sessionKey: 'mcp-cancel', abortSignal: ac.signal },
    );
    setTimeout(() => ac.abort('user cancelled'), 100);

    await assert.rejects(executePromise, /aborted|cancelled/i);
    await new Promise((resolve) => setTimeout(resolve, 800));

    assert.equal(existsSync(sideEffectPath), false, 'server side effect should be cancelled before it runs');
    assert.equal(existsSync(cancelledPath), true, 'server should receive notifications/cancelled');
    const cancellation = JSON.parse(readFileSync(cancelledPath, 'utf8'));
    assert.equal(cancellation.jsonrpc, '2.0');
    assert.equal(cancellation.method, 'notifications/cancelled');
    assert.equal(typeof cancellation.params.requestId, 'number');
    assert.match(String(cancellation.params.reason), /cancelled|aborted/i);

    await withTimeout(connections[0].close(), 5000, 'close');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('  [PASS] abort sends MCP cancellation notification before side effects continue');

// ── Real MCP server: timeout sends MCP cancellation notification ──

{
  const dir = mkdtempSync(join(tmpdir(), 'mcp-timeout-cancel-test-'));
  const mockServerPath = join(dir, 'mock_mcp_timeout_cancel.mjs');
  const cancelledPath = join(dir, 'cancelled.json');
  const sideEffectPath = join(dir, 'side-effect.txt');
  const serverCode = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const rl = createInterface({ input: process.stdin });
let active = null;

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === 'notifications/cancelled') {
    if (active && msg.params && msg.params.requestId === active.id) {
      clearTimeout(active.sideEffectTimer);
      writeFileSync(${JSON.stringify(cancelledPath)}, JSON.stringify(msg));
      active = null;
    }
    return;
  }

  if (msg.id === undefined || msg.id === null) return;

  switch (msg.method) {
    case 'initialize':
      respond(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'timeout-cancel-server', version: '1.0.0' },
      });
      break;
    case 'tools/list':
      respond(msg.id, {
        tools: [{
          name: 'never_finishes',
          description: 'Never responds unless cancelled',
          inputSchema: { type: 'object', properties: {}, required: [] },
        }],
      });
      break;
    case 'tools/call':
      active = {
        id: msg.id,
        sideEffectTimer: setTimeout(() => {
          writeFileSync(${JSON.stringify(sideEffectPath)}, 'side effect happened');
        }, 600),
      };
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
          timeoutserver: {
            command: 'node',
            args: [mockServerPath],
            requestTimeoutMs: 300,
          },
        },
      }),
      10000,
      'connectMcpServers(timeoutserver)',
    );

    const slowTool = connections[0].tools.find((t) => t.name === 'timeoutserver__never_finishes');
    assert.ok(slowTool);

    await assert.rejects(
      slowTool.execute({}, { workspaceDir: '/tmp', sessionKey: 'mcp-timeout' }),
      /timeout/i,
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));

    assert.equal(existsSync(sideEffectPath), false, 'server side effect should be cancelled on timeout');
    assert.equal(existsSync(cancelledPath), true, 'server should receive timeout cancellation');
    const cancellation = JSON.parse(readFileSync(cancelledPath, 'utf8'));
    assert.equal(cancellation.jsonrpc, '2.0');
    assert.equal(cancellation.method, 'notifications/cancelled');
    assert.equal(typeof cancellation.params.requestId, 'number');
    assert.match(String(cancellation.params.reason), /timeout/i);

    await withTimeout(connections[0].close(), 5000, 'close');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('  [PASS] timeout sends MCP cancellation notification before side effects continue');

// ── Real MCP server: initialize timeout is not cancelled ──

{
  const dir = mkdtempSync(join(tmpdir(), 'mcp-initialize-timeout-test-'));
  const mockServerPath = join(dir, 'mock_mcp_initialize_timeout.mjs');
  const cancelledPath = join(dir, 'initialize-cancelled.json');
  const serverCode = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === 'notifications/cancelled') {
    writeFileSync(${JSON.stringify(cancelledPath)}, JSON.stringify(msg.params ?? {}));
    return;
  }

  if (msg.method === 'initialize') {
    return;
  }

  if (msg.id !== undefined && msg.id !== null) {
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
    await assert.rejects(
      withTimeout(
        connectMcpServers({
          mcpServers: {
            initserver: {
              command: 'node',
              args: [mockServerPath],
              requestTimeoutMs: 120,
            },
          },
        }),
        5000,
        'connectMcpServers(initserver)',
      ),
      /timeout/i,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(
      existsSync(cancelledPath),
      false,
      'initialize requests must not be cancelled by the client',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('  [PASS] initialize timeout does not send MCP cancellation notification');

// ── Real MCP server: abort after response does not send late cancellation ──

{
  const dir = mkdtempSync(join(tmpdir(), 'mcp-late-abort-test-'));
  const mockServerPath = join(dir, 'mock_mcp_late_abort.mjs');
  const cancelledPath = join(dir, 'late-cancelled.json');
  const serverCode = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const rl = createInterface({ input: process.stdin });
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === 'notifications/cancelled') {
    writeFileSync(${JSON.stringify(cancelledPath)}, JSON.stringify(msg.params ?? {}));
    return;
  }

  if (msg.id === undefined || msg.id === null) return;

  switch (msg.method) {
    case 'initialize':
      respond(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'late-abort-server', version: '1.0.0' },
      });
      break;
    case 'tools/list':
      respond(msg.id, {
        tools: [{
          name: 'fast_tool',
          description: 'Responds immediately',
          inputSchema: { type: 'object', properties: {}, required: [] },
        }],
      });
      break;
    case 'tools/call':
      respond(msg.id, { content: [{ type: 'text', text: 'done' }] });
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
          lateserver: {
            command: 'node',
            args: [mockServerPath],
          },
        },
      }),
      10000,
      'connectMcpServers(lateserver)',
    );

    const fastTool = connections[0].tools.find((t) => t.name === 'lateserver__fast_tool');
    assert.ok(fastTool);

    const ac = new AbortController();
    const result = await fastTool.execute(
      {},
      { workspaceDir: '/tmp', sessionKey: 'mcp-late-abort', abortSignal: ac.signal },
    );
    assert.equal(result, 'done');

    ac.abort('too late');
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(
      existsSync(cancelledPath),
      false,
      'abort after a completed response must not send a late cancellation notification',
    );

    await withTimeout(connections[0].close(), 5000, 'close');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('  [PASS] abort after response does not send late MCP cancellation');

console.log('All MCP client checks passed.');
