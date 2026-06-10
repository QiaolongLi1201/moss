#!/usr/bin/env node
/**
 * @rdk-moss/core — buildLanguagePolicyPrompt content unit test
 *
 * Guards the response-language contract: English by default, auto-switch to the
 * language of the user's most recent message, and never translate code/identifiers.
 *
 * Run after package build:
 *   npm run build -w @rdk-moss/core && node packages/dmoss/test/language-policy-prompt.spec.mjs
 */
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'index.js');
const mod = await import(pathToFileURL(distJs).href);
const { buildLanguagePolicyPrompt, buildLanguagePolicyPromptQuick } = mod;

assert.equal(typeof buildLanguagePolicyPrompt, 'function', 'buildLanguagePolicyPrompt should be exported');
assert.equal(typeof buildLanguagePolicyPromptQuick, 'function', 'buildLanguagePolicyPromptQuick should be exported');

const full = buildLanguagePolicyPrompt();
assert.equal(typeof full, 'string', 'should return a string');
assert.ok(full.length > 120, 'should be a substantive directive');
for (const marker of [
  'Response Language',
  'Default to English',
  "most recent message",
  'Chinese',
  'ambiguous',
  'verbatim',
  'never translate',
  'explicitly asks for a specific output language',
]) {
  assert.ok(full.includes(marker), `language policy should include "${marker}"`);
}
// The directive itself must be written in English so it reads as an instruction
// regardless of what language the model would otherwise default to.
assert.ok(!/[一-鿿]/.test(full), 'the language directive prose should be English (no CJK)');

const quick = buildLanguagePolicyPromptQuick();
assert.equal(typeof quick, 'string', 'brief variant should return a string');
assert.ok(quick.length > 40, 'brief variant should have content');
for (const marker of ['Default to English', 'Chinese', 'English']) {
  assert.ok(quick.includes(marker), `brief language policy should include "${marker}"`);
}
assert.ok(!/[一-鿿]/.test(quick), 'the brief language directive prose should be English (no CJK)');

console.log('[language-policy-prompt.spec] PASS');
