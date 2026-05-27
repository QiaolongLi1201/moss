#!/usr/bin/env node
/**
 * Test: MCP subprocess environment inheritance
 *
 * Verifies that MCP subprocesses use safeChildEnv and don't inherit host secrets.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { safeChildEnv } from '../dist/utils/safe-child-env.js';

console.log('[TEST] safeChildEnv strips host secrets');
{
  // Set some dangerous env vars in the host process
  process.env.DMOSS_API_KEY = 'secret-key-123';
  process.env.OPENAI_API_KEY = 'sk-secret-456';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-789';
  process.env.SAFE_VAR = 'this-is-safe';

  const safeEnv = safeChildEnv({ MCP_CUSTOM_VAR: 'custom-value' });

  // Verify dangerous vars are stripped
  assert.equal(safeEnv.DMOSS_API_KEY, undefined, 'DMOSS_API_KEY should be stripped');
  assert.equal(safeEnv.OPENAI_API_KEY, undefined, 'OPENAI_API_KEY should be stripped');
  assert.equal(safeEnv.ANTHROPIC_API_KEY, undefined, 'ANTHROPIC_API_KEY should be stripped');

  // Verify safe vars are preserved
  assert.equal(safeEnv.SAFE_VAR, 'this-is-safe', 'SAFE_VAR should be preserved');

  // Verify custom overrides are applied
  assert.equal(safeEnv.MCP_CUSTOM_VAR, 'custom-value', 'MCP_CUSTOM_VAR should be applied');

  console.log('  ✓ safeChildEnv strips host secrets and preserves safe vars');

  // Cleanup
  delete process.env.DMOSS_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SAFE_VAR;
}

console.log('[TEST] MCP subprocess receives safe environment');
{
  // Create a simple script that echoes env vars
  const script = `
    console.log(JSON.stringify({
      DMOSS_API_KEY: process.env.DMOSS_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      SAFE_VAR: process.env.SAFE_VAR,
      MCP_CUSTOM_VAR: process.env.MCP_CUSTOM_VAR,
    }));
  `;

  // Set host env vars
  process.env.DMOSS_API_KEY = 'secret-key-123';
  process.env.OPENAI_API_KEY = 'sk-secret-456';
  process.env.SAFE_VAR = 'this-is-safe';

  const safeEnv = safeChildEnv({ MCP_CUSTOM_VAR: 'custom-value' });

  const child = spawn('node', ['-e', script], {
    env: safeEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });

  await new Promise((resolve) => child.on('close', resolve));

  const env = JSON.parse(output.trim());

  // Verify subprocess doesn't receive secrets
  assert.equal(env.DMOSS_API_KEY, undefined, 'Subprocess should not receive DMOSS_API_KEY');
  assert.equal(env.OPENAI_API_KEY, undefined, 'Subprocess should not receive OPENAI_API_KEY');

  // Verify subprocess receives safe vars
  assert.equal(env.SAFE_VAR, 'this-is-safe', 'Subprocess should receive SAFE_VAR');
  assert.equal(env.MCP_CUSTOM_VAR, 'custom-value', 'Subprocess should receive MCP_CUSTOM_VAR');

  console.log('  ✓ MCP subprocess receives safe environment without host secrets');

  // Cleanup
  delete process.env.DMOSS_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.SAFE_VAR;
}

console.log('[PASS] MCP subprocess environment inheritance tests');
