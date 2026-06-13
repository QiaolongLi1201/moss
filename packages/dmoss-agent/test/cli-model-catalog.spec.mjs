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
  formatCustomModelConfigInstructions,
  formatModelChoices,
  loadModelChoicesForRuntime,
  parseCustomModelConfigInput,
  resolveModelSelection,
} from '../dist/cli/model-catalog.js';

// In-session BYOK instructions must be preset-prefilled (no looking up base_url/
// model): a user picks their provider's line and only pastes the key. The
// prefilled lines must themselves parse via parseCustomModelConfigInput.
{
  const instr = formatCustomModelConfigInstructions('/tmp/cfg.json');
  assert.match(instr, /deepseek/i, 'instructions list DeepSeek as a ready line');
  assert.match(instr, /api\.deepseek\.com/, 'DeepSeek line prefills the base URL');
  assert.match(instr, /paste-your-key/, 'the only thing the user fills is the key');
  assert.match(instr, /moss setup/, 'instructions point at the guided setup alternative');
  // The DeepSeek prefilled line (with a real key substituted) must actually parse.
  const dsLine = instr.split('\n').find((l) => /provider=deepseek/.test(l)) ?? '';
  const raw = dsLine.slice(dsLine.indexOf('provider=')).replace('key=<paste-your-key>', 'key=fake-key-1234');
  const parsed = parseCustomModelConfigInput(raw);
  assert.equal(parsed.ok, true, 'the prefilled DeepSeek line parses once a key is pasted');
  assert.equal(parsed.config.provider, 'deepseek');
  assert.equal(parsed.config.baseUrl, 'https://api.deepseek.com');
  assert.equal(parsed.config.apiKey, 'fake-key-1234');
}

const builtIn = await loadModelChoicesForRuntime({
  provider: 'openai-compatible',
  model: 'Moss',
  usingBundledDefault: true,
  configPath: '/tmp/dmoss/config.json',
}, 'Moss');
assert.equal(builtIn.source, 'built-in');
assert.equal(builtIn.choices[0].model, 'Moss');
assert.match(formatModelChoices(builtIn), /\/model <number>/);
assert.match(formatModelChoices(builtIn), /\/model config base_url=/);
assert.match(formatModelChoices(builtIn), /config file\s+\/tmp\/dmoss\/config\.json/);
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

const customConfig = parseCustomModelConfigInput('base_url=https://gateway.example/v1 key=sk-test model_name=custom-coder image_input=true');
assert.equal(customConfig.ok, true);
assert.equal(customConfig.config.provider, 'openai-compatible');
assert.equal(customConfig.config.baseUrl, 'https://gateway.example');
assert.equal(customConfig.config.apiKey, 'sk-test');
assert.equal(customConfig.config.model, 'custom-coder');
assert.equal(customConfig.config.imageInput, true);

const invalidCustomConfig = parseCustomModelConfigInput('base_url=https://gateway.example/v1 model_name=custom-coder');
assert.equal(invalidCustomConfig.ok, false);
assert.match(invalidCustomConfig.message, /api key/i);

console.log('[PASS] CLI model catalog supports selectable model lists');
// Malformed / non-http(s) base_url must be rejected, not silently accepted and
// then fail opaquely at the first model call.
for (const badBaseUrl of ['notaurl', 'htps://gateway.example', 'ftp://gateway.example/api', 'localhost:8080']) {
  const bad = parseCustomModelConfigInput(`base_url=${badBaseUrl} key=sk-test model_name=custom-coder`);
  assert.equal(bad.ok, false, `expected ${badBaseUrl} to be rejected`);
  assert.match(bad.message, /Invalid base_url/);
}

// A valid http(s) base_url still parses.
const goodBaseUrl = parseCustomModelConfigInput('base_url=https://gateway.example/v1 key=sk-test model_name=custom-coder');
assert.equal(goodBaseUrl.ok, true);

console.log('[PASS] CLI model catalog rejects malformed base_url');
