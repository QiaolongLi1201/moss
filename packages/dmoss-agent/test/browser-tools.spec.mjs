#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/browser-tools.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { builtinTools } from '../dist/tools/builtin.js';

const names = builtinTools.map((tool) => tool.name);
assert.ok(names.includes('web_browser_fetch'), 'builtin tools should include web_browser_fetch');
assert.ok(names.includes('web_browser_control'), 'builtin tools should include web_browser_control');

const fetchTool = builtinTools.find((tool) => tool.name === 'web_browser_fetch');
const controlTool = builtinTools.find((tool) => tool.name === 'web_browser_control');
assert.ok(fetchTool, 'web_browser_fetch tool should be registered');
assert.ok(controlTool, 'web_browser_control tool should be registered');

const oldExecutable = process.env.DMOSS_BROWSER_EXECUTABLE;
process.env.DMOSS_BROWSER_EXECUTABLE = '/definitely/missing/chromium-for-dmoss-test';
try {
  const missingBrowserResult = await fetchTool.execute(
    { url: 'https://example.com' },
    { workspaceDir: '/tmp', sessionKey: 'browser-tools-missing' },
  );
  assert.match(missingBrowserResult, /web_browser_fetch 未执行/);
  assert.match(missingBrowserResult, /DMOSS_BROWSER_EXECUTABLE|Chromium|Chrome|browser/i);
} finally {
  if (oldExecutable === undefined) {
    delete process.env.DMOSS_BROWSER_EXECUTABLE;
  } else {
    process.env.DMOSS_BROWSER_EXECUTABLE = oldExecutable;
  }
}

const liveExecutable = process.env.DMOSS_BROWSER_LIVE_EXECUTABLE || process.env.DMOSS_BROWSER_EXECUTABLE;
if (liveExecutable && fs.existsSync(liveExecutable)) {
  const result = await fetchTool.execute(
    { url: 'https://example.com', extraWaitMs: 0, timeoutMs: 15_000 },
    { workspaceDir: '/tmp', sessionKey: 'browser-tools-live' },
  );
  assert.match(result, /web_browser_fetch_ok/);
  assert.match(result, /Example Domain/);
}

console.log('[PASS] browser tools are registered and expose actionable browser configuration feedback');
