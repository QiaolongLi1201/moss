#!/usr/bin/env node
/**
 * Vim normal-mode count prefix must accept '0' as a non-leading digit, so a
 * count like 10 works. The digit-accumulation guard used /^[1-9]$/, which made
 * '0' fall through to the line-start motion even mid-count.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/vim-count-digit-zero.spec.mjs
 */
import assert from 'node:assert/strict';

// handleVimKey is gated on isVimEnabled() (DMOSS_VIM_MODE=1); enable before import-side use.
process.env.DMOSS_VIM_MODE = '1';
const { handleVimKey, getVimState, setVimMode } = await import('../dist/cli/input/vim.js');

setVimMode('normal');
// A bare '0' is the line-start motion, not the start of a count.
handleVimKey('0', 5, 10);
assert.equal(getVimState().countPrefix, '', "'0' with no prefix is a motion, not a count");

// '0' after a non-zero digit must accumulate into a multi-digit count (10).
handleVimKey('1', 5, 10);
assert.equal(getVimState().countPrefix, '1', "'1' starts a count");
handleVimKey('0', 5, 10);
assert.equal(getVimState().countPrefix, '10', "'0' must accumulate into the count to form 10");

console.log('[PASS] vim count prefix accepts 0 as a non-leading digit');
