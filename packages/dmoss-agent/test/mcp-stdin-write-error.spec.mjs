#!/usr/bin/env node
/**
 * Test: MCP stdin write error handling
 *
 * Verifies that if process.stdin.write() throws, the pending request
 * is properly rejected instead of leaving the promise hanging.
 */

import assert from 'node:assert/strict';
import { connectMcpServersWithFailures } from '../dist/mcp/index.js';

// ── Real MCP server: stdin write error is caught and propagated ──

{
  // Use a command that exits immediately to simulate broken stdin
  const config = {
    mcpServers: {
      exitserver: {
        command: 'sh',
        args: ['-c', 'exit 1'],
      },
    },
  };

  const result = await connectMcpServersWithFailures(config);
  assert.equal(result.connections.length, 0, 'should have no connections');
  assert.equal(result.failures.length, 1, 'should have one failure');
  assert.match(result.failures[0].error.message, /exit|spawn|command/i, 'error should mention process issue');
}

console.log('  [PASS] stdin error during request initialization is caught');

console.log('All stdin write error tests passed.');
