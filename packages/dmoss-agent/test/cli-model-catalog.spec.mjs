#!/usr/bin/env node
/**
 * Regression for opencode-style model discoverability.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-model-catalog.spec.mjs
 */
import assert from 'node:assert/strict';
import {
  formatModelChoices,
  loadModelChoicesForRuntime,
  resolveModelSelection,
} from '../dist/cli/model-catalog.js';

const builtIn = await loadModelChoicesForRuntime({
  provider: 'openai-compatible',
  model: 'Moss',
  usingBundledDefault: true,
}, 'Moss');
assert.equal(builtIn.source, 'built-in');
assert.equal(builtIn.choices[0].model, 'Moss');
assert.match(formatModelChoices(builtIn), /\/model <number>/);
assert.match(formatModelChoices(builtIn), /moss setup\s+change provider, base URL, or API key/);

const selectedByNumber = resolveModelSelection('1', builtIn.choices);
assert.equal(selectedByNumber?.model, 'Moss');

const live = await loadModelChoicesForRuntime({
  provider: 'openai-compatible',
  baseUrl: 'https://example.com',
  apiKey: 'secret',
}, 'gpt-4o-mini', {
  fetchImpl: async () => new Response(JSON.stringify({
    data: [
      { id: 'gpt-4o-mini' },
      { id: 'gpt-4o' },
      { id: 'custom-coder' },
    ],
  }), { status: 200 }),
});
assert.equal(live.source, 'live');
assert.deepEqual(live.choices.map((choice) => choice.model), ['gpt-4o-mini', 'gpt-4o', 'custom-coder']);
assert.equal(resolveModelSelection('3', live.choices)?.model, 'custom-coder');
assert.equal(resolveModelSelection('openai-compatible/custom-coder', live.choices)?.model, 'custom-coder');

const fallback = await loadModelChoicesForRuntime({
  provider: 'qwen',
}, 'qwen3.7-max');
assert.equal(fallback.source, 'common');
assert.ok(fallback.choices.some((choice) => choice.model === 'qwen-plus'));

console.log('[PASS] CLI model catalog supports selectable model lists');
