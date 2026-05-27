#!/usr/bin/env node
/**
 * Test: web_fetch security error downgrade fix
 *
 * Verifies that TOOL_NOT_ALLOWED errors are not downgraded to TOOL_EXECUTION_FAILED.
 */

import assert from 'node:assert/strict';
import { createWebFetchTool } from '../dist/tools/web-fetch.js';
import { DmossError, ErrorCode } from '../dist/errors.js';

// Mock DNS resolver that returns a private IP (127.0.0.1)
const mockPrivateResolver = async () => ['127.0.0.1'];

const tool = createWebFetchTool({
  resolveHostAddresses: mockPrivateResolver,
  blockPrivateNetwork: true, // Default, but explicit
});

console.log('[TEST] SSRF protection error preservation');
{
  try {
    await tool.execute({ url: 'http://example.com/secret' }, { workspaceDir: '/tmp', sessionKey: 'test' });
    assert.fail('Should have thrown TOOL_NOT_ALLOWED');
  } catch (err) {
    assert.ok(err instanceof DmossError, 'Should be DmossError');
    assert.equal(err.code, ErrorCode.TOOL_NOT_ALLOWED, `Expected TOOL_NOT_ALLOWED, got ${err.code}`);
    assert.equal(err.recoverable, false, 'Security errors should not be recoverable');
    console.log('  ✓ TOOL_NOT_ALLOWED preserved (not downgraded to TOOL_EXECUTION_FAILED)');
  }
}

console.log('[TEST] Redirect to private host error preservation');
{
  // Mock a redirect scenario: first request returns 302 to 127.0.0.1
  // We can't easily mock this without a real HTTP server, so we test the
  // direct private IP check instead
  try {
    await tool.execute({ url: 'http://127.0.0.1/secret' }, { workspaceDir: '/tmp', sessionKey: 'test' });
    assert.fail('Should have thrown TOOL_NOT_ALLOWED');
  } catch (err) {
    assert.ok(err instanceof DmossError, 'Should be DmossError');
    assert.equal(err.code, ErrorCode.TOOL_NOT_ALLOWED, `Expected TOOL_NOT_ALLOWED, got ${err.code}`);
    assert.equal(err.recoverable, false, 'Security errors should not be recoverable');
    console.log('  ✓ Direct private IP access blocked with correct error code');
  }
}

console.log('[PASS] web_fetch security error downgrade tests');
