#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-community-auth.spec.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearDmossCommunityAuthSession,
  getDmossCommunityAuthStatus,
  readDmossCommunityAuthSession,
  renderCommunityAuthRequiredMessage,
  resolveCommunityUserFromToken,
  runDmossCommunityAuthLogin,
} from '../dist/cli/community-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../dist/cli.js');

function mockFetch() {
  return async (url, init = {}) => {
    assert.match(String(url), /\/oauth2\/userinfo$/);
    assert.match(String(init.headers?.Authorization || ''), /^Bearer /);
    return new Response(JSON.stringify({
      sub: 'user-123',
      name: 'D-Moss Tester',
      email: 'tester@example.com',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

async function waitForLoginUrl(lines) {
  for (let i = 0; i < 100; i++) {
    const line = lines.find((entry) => entry.includes('Login URL:'));
    if (line) return line.replace(/^.*Login URL:\s*/, '').trim();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('login URL was not printed');
}

function redirectUrlFromLoginUrl(loginUrl) {
  const parsed = new URL(loginUrl);
  const redirectUrl = parsed.searchParams.get('redirectUrl');
  assert.ok(redirectUrl, 'login URL includes redirectUrl');
  return new URL(redirectUrl);
}

async function runLoginCallbackTest(buildCallbackUrl) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-community-auth-callback-'));
  const lines = [];
  const loginPromise = runDmossCommunityAuthLogin({
    configDir,
    fetchImpl: mockFetch(),
    openBrowser: false,
    print: (line) => lines.push(line),
  });
  const redirectUrl = redirectUrlFromLoginUrl(await waitForLoginUrl(lines));
  const callbackUrl = buildCallbackUrl(redirectUrl);
  const res = await fetch(callbackUrl);
  assert.equal(res.status, 200);
  const auth = await loginPromise;
  assert.equal(auth.user.id, 'user-123');
  assert.equal(getDmossCommunityAuthStatus({ configDir }).authenticated, true);
  assert.equal(readDmossCommunityAuthSession(configDir)?.user.email, 'tester@example.com');
  assert.equal(clearDmossCommunityAuthSession(configDir), true);
}

await runLoginCallbackTest((redirectUrl) => {
  assert.equal(redirectUrl.search, '', 'redirectUrl must not contain query; SSO appends ?bearer=...');
  return `${redirectUrl.toString()}?bearer=${encodeURIComponent('opaque-token-123456')}`;
});

await runLoginCallbackTest((redirectUrl) => {
  const state = decodeURIComponent(redirectUrl.pathname.split('/').pop() || '');
  const legacy = new URL(`${redirectUrl.origin}/dmoss/community-auth/callback`);
  legacy.search = `?state=${state}?bearer=${encodeURIComponent('opaque-token-abcdef')}`;
  return legacy.toString();
});

{
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-community-auth-manual-'));
  const lines = [];
  let prompted = false;
  const auth = await runDmossCommunityAuthLogin({
    configDir,
    fetchImpl: mockFetch(),
    manual: true,
    print: (line) => lines.push(line),
    readLine: async (prompt) => {
      prompted = true;
      assert.match(prompt, /Paste redirected URL or token/);
      const loginLine = lines.find((entry) => entry.includes('Login URL:'));
      assert.ok(loginLine, 'manual mode prints a login URL before prompting');
      const redirectUrl = redirectUrlFromLoginUrl(loginLine.replace(/^.*Login URL:\s*/, '').trim());
      return `${redirectUrl.toString()}?bearer=${encodeURIComponent('opaque-token-manual')}`;
    },
  });
  assert.equal(prompted, true);
  assert.equal(auth.user.id, 'user-123');
  assert.match(lines.join('\n'), /Manual login mode for SSH\/remote terminals/);
  assert.equal(getDmossCommunityAuthStatus({ configDir }).authenticated, true);
}

{
  const token = jwt({
    sub: 'forged-user',
    name: 'Forged User',
    exp: Math.floor((Date.now() + 3_600_000) / 1000),
  });
  const resolved = await resolveCommunityUserFromToken(token, {
    ssoBaseUrl: 'https://sso.example.test',
    fetchImpl: async () => new Response('<!doctype html><html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  });
  assert.match(resolved.user.id, /^portal:/);
  assert.equal(resolved.user.name, 'D-Robotics User');
  assert.notEqual(resolved.user.id, 'forged-user');
}

{
  const token = jwt({
    sub: 'verified-jwt-user',
    name: 'Verified JWT User',
    exp: Math.floor((Date.now() + 3_600_000) / 1000),
  });
  let calls = 0;
  const verified = await resolveCommunityUserFromToken(token, {
    ssoBaseUrl: 'https://sso.example.test',
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).endsWith('/oauth2/userinfo')) {
        return new Response('userinfo unavailable', { status: 502 });
      }
      return new Response(JSON.stringify({ status: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(verified.user.id, 'verified-jwt-user');
  assert.equal(verified.user.name, 'Verified JWT User');
  assert.ok(calls >= 2, 'permission API should verify JWT claims before they are trusted');
}

{
  const expired = jwt({
    sub: 'expired-user',
    name: 'Expired User',
    exp: Math.floor((Date.now() - 60_000) / 1000),
  });
  await assert.rejects(
    resolveCommunityUserFromToken(expired, {
      ssoBaseUrl: 'https://sso.example.test',
      fetchImpl: async () => new Response(JSON.stringify({ status: 0 }), { status: 200 }),
    }),
    /expired/,
  );
}

{
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-community-auth-state-mismatch-'));
  const lines = [];
  const loginPromise = runDmossCommunityAuthLogin({
    configDir,
    fetchImpl: mockFetch(),
    openBrowser: false,
    print: (line) => lines.push(line),
  });
  const redirectUrl = redirectUrlFromLoginUrl(await waitForLoginUrl(lines));
  const callbackUrl = `${redirectUrl.origin}${redirectUrl.pathname}/wrong-state?bearer=${encodeURIComponent('opaque-token-state')}`;
  const rejection = assert.rejects(loginPromise, /state mismatch/);
  const res = await fetch(callbackUrl);
  assert.equal(res.status, 400);
  await rejection;
  await new Promise((resolve) => setTimeout(resolve, 25));
  await assert.rejects(fetch(`${redirectUrl.toString()}?bearer=${encodeURIComponent('opaque-token-state')}`));
}

{
  const message = renderCommunityAuthRequiredMessage({ interactive: true });
  assert.match(message, /\/auth login/);
  assert.doesNotMatch(message, /start dmoss again/i);
}

{
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-community-auth-required-'));
  const result = spawnSync(process.execPath, [
    cliPath,
    '--provider',
    'openai-compatible',
    '--base-url',
    'http://127.0.0.1:9/v1',
    '--model',
    'auth-gate-test',
    '--print',
    'hello',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DMOSS_CONFIG_DIR: configDir,
      DMOSS_API_KEY: 'test-key',
      DMOSS_NO_COLOR: '1',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /moss auth login/);
  assert.doesNotMatch(result.stderr, /provider returned HTTP|ECONNREFUSED|fetch failed/);
}

console.log('[PASS] CLI D-Robotics community auth callback handling');
