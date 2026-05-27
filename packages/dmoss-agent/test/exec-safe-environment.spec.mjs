#!/usr/bin/env node
/**
 * Test: built-in exec tool strips ambient host secrets from child env.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execTool } from '../dist/tools/builtin.js';

function withEnv(vars, fn) {
  const previous = new Map();
  for (const key of Object.keys(vars)) {
    previous.set(key, process.env[key]);
    process.env[key] = vars[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

console.log('[TEST] exec tool does not leak ambient host secrets');
{
  const workspaceDir = mkdtempSync(join(tmpdir(), 'dmoss-exec-env-'));
  const syntheticSecret = `XYZ_SECRET_${Date.now()}`;
  const envVars = {
    OPENROUTER_API_KEY: 'host-openrouter-secret',
    DEEPSEEK_API_KEY: 'host-deepseek-secret',
    GH_TOKEN: 'host-gh-secret',
    NPM_TOKEN: 'host-npm-secret',
    AWS_ACCESS_KEY_ID: 'host-aws-access-key',
    AWS_SECRET_ACCESS_KEY: 'host-aws-secret-key',
    DATABASE_URL: 'postgres://user:pass@localhost/db',
    database_url: 'postgres://lower:userpass@localhost/db',
    redis_url: 'redis://lower:userpass@localhost:6379',
    mongodb_uri: 'mongodb://lower:userpass@localhost/db',
    SAFE_VAR: 'ordinary-host-value',
    [syntheticSecret]: 'synthetic-secret',
  };

  try {
    await withEnv(envVars, async () => {
      const script =
        'console.log(JSON.stringify({' +
        'OPENROUTER_API_KEY:process.env.OPENROUTER_API_KEY,' +
        'DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY,' +
        'GH_TOKEN:process.env.GH_TOKEN,' +
        'NPM_TOKEN:process.env.NPM_TOKEN,' +
        'AWS_ACCESS_KEY_ID:process.env.AWS_ACCESS_KEY_ID,' +
        'AWS_SECRET_ACCESS_KEY:process.env.AWS_SECRET_ACCESS_KEY,' +
        'DATABASE_URL:process.env.DATABASE_URL,' +
        'database_url:process.env.database_url,' +
        'redis_url:process.env.redis_url,' +
        'mongodb_uri:process.env.mongodb_uri,' +
        'SAFE_VAR:process.env.SAFE_VAR,' +
        `SYNTHETIC_SECRET:process.env[${JSON.stringify(syntheticSecret)}],` +
        'PATH_PRESENT:Boolean(process.env.PATH),' +
        'LANG_PRESENT:Boolean(process.env.LANG)' +
        '}))';
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
      const output = await execTool.execute(
        { command, timeout_ms: 5000 },
        { workspaceDir, sessionKey: 'exec-safe-env' },
      );
      const env = JSON.parse(output);

      assert.equal(env.OPENROUTER_API_KEY, undefined, 'OPENROUTER_API_KEY should not reach exec child');
      assert.equal(env.DEEPSEEK_API_KEY, undefined, 'DEEPSEEK_API_KEY should not reach exec child');
      assert.equal(env.GH_TOKEN, undefined, 'GH_TOKEN should not reach exec child');
      assert.equal(env.NPM_TOKEN, undefined, 'NPM_TOKEN should not reach exec child');
      assert.equal(env.AWS_ACCESS_KEY_ID, undefined, 'AWS_ACCESS_KEY_ID should not reach exec child');
      assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, 'AWS_SECRET_ACCESS_KEY should not reach exec child');
      assert.equal(env.DATABASE_URL, undefined, 'DATABASE_URL should not reach exec child');
      assert.equal(env.database_url, undefined, 'lowercase database_url should not reach exec child');
      assert.equal(env.redis_url, undefined, 'lowercase redis_url should not reach exec child');
      assert.equal(env.mongodb_uri, undefined, 'lowercase mongodb_uri should not reach exec child');
      assert.equal(env.SYNTHETIC_SECRET, undefined, 'synthetic secret should not reach exec child');
      assert.equal(env.SAFE_VAR, 'ordinary-host-value', 'ordinary host env should remain available');
      assert.equal(env.PATH_PRESENT, true, 'PATH should remain available');
      assert.equal(env.LANG_PRESENT, true, 'LANG should be set for child processes');
    });
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

console.log('[PASS] exec safe environment regression');
