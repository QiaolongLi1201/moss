#!/usr/bin/env node
/**
 * /doctor in-session health check (registry command + renderCliSessionDoctor).
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import {
  findRegistryCommand,
  runRegistryCommand,
  unknownSlashCommandLines,
} from '../dist/cli/commands/registry.js';

function fakeAgentTools(names = ['exec', 'read_file']) {
  const tools = names.map((name) => ({ name }));
  return {
    size: tools.length,
    getAll: () => tools,
    getNames: () => names,
    get: (n) => tools.find((t) => t.name === n),
  };
}

function resolvedConfig(overrides = {}) {
  return {
    profile: 'balanced', profileSource: 'default',
    provider: 'qwen', providerSource: 'config',
    apiKey: 'test-key', apiKeySource: 'config',
    usingBundledDefault: false, ignoredModelEnvVars: [],
    model: 'qwen3-max', modelSource: 'config',
    baseUrl: 'https://gateway.example.test/v1', baseUrlSource: 'config',
    workspace: '/tmp', workspaceSource: 'config',
    safetyMode: 'workspace-write', safetyModeSource: 'profile:balanced',
    approvalPolicy: 'prompt', approvalPolicySource: 'profile:balanced',
    trustedTools: [], trustedToolsSource: 'profile:balanced',
    deniedTools: [], deniedToolsSource: 'default',
    promptCacheEnabled: true, promptCacheSource: 'profile:balanced',
    promptCacheDebug: false, promptCacheDebugSource: 'profile:balanced',
    guardrails: { input: { blockPatterns: [], redactPatterns: [] }, output: { blockPatterns: [], redactPatterns: [] } },
    guardrailsSource: 'default',
    maxAgentTurns: 64, maxAgentTurnsSource: 'default',
    contextTokens: 200000, contextTokensSource: 'default',
    compactionSettings: { reserveTokens: 20000, keepRecentTokens: 20000 }, compactionSettingsSource: 'default',
    mcpEnabled: false, mcpEnabledSource: 'default',
    mcpConfigPath: '/tmp/mcp.json', mcpConfigPathSource: 'default',
    imageInput: false, imageInputSource: 'provider default',
    configPath: '/tmp/config.json',
    ...overrides,
  };
}

function fakeCtx(runtime) {
  const said = [];
  return {
    said,
    // The doctor reports agent.config.model (the live model); mirror the
    // runtime config's model so test cases can vary it.
    agent: { config: { model: runtime.config?.model ?? 'qwen3-max', extraPromptLayers: [] }, tools: fakeAgentTools() },
    runtime, sessionKey: 'test', workspace: '/tmp', locale: undefined, surface: 'repl',
    say(kind, text) { said.push({ kind, text }); },
    prefillInput() {},
  };
}

{
  const match = findRegistryCommand('/doctor');
  assert.equal(match?.spec.name, '/doctor', '/doctor must resolve in the registry');
  const unknown = unknownSlashCommandLines('/doctor', { suggestion: null });
  assert.match(unknown[0], /Unknown command: \/doctor/, 'sanity: unknown UX exists but /doctor never reaches it');
}

{
  const ctx = fakeCtx({ config: resolvedConfig(), mcp: [] });
  assert.equal(await runRegistryCommand('/doctor', ctx), true, '/doctor must be registry-handled');
  assert.equal(ctx.said.length, 1, '/doctor prints exactly once');
  const out = ctx.said[0].text;
  assert.equal(ctx.said[0].kind, 'system');
  assert.match(out, /Doctor/);
  assert.match(out, /model:\s+qwen3-max/);
  assert.match(out, /auth:\s+API key configured via config/);
  assert.match(out, /egress:\s+gateway\.example\.test/);
  assert.match(out, /board:\s+not connected/);
  assert.match(out, /mcp:\s+disabled/);
  assert.match(out, /config:\s+no warnings/);
}

{
  const ctx = fakeCtx({
    config: resolvedConfig({ ignoredModelEnvVars: ['DEEPSEEK_API_KEY'], mcpEnabled: true, mcpEnabledSource: 'config' }),
    device: { host: '10.0.0.7', user: 'root', port: 22 },
    deviceSession: { boardMode: true, registeredNames: [], displaced: [] },
    mcp: [
      { name: 'filesystem', connected: true, toolCount: 5 },
      { name: 'broken', connected: false, toolCount: 0 },
    ],
  });
  assert.equal(await runRegistryCommand('/doctor', ctx), true);
  const out = ctx.said[0].text;
  assert.match(out, /board:\s+root@10\.0\.0\.7:22 — BOARD MODE/);
  assert.match(out, /mcp:\s+1\/2 servers connected \(broken failed\) · 5 tools/);
  assert.match(out, /env ignored:\s+DEEPSEEK_API_KEY/);
}

{
  const ctx = fakeCtx({ config: resolvedConfig({ usingBundledDefault: true, model: 'Moss' }), mcp: [] });
  assert.equal(await runRegistryCommand('/doctor', ctx), true);
  const out = ctx.said[0].text;
  assert.match(out, /model:\s+Moss \(built-in D-Robotics model\)/);
  assert.match(out, /auth:\s+built-in gateway \(no API key needed\)/);
  assert.doesNotMatch(out, /gateway\.example\.test/, 'built-in baseUrl must stay hidden');
}

console.log('[PASS] /doctor: recognized command renders a live health summary');
