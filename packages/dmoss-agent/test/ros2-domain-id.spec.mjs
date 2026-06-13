#!/usr/bin/env node
/**
 * ros2_* tools must pin ROS_DOMAIN_ID when the device config specifies a
 * domain — otherwise a robot on a non-default DDS domain silently returns
 * empty topic/node/service lists (looks like 'the tool doesn't work').
 *
 * Red before fix: ros2DomainPrefix does not exist and the remote command
 * never contains ROS_DOMAIN_ID. Green after: the export is prepended.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import { ros2DomainPrefix } from '../dist/tools/device-ros2.js';
import { getDeviceConfigFromEnv } from '../dist/tools/device-ssh.js';

// 1. No domain configured -> no export (byte-for-byte current behavior).
assert.equal(ros2DomainPrefix({ host: 'h' }), '');

// 2. Domain configured -> export prefix that the remote shell will run
//    before sourcing the ROS setup.
assert.equal(ros2DomainPrefix({ host: 'h', rosDomainId: 42 }), 'export ROS_DOMAIN_ID=42; ');
assert.equal(ros2DomainPrefix({ host: 'h', rosDomainId: 0 }), 'export ROS_DOMAIN_ID=0; ');

// 3. DMOSS_ROS_DOMAIN_ID flows from env into the device config.
const savedHost = process.env.DMOSS_DEVICE_HOST;
const savedDomain = process.env.DMOSS_ROS_DOMAIN_ID;
try {
  process.env.DMOSS_DEVICE_HOST = '10.0.0.9';
  process.env.DMOSS_ROS_DOMAIN_ID = '7';
  assert.equal(getDeviceConfigFromEnv().rosDomainId, 7);

  process.env.DMOSS_ROS_DOMAIN_ID = '';
  assert.equal(getDeviceConfigFromEnv().rosDomainId, undefined, 'blank domain is ignored');

  process.env.DMOSS_ROS_DOMAIN_ID = 'not-a-number';
  assert.equal(getDeviceConfigFromEnv().rosDomainId, undefined, 'invalid domain is ignored');
} finally {
  if (savedHost === undefined) delete process.env.DMOSS_DEVICE_HOST; else process.env.DMOSS_DEVICE_HOST = savedHost;
  if (savedDomain === undefined) delete process.env.DMOSS_ROS_DOMAIN_ID; else process.env.DMOSS_ROS_DOMAIN_ID = savedDomain;
}

console.log('[PASS] ros2 tools pin ROS_DOMAIN_ID from config/env');
