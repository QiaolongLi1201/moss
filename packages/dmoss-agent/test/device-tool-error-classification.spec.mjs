#!/usr/bin/env node
/**
 * Regression: device tool failures must be classified as errors.
 * Before the fix, SSH failures (missing sshpass/ssh helper, unreachable host,
 * non-zero remote exit) were RETURNED as plain strings, so the CLI showed
 * "ok device command ok 1ms" for a board that was never reached, and skill
 * evidence recorded failed:false.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/device-tool-error-classification.spec.mjs
 */
import assert from 'node:assert/strict';
import { createDeviceSshTools } from '../dist/tools/device-ssh.js';
import { createDeviceDiagnosticsTools } from '../dist/tools/device-diagnostics.js';

// Password auth + unroutable host: fails fast either because the sshpass
// helper is missing (exit 127 path) or because the connection is refused —
// both must REJECT, not return an error-shaped success string.
const config = {
  host: '127.0.0.1',
  port: 1, // nothing listens on tcpmux; connection fails immediately
  user: 'root',
  password: 'wrong',
  connectTimeoutMs: 2000,
};

const sshTools = Object.fromEntries(createDeviceSshTools(config).map((t) => [t.name, t]));
const diagTools = Object.fromEntries(createDeviceDiagnosticsTools(config).map((t) => [t.name, t]));
const ctx = { workspaceDir: process.cwd() };

await assert.rejects(
  () => sshTools.device_info.execute({}, ctx),
  /sshpass|ssh|exit|connect|refused/i,
  'device_info must throw when the device is unreachable',
);
console.log('  [PASS] device_info throws on unreachable device');

await assert.rejects(
  () => sshTools.device_exec.execute({ command: 'uname -a', timeout_ms: 3000 }, ctx),
  /sshpass|ssh|exit|connect|refused/i,
  'device_exec must throw when the device is unreachable',
);
console.log('  [PASS] device_exec throws on unreachable device');

await assert.rejects(
  () => diagTools.device_resources.execute({}, ctx),
  /sshpass|ssh|exit|connect|refused/i,
  'device_resources must throw when the device is unreachable',
);
console.log('  [PASS] device_resources (diagnostics family) throws on unreachable device');

console.log('[PASS] device tool error classification');
