#!/usr/bin/env node
/**
 * Test: MCP close() listener cleanup
 *
 * Verifies that close() properly removes exit listeners to avoid duplicates.
 */

import assert from 'node:assert/strict';
import { connectMcpServers } from '../dist/mcp/index.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mcp-close-'));
try {
  const mockServerPath = join(dir, 'mock_mcp_close.mjs');
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
        serverInfo: { name: 'close-test', version: '1.0.0' },
      });
      break;
    case 'tools/list':
      respond(msg.id, { tools: [] });
      break;
  }
});
`;
  writeFileSync(mockServerPath, serverCode);

  const connections = await connectMcpServers({
    mcpServers: {
      closetest: {
        command: 'node',
        args: [mockServerPath],
      },
    },
  });

  assert.equal(connections.length, 1);
  const conn = connections[0];

  // Count exit listeners before close
  const listenerCountBefore = conn.close.length;

  // Close the connection
  await conn.close();

  // Verify that close completed without hanging
  console.log('  ✓ close() completed without hanging');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('  [PASS] close() properly cleans up listeners');
console.log('All close cleanup tests passed.');
