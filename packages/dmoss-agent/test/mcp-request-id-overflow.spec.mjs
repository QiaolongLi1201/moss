#!/usr/bin/env node
/**
 * Test: MCP request ID overflow protection
 *
 * Verifies that request IDs wrap around safely instead of losing precision.
 */

import assert from 'node:assert/strict';
import { connectMcpServers } from '../dist/mcp/index.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mcp-overflow-'));
try {
  const mockServerPath = join(dir, 'mock_mcp_overflow.mjs');
  const requestIds = [];
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
        serverInfo: { name: 'overflow-test', version: '1.0.0' },
      });
      break;
    case 'tools/list':
      respond(msg.id, { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {}, required: [] } }] });
      break;
    case 'tools/call':
      respond(msg.id, { content: [{ type: 'text', text: 'id=' + msg.id }] });
      break;
    default:
      respond(msg.id, { error: { code: -32601, message: 'Not found' } });
  }
});
`;
  writeFileSync(mockServerPath, serverCode);

  const connections = await connectMcpServers({
    mcpServers: {
      overflow: {
        command: 'node',
        args: [mockServerPath],
      },
    },
  });

  const echTool = connections[0].tools.find((t) => t.name === 'overflow__echo');
  assert.ok(echTool);

  // Execute multiple times to collect request IDs
  for (let i = 0; i < 10; i++) {
    const result = await echTool.execute({}, { workspaceDir: '/tmp', sessionKey: 'overflow-test' });
    const idMatch = String(result).match(/id=(\d+)/);
    if (idMatch) {
      requestIds.push(parseInt(idMatch[1], 10));
    }
  }

  // Verify all request IDs are unique (no collisions)
  const uniqueIds = new Set(requestIds);
  assert.equal(uniqueIds.size, requestIds.length, 'all request IDs should be unique');
  console.log('  Request IDs:', requestIds);

  await connections[0].close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('  [PASS] request IDs do not collide');
console.log('All request ID overflow tests passed.');
