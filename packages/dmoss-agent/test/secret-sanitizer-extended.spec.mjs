import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSecrets, containsSecrets } from '../dist/safety/secret-sanitizer.js';

describe('Extended Secret Sanitizer Rules', () => {
  it('detects Azure SAS token', () => {
    const text = 'https://storage.blob.core.windows.net/container?sv=2021-06-08&ss=bfqt&srt=sco&sp=rwdlacupiyx&se=2023-12-31&sig=abc123_def-456GHIJKLMNOP7890';
    assert.ok(containsSecrets(text));
    const sanitized = sanitizeSecrets(text);
    assert.ok(sanitized.includes('***'));
    assert.ok(!sanitized.includes('abc123_def-456GHIJKLMNOP7890'));
    assert.ok(sanitized.includes('sig='));
  });

  it('detects Azure connection string', () => {
    const text = 'DefaultEndpointsProtocol=https;AccountName=myaccount;AccountKey=abc123def456ghi789jkl;EndpointSuffix=core.windows.net';
    assert.ok(containsSecrets(text));
    const sanitized = sanitizeSecrets(text);
    assert.ok(sanitized.includes('***'));
    assert.ok(!sanitized.includes('abc123def456ghi789jkl'));
  });

  it('detects GCP service account private key', () => {
    const text = '{"type":"service_account","private_key":"-----BEGIN RSA PRIVATE KEY-----\\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn\\n-----END PRIVATE KEY-----"}';
    assert.ok(containsSecrets(text));
    const sanitized = sanitizeSecrets(text);
    assert.ok(sanitized.includes('***'));
  });

  it('detects npm token', () => {
    const text = 'npm_1234567890abcdefABCDEF1234567890abcd';
    assert.ok(containsSecrets(text));
    const sanitized = sanitizeSecrets(text);
    assert.ok(sanitized.includes('***'));
  });

  it('detects PyPI token', () => {
    const text = 'pypi-AgEIcHlwaS5vcmcABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    assert.ok(containsSecrets(text));
    const sanitized = sanitizeSecrets(text);
    assert.ok(sanitized.includes('***'));
  });

  it('detects Docker registry token', () => {
    const text = 'dckr_pat_1234567890abcdefghijklmnopqrstuv';
    assert.ok(containsSecrets(text));
    const sanitized = sanitizeSecrets(text);
    assert.ok(sanitized.includes('***'));
  });

  it('detects Cloudflare API token', () => {
    const text = 'CLOUDFLARE_API_TOKEN=ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd';
    assert.ok(containsSecrets(text));
    const sanitized = sanitizeSecrets(text);
    assert.ok(sanitized.includes('***'));
  });

  it('detects Vercel token', () => {
    const text = 'vercel_token_1234567890abcdefghijklmn';
    assert.ok(containsSecrets(text));
    const sanitized = sanitizeSecrets(text);
    assert.ok(sanitized.includes('***'));
  });

  it('does not flag normal text', () => {
    const text = 'The quick brown fox jumps over the lazy dog. npm install express.';
    assert.ok(!containsSecrets(text));
    const sanitized = sanitizeSecrets(text);
    assert.equal(sanitized, text);
  });

  it('does not flag npm_install or npm_package', () => {
    const text = 'Run npm_install to install dependencies. Check npm_package_lock for versions.';
    assert.ok(!containsSecrets(text));
    const sanitized = sanitizeSecrets(text);
    assert.equal(sanitized, text);
  });

  it('does not flag normal URL with st= parameter', () => {
    const text = 'https://example.com/page?st=start_time_value_here';
    assert.ok(!containsSecrets(text));
    const sanitized = sanitizeSecrets(text);
    assert.equal(sanitized, text);
  });

  it('detects Anthropic key as Anthropic, not OpenAI', () => {
    const text = 'Authorization: Bearer sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdef';
    assert.ok(containsSecrets(text));
    const sanitized = sanitizeSecrets(text);
    assert.ok(sanitized.includes('***'));
    assert.ok(!sanitized.includes('sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdef'));
  });

  it('detects npm tokens longer than 36 chars', () => {
    const text = 'npm_1234567890abcdefABCDEF1234567890abcdEXTRA1234';
    assert.ok(containsSecrets(text));
    const sanitized = sanitizeSecrets(text);
    assert.ok(sanitized.includes('***'));
    assert.ok(!sanitized.includes('1234567890abcdefABCDEF1234567890abcdEXTRA1234'));
  });
});
