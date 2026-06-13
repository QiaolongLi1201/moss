#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-doctor.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderCliDoctor, renderNodeDoctorLine, cliDoctorHasFailure } from '../dist/cli/doctor.js';

// Exit-code gate: any `fail` line must make the report report a failure so the
// CLI can exit non-zero (doctor previously always exited 0, masking problems).
assert.equal(cliDoctorHasFailure('[doctor] Moss\n  ok    node: v22\n  ok    auth: ok'), false);
assert.equal(cliDoctorHasFailure('[doctor] Moss\n  ok    node: v22\n  fail  workspace: /x is not writable'), true);
assert.equal(cliDoctorHasFailure('  warn  env ignored: DEEPSEEK_API_KEY'), false);

function resolvedConfig(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-doctor-config-'));
  return {
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
    config: {
      profile: 'balanced',
      profileSource: 'default',
      provider: 'qwen',
      providerSource: 'config',
      apiKey: 'test-key',
      apiKeySource: 'config',
      model: 'qwen3.7-max',
      modelSource: 'config',
      baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode',
      baseUrlSource: 'config',
      workspace: tmp,
      workspaceSource: 'config',
      safetyMode: 'workspace-write',
      safetyModeSource: 'profile:balanced',
      approvalPolicy: 'prompt',
      approvalPolicySource: 'profile:balanced',
      trustedTools: [],
      trustedToolsSource: 'profile:balanced',
      deniedTools: [],
      deniedToolsSource: 'default',
      promptCacheEnabled: true,
      promptCacheSource: 'profile:balanced',
      promptCacheDebug: false,
      promptCacheDebugSource: 'profile:balanced',
      guardrails: {
        input: { blockPatterns: [], redactPatterns: [] },
        output: { blockPatterns: [], redactPatterns: [] },
      },
      guardrailsSource: 'default',
      maxAgentTurns: 64,
      maxAgentTurnsSource: 'default',
      contextTokens: 200000,
      contextTokensSource: 'default',
      compactionSettings: { reserveTokens: 20000, keepRecentTokens: 20000 },
      compactionSettingsSource: 'default',
      mcpEnabled: false,
      mcpEnabledSource: 'default',
      mcpConfigPath: path.join(tmp, 'mcp.json'),
      mcpConfigPathSource: 'default',
      ignoredModelEnvVars: [],
      configPath: path.join(tmp, 'config.json'),
      ...overrides,
    },
  };
}

async function doctor(config) {
  return renderCliDoctor({
    config,
    configDir: path.dirname(config.configPath),
    runtimeDir: path.join(config.workspace, '.moss'),
    currentVersion: '0.3.7',
    safetyMode: config.safetyMode,
    detailMode: 'progress',
    updateFetchImpl: async () => ({ ok: false, async json() { return {}; } }),
  });
}

{
  assert.match(renderNodeDoctorLine('v22.15.1'), /fail\s+node: v22\.15\.1; requires >=22\.16\.0/);
  assert.match(renderNodeDoctorLine('v22.16.0'), /ok\s+node: v22\.16\.0/);
  assert.match(renderNodeDoctorLine('v23.0.0'), /ok\s+node: v23\.0\.0/);
}

{
  const fixture = resolvedConfig();
  try {
    const output = await doctor(fixture.config);
    assert.match(output, /ok\s+approval: prompt \(profile:balanced\)/);
    assert.match(output, /ok\s+trustedTools: none \(profile:balanced\)/);
    assert.match(output, /ok\s+mcp: disabled \(default\); config .*mcp\.json/);
    assert.doesNotMatch(output, /env ignored/);
  } finally {
    fixture.cleanup();
  }
}

// Set-but-ignored model env vars surface as a structured warn line, so a
// leftover DEEPSEEK_API_KEY explains itself instead of silently doing nothing.
{
  const fixture = resolvedConfig({
    ignoredModelEnvVars: ['DEEPSEEK_API_KEY', 'DMOSS_PROVIDER'],
  });
  try {
    const output = await doctor(fixture.config);
    assert.match(output, /warn\s+env ignored: DEEPSEEK_API_KEY, DMOSS_PROVIDER/);
    assert.match(output, /model settings come only from moss config/);
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = resolvedConfig({
    usingBundledDefault: true,
    provider: 'openai-compatible',
    model: 'Moss',
    baseUrl: 'http://gateway.example.test/v1',
  });
  try {
    const output = await doctor(fixture.config);
    assert.match(output, /ok\s+baseUrl: built-in default \(hidden\)/);
    assert.doesNotMatch(output, /gateway\.example\.test/);
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = resolvedConfig({
    approvalPolicy: 'never',
    approvalPolicySource: 'config',
    trustedTools: ['filesystem__*', 'read_file'],
    trustedToolsSource: 'config',
  });
  try {
    const output = await doctor(fixture.config);
    assert.match(output, /warn\s+approval policy: auto-approval is enabled via config; keep deniedTools current for risky tools/);
    assert.match(output, /warn\s+approval policy: auto-approval has no deniedTools guardrail \(default\); add high-risk tools or globs to deniedTools/);
    assert.match(output, /ok\s+trustedTools: 2 configured \(config\); wildcard patterns are narrow/);
    assert.doesNotMatch(output, /broad trusted pattern/);
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = resolvedConfig({
    trustedTools: ['device_*', '*__*', 'exec'],
    trustedToolsSource: 'config',
  });
  try {
    const output = await doctor(fixture.config);
    assert.match(output, /warn\s+trustedTools: broad trusted pattern\(s\): device_\*, \*__\*/);
    assert.doesNotMatch(output, /broad trusted pattern\(s\): .*exec/);
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = resolvedConfig({
    trustedTools: ['exec', 'read_file'],
    trustedToolsSource: 'config',
    deniedTools: ['exec', 'device_exec'],
    deniedToolsSource: 'config',
  });
  try {
    const output = await doctor(fixture.config);
    assert.match(output, /warn\s+approval policy: trustedTools also appear in deniedTools: exec; deniedTools takes precedence/);
    assert.match(output, /ok\s+trustedTools: exec, read_file \(config\)/);
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = resolvedConfig({
    safetyMode: 'full-access',
    safetyModeSource: 'config',
    approvalPolicy: 'never',
    approvalPolicySource: 'config',
  });
  try {
    const output = await doctor(fixture.config);
    assert.match(output, /warn\s+approval policy: full-access safety and auto-approval are both enabled/);
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = resolvedConfig({
    mcpEnabled: true,
    mcpEnabledSource: 'config',
  });
  try {
    fs.writeFileSync(
      fixture.config.mcpConfigPath,
      JSON.stringify({ mcpServers: { filesystem: { command: 'node', args: ['server.js'] } } }),
    );
    const output = await doctor(fixture.config);
    assert.match(output, /ok\s+mcp: enabled \(config\); 1 server\(s\) from .*mcp\.json/);
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = resolvedConfig({
    mcpEnabled: true,
    mcpEnabledSource: 'DMOSS_MCP_ENABLED',
    mcpConfigPathSource: 'DMOSS_MCP_CONFIG',
  });
  try {
    const output = await doctor(fixture.config);
    assert.match(output, /fail\s+mcp: enabled \(DMOSS_MCP_ENABLED\) but config is missing at .*mcp\.json/);
    assert.match(output, /warn\s+env overrides: DMOSS_MCP_ENABLED, DMOSS_MCP_CONFIG/);
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = resolvedConfig({
    mcpEnabled: true,
    mcpEnabledSource: 'config',
  });
  try {
    fs.writeFileSync(
      fixture.config.mcpConfigPath,
      JSON.stringify({ mcpServers: { broken: { args: ['server.js'] } } }),
    );
    const output = await doctor(fixture.config);
    assert.match(output, /fail\s+mcp: invalid server entries \(broken\); each server needs a command/);
  } finally {
    fixture.cleanup();
  }
}

console.log('[PASS] CLI doctor surfaces MCP file configuration health');
