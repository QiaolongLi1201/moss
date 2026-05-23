#!/usr/bin/env node
/**
 * Telemetry redaction layer — unit tests.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/redact.spec.mjs
 */

import assert from 'node:assert/strict';
import { redactSensitiveData, parseTelemetryAllow } from '../dist/observability/redact.js';

// ── redacts API keys by field name ──

{
  const input = { api_key: 'sk-proj-abc123', name: 'test' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { api_key: '[REDACTED]', name: 'test' });
}

{
  const input = { apikey: 'secret-value', model: 'gpt-4' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { apikey: '[REDACTED]', model: 'gpt-4' });
}

{
  const input = { 'api-key': 'key123' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { 'api-key': '[REDACTED]' });
}

{
  const input = { token: 'ghp_abcdef123456' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { token: '[REDACTED]' });
}

{
  const input = { secret: 'my-secret' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { secret: '[REDACTED]' });
}

{
  const input = { credential: 'cred-123' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { credential: '[REDACTED]' });
}

console.log('  [PASS] redacts API keys, tokens, secrets, credentials by field name');

// ── redacts passwords ──

{
  const input = { password: 'hunter2', user: 'alice' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { password: '[REDACTED]', user: 'alice' });
}

{
  const input = { Password: 'CaseSensitive123' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { Password: '[REDACTED]' });
}

console.log('  [PASS] redacts passwords');

// ── redacts prompt fields ──

{
  const input = { prompt: 'Tell me a secret', id: 42 };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { prompt: '[REDACTED]', id: 42 });
}

{
  const input = { system_prompt: 'You are a helpful assistant' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { system_prompt: '[REDACTED]' });
}

{
  const input = { user_prompt_template: 'Hello {{name}}' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { user_prompt_template: '[REDACTED]' });
}

console.log('  [PASS] redacts prompt fields');

// ── redacts IP addresses in string values ──

{
  const input = { ip: '192.168.1.1', status: 'ok' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { ip: '[REDACTED]', status: 'ok' });
}

{
  const input = { address: '10.0.0.255' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { address: '[REDACTED]' });
}

{
  const input = { server: '172.16.0.1:8080' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { server: '[REDACTED]' });
}

{
  const input = { ipv6: '::1' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { ipv6: '[REDACTED]' });
}

{
  const input = { ipv6full: '2001:0db8:85a3:0000:0000:8a2e:0370:7334' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { ipv6full: '[REDACTED]' });
}

{
  // Standalone IP string
  const result = redactSensitiveData('192.168.0.1');
  assert.equal(result, '[REDACTED]');
}

console.log('  [PASS] redacts IP addresses (IPv4 and IPv6)');

// ── redacts URLs with credentials ──

{
  const input = { url: 'https://user:pass@example.com/api' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { url: '[REDACTED]' });
}

{
  const input = { url: 'https://example.com/api' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { url: 'https://example.com/api' });
}

{
  const input = { url: 'postgres://admin:s3cret@db.host:5432/mydb' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { url: '[REDACTED]' });
}

console.log('  [PASS] redacts URLs containing credentials');

// ── redacts file content (long strings with code-like patterns) ──

{
  const longCode = 'const x = 1;\n'.repeat(20); // 280 chars, looks like code
  const input = { content: longCode };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { content: '[REDACTED]' });
}

{
  const longText = 'Hello world. '.repeat(20); // long but no code pattern
  const input = { content: longText };
  const result = redactSensitiveData(input);
  // No code-like pattern, should pass through
  assert.deepEqual(result, { content: longText });
}

{
  // Short string with code pattern — under threshold, not redacted
  const short = 'const x = 1;';
  const input = { code: short };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { code: short });
}

{
  // JSON-like content over 200 chars
  const longJson = JSON.stringify({ a: 1, b: Array.from({ length: 80 }, (_, i) => i) });
  const input = { data: longJson };
  const result = redactSensitiveData(input);
  // JSON starts with { which matches heuristic
  assert.deepEqual(result, { data: '[REDACTED]' });
}

console.log('  [PASS] redacts file content over 200 chars with code/data patterns');

// ── preserves safe fields ──

{
  const input = { name: 'test', version: '1.0.0', count: 42, active: true };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { name: 'test', version: '1.0.0', count: 42, active: true });
}

{
  const input = { model: 'gpt-4', temperature: 0.7, max_tokens: 1000 };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { model: 'gpt-4', temperature: 0.7, max_tokens: 1000 });
}

console.log('  [PASS] preserves safe fields');

// ── respects allowFields option ──

{
  const input = { prompt: 'hello', token: 'abc', name: 'test' };
  const result = redactSensitiveData(input, { allowFields: ['prompt'] });
  assert.deepEqual(result, { prompt: 'hello', token: '[REDACTED]', name: 'test' });
}

{
  const input = { password: 'secret123', api_key: 'key456' };
  const result = redactSensitiveData(input, { allowFields: ['password', 'api_key'] });
  assert.deepEqual(result, { password: 'secret123', api_key: 'key456' });
}

console.log('  [PASS] respects allowFields option');

// ── respects extraPatterns option ──

{
  const input = { customField: 'my-custom-secret-value' };
  const result = redactSensitiveData(input, { extraPatterns: [/my-custom-secret/] });
  assert.deepEqual(result, { customField: '[REDACTED]' });
}

{
  const input = { message: 'safe value' };
  const result = redactSensitiveData(input, { extraPatterns: [/my-custom-secret/] });
  assert.deepEqual(result, { message: 'safe value' });
}

console.log('  [PASS] respects extraPatterns option');

// ── handles circular references ──

{
  const obj = { name: 'test' };
  obj.self = obj;
  const result = redactSensitiveData(obj);
  assert.deepEqual(result, { name: 'test', self: '[CIRCULAR]' });
}

{
  const a = { name: 'a' };
  const b = { name: 'b' };
  a.child = b;
  b.parent = a;
  const result = redactSensitiveData(a);
  assert.deepEqual(result, {
    name: 'a',
    child: { name: 'b', parent: '[CIRCULAR]' },
  });
}

console.log('  [PASS] handles circular references gracefully');

// ── handles primitives ──

{
  assert.equal(redactSensitiveData(null), null);
  assert.equal(redactSensitiveData(undefined), undefined);
  assert.equal(redactSensitiveData(42), 42);
  assert.equal(redactSensitiveData(true), true);
  assert.equal(redactSensitiveData('hello'), 'hello');
}

{
  // Primitive string that is an IP
  assert.equal(redactSensitiveData('10.0.0.1'), '[REDACTED]');
}

console.log('  [PASS] handles primitives safely');

// ── handles arrays ──

{
  const input = [{ api_key: 'key1' }, { name: 'safe' }, 'plain string'];
  const result = redactSensitiveData(input);
  assert.deepEqual(result, [{ api_key: '[REDACTED]' }, { name: 'safe' }, 'plain string']);
}

{
  const input = ['192.168.1.1', 'safe string', '10.0.0.1'];
  const result = redactSensitiveData(input);
  assert.deepEqual(result, ['[REDACTED]', 'safe string', '[REDACTED]']);
}

{
  // Nested arrays
  const input = [[{ token: 'secret' }]];
  const result = redactSensitiveData(input);
  assert.deepEqual(result, [[{ token: '[REDACTED]' }]]);
}

console.log('  [PASS] handles arrays and nested arrays');

// ── does NOT mutate input ──

{
  const input = { api_key: 'original', nested: { password: 'pw123' } };
  const inputCopy = JSON.parse(JSON.stringify(input));
  redactSensitiveData(input);
  assert.deepEqual(input, inputCopy, 'input must not be mutated');
}

console.log('  [PASS] does not mutate input');

// ── DMOSS_TELEMETRY_ALLOW parsing ──

{
  // Normal comma-separated list
  const original = process.env.DMOSS_TELEMETRY_ALLOW;
  process.env.DMOSS_TELEMETRY_ALLOW = 'prompt,token,secret';
  const result = parseTelemetryAllow();
  assert.deepEqual(result, new Set(['prompt', 'token', 'secret']));
  process.env.DMOSS_TELEMETRY_ALLOW = original;
}

{
  // With whitespace
  const original = process.env.DMOSS_TELEMETRY_ALLOW;
  process.env.DMOSS_TELEMETRY_ALLOW = ' prompt , token ';
  const result = parseTelemetryAllow();
  assert.deepEqual(result, new Set(['prompt', 'token']));
  process.env.DMOSS_TELEMETRY_ALLOW = original;
}

{
  // Empty string
  const original = process.env.DMOSS_TELEMETRY_ALLOW;
  process.env.DMOSS_TELEMETRY_ALLOW = '';
  const result = parseTelemetryAllow();
  assert.deepEqual(result, new Set());
  process.env.DMOSS_TELEMETRY_ALLOW = original;
}

{
  // Undefined
  const original = process.env.DMOSS_TELEMETRY_ALLOW;
  delete process.env.DMOSS_TELEMETRY_ALLOW;
  const result = parseTelemetryAllow();
  assert.deepEqual(result, new Set());
  process.env.DMOSS_TELEMETRY_ALLOW = original;
}

{
  // DMOSS_TELEMETRY_ALLOW integrates with redactSensitiveData
  const original = process.env.DMOSS_TELEMETRY_ALLOW;
  process.env.DMOSS_TELEMETRY_ALLOW = 'prompt';
  const input = { prompt: 'hello world', token: 'abc123' };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, { prompt: 'hello world', token: '[REDACTED]' });
  process.env.DMOSS_TELEMETRY_ALLOW = original;
}

console.log('  [PASS] DMOSS_TELEMETRY_ALLOW parsing and integration');

// ── deep nesting ──

{
  const input = {
    level1: {
      level2: {
        level3: {
          api_key: 'deep-secret',
          safe: 'value',
        },
      },
    },
  };
  const result = redactSensitiveData(input);
  assert.deepEqual(result, {
    level1: {
      level2: {
        level3: {
          api_key: '[REDACTED]',
          safe: 'value',
        },
      },
    },
  });
}

console.log('  [PASS] handles deep nesting');

console.log('All redact checks passed.');
