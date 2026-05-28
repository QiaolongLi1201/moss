#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  formatMissingSshExecutable,
  isMissingExecutableError,
  missingSshExecutableProcessError,
} from '../dist/tools/ssh-utils.js';
import { ProcessError } from '../dist/utils/run-process.js';

assert.equal(isMissingExecutableError({ code: 'ENOENT', path: 'ssh' }, 'ssh'), true);
assert.equal(isMissingExecutableError({ code: 'ENOENT', path: 'git' }, 'ssh'), false);

const sshMessage = formatMissingSshExecutable('ssh');
assert.match(sshMessage, /OpenSSH/);

const sshpassMessage = formatMissingSshExecutable('sshpass');
assert.match(sshpassMessage, /DMOSS_DEVICE_KEY/);

const wrapped = missingSshExecutableProcessError({ code: 'ENOENT', path: 'sshpass' }, 'sshpass');
assert.ok(wrapped instanceof ProcessError);
assert.equal(wrapped.exitCode, 127);
assert.match(wrapped.stderr, /sshpass/);

console.log('[pass] ssh-utils: missing executable diagnostics');
