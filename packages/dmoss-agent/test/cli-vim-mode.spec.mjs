#!/usr/bin/env node
/**
 * Vim modal handler: DMOSS_VIM_MODE actually enables it, NORMAL/INSERT
 * transitions, basic motions/delete. Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import {
  handleVimKey, getVimState, getVimModeIndicator, setVimMode, isVimEnabled,
} from '../dist/cli/input/vim.js';

// Disabled: handler is inert and reads env honestly.
delete process.env.DMOSS_VIM_MODE;
assert.equal(isVimEnabled(), false);
assert.deepEqual(handleVimKey('i', 0, 0), { type: 'none' });

// Enabled via env (the "DMOSS_VIM_MODE=1 actually enables it" contract).
process.env.DMOSS_VIM_MODE = '1';
assert.equal(isVimEnabled(), true);

setVimMode('normal');
assert.equal(getVimModeIndicator(), 'NORMAL');

// i → INSERT
let a = handleVimKey('i', 0, 0);
assert.equal(a.type, 'mode');
assert.equal(getVimState().mode, 'insert');
assert.equal(getVimModeIndicator(), 'INSERT');

// Esc → NORMAL
a = handleVimKey('escape', 5, 5);
assert.equal(getVimState().mode, 'normal');
assert.equal(getVimModeIndicator(), 'NORMAL');

// l → move right one char
a = handleVimKey('l', 0, 5);
assert.equal(a.type, 'move');
assert.equal(a.move.direction, 'right');

// h → move left
a = handleVimKey('h', 3, 5);
assert.equal(a.type, 'move');
assert.equal(a.move.direction, 'left');

// x → delete char
a = handleVimKey('x', 0, 5);
assert.equal(a.type, 'edit');
assert.equal(a.edit.op, 'delete');

delete process.env.DMOSS_VIM_MODE;
console.log('[PASS] cli-vim-mode: env-enable + NORMAL/INSERT transitions + motions/delete');
