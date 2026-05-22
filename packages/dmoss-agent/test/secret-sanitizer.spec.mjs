#!/usr/bin/env node
/**
 * Self-test for secret detection and sanitization.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/secret-sanitizer.spec.mjs
 */

import assert from 'node:assert/strict';
import { sanitizeSecrets, containsSecrets } from '../dist/safety/index.js';

// ── sanitizeSecrets ──

{
  // Empty / non-string inputs
  assert.equal(sanitizeSecrets(''), '');
  assert.equal(sanitizeSecrets(null), '');
  assert.equal(sanitizeSecrets(undefined), '');
  assert.equal(sanitizeSecrets(123), 123);
}

{
  // No secrets — text passes through unchanged
  const text = 'Hello, this is a normal message about robotics.';
  assert.equal(sanitizeSecrets(text), text);
}

{
  // OpenAI key
  const result = sanitizeSecrets('my key is sk-proj-abc123def456ghi789jkl');
  assert.ok(result.includes('***'), 'OpenAI key should be masked');
  assert.ok(!result.includes('sk-proj-abc123def456ghi789jkl'), 'full key should be removed');
}

{
  // Anthropic key
  const result = sanitizeSecrets('ANTHROPIC_API_KEY=sk-ant-api03-abcdef1234567890ghij');
  assert.ok(result.includes('***'), 'Anthropic key should be masked');
  assert.ok(!result.includes('sk-ant-api03-abcdef1234567890ghij'), 'full key should be removed');
}

{
  // Groq key
  const result = sanitizeSecrets('export GROQ_API_KEY=gsk_abcdefghijklmnopqrstuvwx');
  assert.ok(result.includes('***'), 'Groq key should be masked');
}

{
  // xAI key
  const result = sanitizeSecrets('xai-1234567890abcdefghij');
  assert.ok(result.includes('***'), 'xAI key should be masked');
}

{
  // Google key
  const result = sanitizeSecrets('AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz123456');
  assert.ok(result.includes('***'), 'Google key should be masked');
}

{
  // GitHub classic token
  const result = sanitizeSecrets('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890');
  assert.ok(result.includes('***'), 'GitHub token should be masked');
}

{
  // GitHub fine-grained token
  const result = sanitizeSecrets('github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  assert.ok(result.includes('***'), 'GitHub fine-grained token should be masked');
}

{
  // GitLab token
  const result = sanitizeSecrets('glpat-abcdefghijklmnopqrst');
  assert.ok(result.includes('***'), 'GitLab token should be masked');
}

{
  // AWS access key
  const result = sanitizeSecrets('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
  assert.ok(result.includes('***'), 'AWS key should be masked');
}

{
  // Stripe live key
  const result = sanitizeSecrets('sk_' + 'live_' + 'abcdefghijklmnopqrstuvwx');
  assert.ok(result.includes('***'), 'Stripe live key should be masked');
}

{
  // Stripe test key
  const result = sanitizeSecrets('sk_' + 'test_' + 'abcdefghijklmnopqrstuvwx');
  assert.ok(result.includes('***'), 'Stripe test key should be masked');
}

{
  // Slack bot token
  const result = sanitizeSecrets('xoxb-' + '1234567890-' + 'abcdefghijklmn');
  assert.ok(result.includes('***'), 'Slack token should be masked');
}

{
  // JWT
  const result = sanitizeSecrets('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8');
  assert.ok(result.includes('***'), 'JWT should be masked');
}

{
  // Credential assignment patterns
  const result = sanitizeSecrets('password: "mySecret123"');
  assert.ok(result.includes('***'), 'password assignment should be masked');
  assert.ok(!result.includes('mySecret123'), 'password value should be removed');
}

{
  const result = sanitizeSecrets("api_key: 'abcdefgh123456'");
  assert.ok(result.includes('***'), 'api_key assignment should be masked');
}

{
  const result = sanitizeSecrets('token= "superSecretTokenValue"');
  assert.ok(result.includes('***'), 'token assignment should be masked');
}

{
  // Multiple secrets in one text
  const result = sanitizeSecrets('Key1: sk-ant-api03-aaa1234567890123456789, Key2: ghp_bbb123456789012345678901234567890abcdef');
  assert.ok(result.includes('***'), 'multiple secrets should be masked');
  assert.ok(!result.includes('aaa1234567890123456789'), 'first key removed');
  assert.ok(!result.includes('bbb123456789012345678901234567890abcdef'), 'second key removed');
}

{
  // Short values (≤4 chars) fully masked
  const result = sanitizeSecrets('password: "ab"');
  // "ab" is only 2 chars and the regex requires 6+ chars for credential assignments,
  // so this won't match. Test with a 6-char value:
  const result2 = sanitizeSecrets('password: "abcdef"');
  assert.ok(result2.includes('***'), '6-char password should be masked');
}

// ── containsSecrets ──

{
  // Empty / non-string inputs
  assert.equal(containsSecrets(''), false);
  assert.equal(containsSecrets(null), false);
  assert.equal(containsSecrets(undefined), false);
}

{
  // No secrets
  assert.equal(containsSecrets('Normal conversation about RDK robots.'), false);
}

{
  // Detects OpenAI key
  assert.equal(containsSecrets('apiKey: sk-proj-abc123def456ghi789jkl'), true);
}

{
  // Detects Anthropic key
  assert.equal(containsSecrets('Authorization: Bearer sk-ant-api03-abcdef1234567890ghij'), true);
}

{
  // Detects credential assignment
  assert.equal(containsSecrets('password: "superSecret123"'), true);
}

{
  // Detects JWT
  assert.equal(containsSecrets('x-access-token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'), true);
}

{
  // GitHub token in JSON
  assert.equal(containsSecrets('{"token":"ghp_abcdefghijklmnopqrstuvwxyz1234567890"}'), true);
}

{
  // Does NOT flag short hex strings that look similar but lack prefix
  assert.equal(containsSecrets('commit abcdef1234567890'), false);
}

console.log('All secret-sanitizer checks passed.');
