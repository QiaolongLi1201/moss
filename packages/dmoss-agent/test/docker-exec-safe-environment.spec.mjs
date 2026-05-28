#!/usr/bin/env node
/**
 * Test: docker exec backend strips ambient host secrets from the spawned
 * `docker` CLI subprocess environment.
 *
 * Mirrors exec-safe-environment.spec.mjs but stubs the underlying runner so
 * the test does not require a real Docker daemon. The stub captures the
 * options passed to `runProcess` so we can assert what env the docker CLI
 * subprocess would have received.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDockerExecTool } from '../dist/tools/docker-exec.js';

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

function envValue(env, key) {
  const expected = key.toUpperCase();
  const actual = Object.keys(env).find((candidate) => candidate.toUpperCase() === expected);
  return actual ? env[actual] : undefined;
}

console.log('[TEST] docker exec backend does not leak ambient host secrets');
{
  const workspaceDir = mkdtempSync(join(tmpdir(), 'dmoss-docker-exec-env-'));
  const syntheticSecret = `XYZ_SECRET_${Date.now()}`;
  const envVars = {
    OPENROUTER_API_KEY: 'host-openrouter-secret',
    DEEPSEEK_API_KEY: 'host-deepseek-secret',
    GH_TOKEN: 'host-gh-secret',
    NPM_TOKEN: 'host-npm-secret',
    AWS_ACCESS_KEY_ID: 'host-aws-access-key',
    AWS_SECRET_ACCESS_KEY: 'host-aws-secret-key',
    DATABASE_URL: 'postgres://user:pass@localhost/db',
    SAFE_VAR: 'ordinary-host-value',
    DOCKER_HOST: 'tcp://remote-docker.example:2375',
    DOCKER_TLS_VERIFY: '1',
    DOCKER_CERT_PATH: '/etc/docker/certs',
    DOCKER_CONFIG: '/home/user/.docker',
    DOCKER_CONTEXT: 'remote-ctx',
    [syntheticSecret]: 'synthetic-secret',
  };

  try {
	    await withEnv(envVars, async () => {
	      const calls = [];
	      const stubRunProcess = async (cmd, opts) => {
	        calls.push({ cmd, opts });
	        return { stdout: '(stubbed)', stderr: '', exitCode: 0 };
	      };

      const tool = createDockerExecTool({
        workspaceDir,
        runProcessImpl: stubRunProcess,
      });

      const output = await tool.execute(
        { command: 'env', timeout_ms: 5000 },
        { workspaceDir, sessionKey: 'docker-exec-safe-env' },
      );

	      assert.equal(output, '(stubbed)', 'stubbed runner output should be returned');
	      assert.equal(calls.length, 2, 'docker info probe and docker run must both use the sanitized runner');
	      assert.equal(calls[0].cmd, 'docker', 'docker info probe should spawn docker CLI');
	      assert.deepEqual(calls[0].opts.args, ['info'], 'docker availability probe should use docker info');
	      assert.equal(calls[1].cmd, 'docker', 'docker run should spawn docker CLI');
	      const capturedEnv = calls[1].opts.env;
	      const probeEnv = calls[0].opts.env;
	      assert.ok(
	        capturedEnv && typeof capturedEnv === 'object',
	        'env must be a sanitized object, not undefined (undefined would inherit process.env)',
	      );
	      assert.ok(
	        probeEnv && typeof probeEnv === 'object',
	        'docker info probe env must also be sanitized, not inherited',
	      );

	      // Secrets must not reach the docker CLI subprocess.
	      assert.equal(probeEnv.OPENROUTER_API_KEY, undefined, 'docker info must strip OPENROUTER_API_KEY');
	      assert.equal(probeEnv.AWS_SECRET_ACCESS_KEY, undefined, 'docker info must strip AWS_SECRET_ACCESS_KEY');
	      assert.equal(probeEnv[syntheticSecret], undefined, 'docker info must strip synthetic *_SECRET');
	      assert.equal(capturedEnv.OPENROUTER_API_KEY, undefined, 'OPENROUTER_API_KEY must be stripped');
	      assert.equal(capturedEnv.DEEPSEEK_API_KEY, undefined, 'DEEPSEEK_API_KEY must be stripped');
      assert.equal(capturedEnv.GH_TOKEN, undefined, 'GH_TOKEN must be stripped');
      assert.equal(capturedEnv.NPM_TOKEN, undefined, 'NPM_TOKEN must be stripped');
      assert.equal(capturedEnv.AWS_ACCESS_KEY_ID, undefined, 'AWS_ACCESS_KEY_ID must be stripped');
      assert.equal(capturedEnv.AWS_SECRET_ACCESS_KEY, undefined, 'AWS_SECRET_ACCESS_KEY must be stripped');
      assert.equal(capturedEnv.DATABASE_URL, undefined, 'DATABASE_URL must be stripped');
      assert.equal(capturedEnv[syntheticSecret], undefined, 'synthetic *_SECRET must be stripped by pattern');

      // Ordinary host env and docker-client config must survive so remote-docker
      // and credential-helper users keep working.
      assert.equal(capturedEnv.SAFE_VAR, 'ordinary-host-value', 'ordinary host env should pass through');
      assert.ok(envValue(capturedEnv, 'PATH'), 'PATH must pass through so docker CLI is locatable');
      assert.equal(capturedEnv.DOCKER_HOST, 'tcp://remote-docker.example:2375', 'DOCKER_HOST must pass through');
      assert.equal(capturedEnv.DOCKER_TLS_VERIFY, '1', 'DOCKER_TLS_VERIFY must pass through');
      assert.equal(capturedEnv.DOCKER_CERT_PATH, '/etc/docker/certs', 'DOCKER_CERT_PATH must pass through');
      assert.equal(capturedEnv.DOCKER_CONFIG, '/home/user/.docker', 'DOCKER_CONFIG must pass through');
      assert.equal(capturedEnv.DOCKER_CONTEXT, 'remote-ctx', 'DOCKER_CONTEXT must pass through');
    });
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

console.log('[PASS] docker exec safe environment regression');
