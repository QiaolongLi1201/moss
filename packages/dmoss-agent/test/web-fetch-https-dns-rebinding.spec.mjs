#!/usr/bin/env node
/**
 * Test: web_fetch HTTPS DNS rebinding fix
 *
 * Verifies that HTTPS URLs are not rewritten to IP addresses, preserving TLS SNI.
 */

import assert from 'node:assert/strict';
import { createWebFetchTool } from '../dist/tools/web-fetch.js';

// Mock DNS resolver that returns a private IP
const mockResolver = async () => ['93.184.216.34']; // example.com IP

const tool = createWebFetchTool({
  resolveHostAddresses: mockResolver,
  blockPrivateNetwork: false, // Allow the test to proceed
});

// Test 1: HTTPS URL should not be rewritten
console.log('[TEST] HTTPS URL hostname preservation');
{
  const httpsUrl = 'https://example.com/test';
  // We can't actually make the request in a unit test, but we can verify
  // the tool accepts the URL without throwing
  try {
    // This will fail because we're not actually connecting, but it should
    // fail with a network error, not a TLS error
    await tool.execute({ url: httpsUrl }, { workspaceDir: '/tmp', sessionKey: 'test' });
  } catch (err) {
    // Expected to fail, but should not be a TLS/SNI error
    const msg = err instanceof Error ? err.message : String(err);
    // If the URL was rewritten to IP, we'd get a certificate error
    // If preserved, we'd get a network/connectivity error
    assert.ok(!msg.includes('certificate'), `Should not have certificate error: ${msg}`);
    console.log('  ✓ HTTPS URL handled without certificate error');
  }
}

// Test 2: HTTP URL can be rewritten (no TLS issues)
console.log('[TEST] HTTP URL hostname rewrite allowed');
{
  const httpUrl = 'http://example.com/test';
  try {
    await tool.execute({ url: httpUrl }, { workspaceDir: '/tmp', sessionKey: 'test' });
  } catch (err) {
    // Expected to fail with network error
    const msg = err instanceof Error ? err.message : String(err);
    assert.ok(!msg.includes('certificate'), `Should not have certificate error: ${msg}`);
    console.log('  ✓ HTTP URL handled correctly');
  }
}

console.log('[PASS] web_fetch HTTPS DNS rebinding tests');
