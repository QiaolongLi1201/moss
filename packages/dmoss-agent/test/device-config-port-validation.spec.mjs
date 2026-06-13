#!/usr/bin/env node
import assert from 'node:assert/strict';
import { getDeviceConfigFromEnv } from '../dist/tools/device-ssh.js';

const originalPort = process.env.DMOSS_DEVICE_PORT;
const originalHost = process.env.DMOSS_DEVICE_HOST;

try {
  // Valid port
  process.env.DMOSS_DEVICE_HOST = '10.0.0.1';
  process.env.DMOSS_DEVICE_PORT = '22';
  const config1 = getDeviceConfigFromEnv();
  assert.equal(config1.port, 22);
  console.log('  [PASS] valid port 22 accepted');

  // Port out of range
  process.env.DMOSS_DEVICE_PORT = '999999';
  assert.throws(() => getDeviceConfigFromEnv(), /port.*65535|Invalid.*PORT/i, 'port > 65535 must throw');
  console.log('  [PASS] port 999999 rejected');

  // Negative port
  process.env.DMOSS_DEVICE_PORT = '-1';
  assert.throws(() => getDeviceConfigFromEnv(), /port.*65535|Invalid.*PORT/i, 'negative port must throw');
  console.log('  [PASS] negative port rejected');

  // Port 0
  process.env.DMOSS_DEVICE_PORT = '0';
  assert.throws(() => getDeviceConfigFromEnv(), /port.*65535|Invalid.*PORT/i, 'port 0 must throw');
  console.log('  [PASS] port 0 rejected');

  // Non-numeric port
  process.env.DMOSS_DEVICE_PORT = 'invalid';
  assert.throws(() => getDeviceConfigFromEnv(), /port.*65535|Invalid.*PORT/i, 'non-numeric port must throw');
  console.log('  [PASS] non-numeric port rejected');

  console.log('[PASS] device-config port validation');
} finally {
  process.env.DMOSS_DEVICE_PORT = originalPort;
  process.env.DMOSS_DEVICE_HOST = originalHost;
}
