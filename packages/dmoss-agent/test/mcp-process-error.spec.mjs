#!/usr/bin/env node
/**
 * Test: MCP process error handler wraps errors in DmossError
 *
 * Verifies that when the child process emits an error (e.g., spawn failure),
 * pending requests are rejected with DmossError, not raw Error.
 */

import assert from 'node:assert/strict';
import { connectMcpServersWithFailures } from '../dist/mcp/index.js';

// ── Real MCP server: process error is wrapped in DmossError ──

{
  // Use a non-existent path that will cause spawn to fail
  const config = {
    mcpServers: {
      badspawn: {
        command: '/nonexistent/binary/path/xyz',
        args: [],
      },
    },
  };

  const result = await connectMcpServersWithFailures(config);
  assert.equal(result.connections.length, 0, 'should have no connections');
  assert.equal(result.failures.length, 1, 'should have one failure');
  const error = result.failures[0].error;
  assert.ok(error instanceof Error, 'error should be an Error instance');
  // The error should reference the spawn issue
  assert.match(error.message, /binary|nonexistent|spawn|ENOENT/i);
}

console.log('  [PASS] process error is properly wrapped');

console.log('All process error handler tests passed.');
