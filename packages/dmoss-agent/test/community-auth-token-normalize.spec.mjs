#!/usr/bin/env node
/**
 * normalizePortalToken must STRIP internal whitespace from a pasted token, not
 * replace it with '+'. A line-wrapped paste (header.\npayload.\nsignature) was
 * being turned into header.+payload.+signature — an invalid JWT.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/community-auth-token-normalize.spec.mjs
 */
import assert from 'node:assert/strict';
import { normalizePortalToken } from '../dist/cli/community-auth.js';

// A line-wrapped token must rejoin WITHOUT inserting '+' characters.
assert.equal(
  normalizePortalToken('aaaaaaaa.\nbbbbbbbb.\ncccccccc'),
  'aaaaaaaa.bbbbbbbb.cccccccc',
  'line breaks inside a token must be removed, not turned into "+"',
);
assert.doesNotMatch(normalizePortalToken('aaaaaaaa.\nbbbbbbbb'), /\+/, 'no "+" may be introduced');

// Bearer prefix + surrounding whitespace is stripped.
assert.equal(normalizePortalToken('  Bearer   abcdefghij  '), 'abcdefghij');

// Tabs/spaces between segments are removed too.
assert.equal(normalizePortalToken('abcd\t efgh \r\n ijkl'), 'abcdefghijkl');

// Too-short tokens normalize to empty.
assert.equal(normalizePortalToken('abc'), '');
assert.equal(normalizePortalToken(undefined), '');

console.log('[PASS] normalizePortalToken strips whitespace instead of inserting "+"');
