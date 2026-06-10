#!/usr/bin/env node
/**
 * Regression: generic arm64/arm Linux must NOT be detected as an RDK board.
 * Before the fix, isLikelyBoardRuntime() returned true for ANY linux+arm64
 * (Apple-silicon Docker/WSL, AWS Graviton, arm64 CI), which flipped the TUI
 * into "On-board Agent" with "device workflows unlocked".
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-board-detection.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inferExecutionMode, executionPlaneSummary } from '../dist/cli/tui.js';

function withProcessProps(props, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(props)) {
    saved[key] = Object.getOwnPropertyDescriptor(process, key);
    Object.defineProperty(process, key, { value, configurable: true });
  }
  try {
    return fn();
  } finally {
    for (const [key, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(process, key, desc);
    }
  }
}

function withoutEnv(keys, fn) {
  const saved = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A real board (matching device-tree model) legitimately reports on-board;
// skip the generic-arm64 assertions there.
let realBoardDeviceTree = false;
try {
  const model = fs.readFileSync('/proc/device-tree/model', 'utf8').toLowerCase();
  realBoardDeviceTree = /rdk|d-robotics|horizon|raspberry|rockchip|jetson/.test(model);
} catch {
  realBoardDeviceTree = false;
}

const BOARD_ENV = ['DMOSS_BOARD_RUNTIME', 'DMOSS_HYBRID_MODE', 'RDK_BOARD', 'RDK_MODEL', 'TROS_DISTRO'];

withoutEnv(BOARD_ENV, () => {
  // 1) Generic arm64 Linux without an RDK/board device-tree → pc-host.
  if (!realBoardDeviceTree) {
    for (const arch of ['arm64', 'arm']) {
      withProcessProps({ platform: 'linux', arch }, () => {
        assert.equal(
          inferExecutionMode(),
          'pc-host',
          `linux/${arch} without board evidence must be pc-host`,
        );
        const summary = executionPlaneSummary({
          config: { provider: 'deepseek', safetyMode: 'workspace-write', approvalPolicy: 'prompt' },
        });
        assert.equal(summary.mode, 'pc-host');
        assert.doesNotMatch(summary.runningOn, /RDK board/i);
      });
    }
    console.log('  [PASS] generic arm64/arm Linux is pc-host, not on-board');
  } else {
    console.log('  [SKIP] real board device-tree present; generic-arm64 case not applicable');
  }

  // 2) Non-linux is never a board, regardless of arch.
  withProcessProps({ platform: 'darwin', arch: 'arm64' }, () => {
    assert.equal(inferExecutionMode(), 'pc-host');
  });
  console.log('  [PASS] darwin/arm64 is pc-host');

  // 3) Explicit env still wins.
  process.env.DMOSS_BOARD_RUNTIME = '1';
  try {
    assert.equal(inferExecutionMode(), 'on-board');
  } finally {
    delete process.env.DMOSS_BOARD_RUNTIME;
  }
  console.log('  [PASS] DMOSS_BOARD_RUNTIME=1 still forces on-board');
});

console.log('[PASS] CLI board detection');
