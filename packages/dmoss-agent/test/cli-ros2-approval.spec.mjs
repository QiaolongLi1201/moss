#!/usr/bin/env node
/**
 * Test: ROS2 tools must declare side-effect metadata so the CLI approval gate
 * treats actuating calls (ros2_service_call, ros2_launch) as device mutations.
 *
 * Regression: with no metadata the approval layer's name-inference defaulted
 * these to 'readonly' (the mutating-verb regex lacks 'call'/'launch'), so they
 * ran with NO confirmation AND were permitted in --read-only mode — a model
 * could actuate the robot ungated in the safest CLI mode.
 */

import assert from 'node:assert/strict';
import { createRos2Tools } from '../dist/tools/device-ros2.js';
import {
  describeCliToolApproval,
  createCliToolApprovalHook,
} from '../dist/cli/approval.js';

const CONFIG = { host: '10.0.0.9', user: 'root', password: 'secret' };
const tools = Object.fromEntries(createRos2Tools(CONFIG).map((t) => [t.name, t]));

const MUTATING = ['ros2_service_call', 'ros2_launch'];
const READONLY = [
  'ros2_topic_list',
  'ros2_topic_echo',
  'ros2_topic_hz',
  'ros2_node_list',
  'ros2_service_list',
  'ros2_pkg_list',
];

// 1. Mutating ros2 tools must be classified device_mutation, require approval,
//    and be denied in --read-only mode.
console.log('[TEST] ros2_service_call / ros2_launch are gated device mutations');
for (const name of MUTATING) {
  const tool = tools[name];
  assert.ok(tool, `${name} should exist`);
  assert.equal(
    tool.metadata?.sideEffectClass,
    'device_mutation',
    `${name} must declare sideEffectClass device_mutation`,
  );

  const preview = describeCliToolApproval(
    { tool, input: {}, sessionKey: 's' },
    'workspace-write',
    {},
  );
  assert.equal(preview.sideEffect, 'device_mutation', `${name} must not be inferred readonly`);
  assert.equal(preview.requiresApproval, true, `${name} must require approval`);

  const approveReadOnly = createCliToolApprovalHook('read-only', {});
  const denied = await approveReadOnly({ tool, input: {}, sessionKey: 's' });
  assert.equal(denied.approved, false, `${name} must be denied in --read-only mode`);
  assert.match(denied.reason, /read-only/, `${name} denial should cite read-only mode`);
}

// 2. Read-only ros2 tools stay readonly and remain allowed in --read-only mode.
console.log('[TEST] read-only ros2 tools remain readonly + allowed in --read-only');
for (const name of READONLY) {
  const tool = tools[name];
  assert.ok(tool, `${name} should exist`);
  assert.equal(tool.metadata?.sideEffectClass, 'readonly', `${name} should declare readonly`);
  const approveReadOnly = createCliToolApprovalHook('read-only', {});
  const res = await approveReadOnly({ tool, input: {}, sessionKey: 's' });
  assert.equal(res.approved, true, `${name} should be allowed in --read-only mode`);
}

console.log('[PASS] ros2 approval metadata gates actuating calls');
