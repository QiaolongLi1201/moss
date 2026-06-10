#!/usr/bin/env node
/**
 * buildApiV1Url normalization. Regression: a baseUrl pasted as the full
 * endpoint ("https://host/v1/chat/completions") used to produce
 * "https://host/v1/chat/completions/v1/chat/completions" → opaque 404.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/api-v1-url.spec.mjs
 */
import assert from 'node:assert/strict';
import { buildApiV1Url } from '../dist/provider/api-v1-url.js';

const cases = [
  ['https://api.example.com', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/v1', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/v1/', 'https://api.example.com/v1/chat/completions'],
  // Full endpoint pasted as baseUrl — must be stripped, not doubled.
  ['https://api.example.com/v1/chat/completions', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/chat/completions', 'https://api.example.com/v1/chat/completions'],
  // Gateways mounted under a path keep their prefix.
  ['https://llm.corp.com/gateway', 'https://llm.corp.com/gateway/v1/chat/completions'],
  ['https://llm.corp.com/gateway/v1/chat/completions', 'https://llm.corp.com/gateway/v1/chat/completions'],
];

for (const [base, expected] of cases) {
  assert.equal(buildApiV1Url(base, 'chat/completions'), expected, `baseUrl=${base}`);
}
console.log('  [PASS] baseUrl endpoint suffixes are normalized');

// Other paths still compose normally.
assert.equal(
  buildApiV1Url('https://api.example.com/v1', 'models'),
  'https://api.example.com/v1/models',
);
console.log('  [PASS] non-chat paths unaffected');

console.log('[PASS] api-v1-url normalization');
