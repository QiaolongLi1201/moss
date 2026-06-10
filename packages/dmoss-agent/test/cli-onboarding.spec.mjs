#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-onboarding.spec.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  renderCliDetailHelp,
  renderCliExamples,
  renderCliInteractiveHelp,
  renderCliPermissions,
  renderCliQuickStart,
  renderCliStatus,
  renderCliTools,
  renderCliUpgradeHelp,
  renderCliWelcome,
} from '../dist/cli/onboarding.js';

function literalPattern(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function createAgent(tools) {
  return {
    config: { model: 'qwen3.7-max' },
    tools: {
      size: tools.length,
      getAll() {
        return tools;
      },
      getNames() {
        return tools.map((t) => t.name);
      },
    },
  };
}

function tool(name, description = `${name} description`) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return '';
    },
  };
}

const workspacePath = path.resolve('/tmp/dmoss-workspace');
const runtimeDirPath = path.resolve('/tmp/dmoss-runtime');
const configDirPath = path.resolve('/tmp/dmoss-config');
const mcpConfigPath = path.join(configDirPath, 'mcp.json');
const configPath = path.join(configDirPath, 'config.json');

const runtime = {
  workspace: workspacePath,
  runtimeDir: runtimeDirPath,
  configDir: configDirPath,
  baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode',
  execBackend: 'local',
  safetyMode: 'workspace-write',
  meshEnabled: true,
  device: { host: '10.64.1.10', user: 'root', port: 22 },
  config: {
    profile: 'autonomous',
    profileSource: 'config',
    provider: 'qwen',
    providerSource: 'config',
    apiKey: 'test-key',
    apiKeySource: 'config',
    model: 'qwen3.7-max',
    modelSource: 'config',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode',
    baseUrlSource: 'config',
    workspace: workspacePath,
    workspaceSource: 'config',
    safetyMode: 'workspace-write',
    safetyModeSource: 'config',
    approvalPolicy: 'never',
    approvalPolicySource: 'config',
    trustedTools: ['exec'],
    trustedToolsSource: 'config',
    deniedTools: ['device_exec'],
    deniedToolsSource: 'config',
    promptCacheEnabled: false,
    promptCacheSource: 'config',
    promptCacheDebug: true,
    promptCacheDebugSource: 'config',
    mcpEnabled: true,
    mcpEnabledSource: 'config',
    mcpConfigPath,
    mcpConfigPathSource: 'config',
    guardrails: {
      input: { blockPatterns: ['forbidden input'], redactPatterns: ['SECRET=[^\\s]+'] },
      output: { blockPatterns: [], redactPatterns: ['TOKEN=[^\\s]+'] },
    },
    guardrailsSource: 'config',
    maxAgentTurns: 18,
    maxAgentTurnsSource: 'config',
    contextTokens: 96000,
    contextTokensSource: 'config',
    compactionSettings: { reserveTokens: 8000, keepRecentTokens: 9000 },
    compactionSettingsSource: 'config',
    imageInput: false,
    imageInputSource: 'provider default',
    configPath,
  },
};

const disconnectedRuntime = {
  ...runtime,
  device: null,
};

const agent = createAgent([
  tool('read_file', 'Read a file in the workspace'),
  tool('write_file', 'Write a file in the workspace'),
  tool('memory_read', 'Search long-term memory'),
  tool('device_resources', 'Read device CPU and memory state'),
  tool('ros2_topic_list', 'List ROS2 topics'),
  tool('mesh_list_peers', 'List mesh peers'),
  tool('create_subagent', 'Spawn a sub-agent'),
]);

{
  const welcome = renderCliWelcome(agent, runtime);
  assert.match(welcome, /Moss Agent/);
  assert.match(welcome, /model: qwen3\.7-max/);
  assert.match(welcome, literalPattern(`workspace: ${workspacePath}`));
  assert.match(welcome, /login: own provider configured/);
  assert.match(welcome, /board: root@10\.64\.1\.10:22/);
  assert.match(welcome, /next \/quickstart, \/model, or moss setup for your own model/);
  assert.doesNotMatch(welcome, /profile autonomous/);
  assert.doesNotMatch(welcome, /approval never/);
  assert(welcome.split('\n').length <= 6);
}

{
  const welcome = renderCliWelcome(agent, disconnectedRuntime);
  assert.match(welcome, /board: not connected/);
}

{
  const quickStart = renderCliQuickStart(agent, runtime);
  assert.match(quickStart, /Quick start/);
  assert.match(quickStart, /1\/3.*Model/);
  assert.match(quickStart, /provider.*qwen/);
  assert.match(quickStart, /api key.*configured/);
  assert.match(quickStart, /moss setup/);
  assert.match(quickStart, /\/model` to choose a model/);
  assert.match(quickStart, /DMOSS_IMAGE_INPUT/);
  assert.match(quickStart, /2\/3.*Workspace/);
  assert.match(quickStart, /\/status/);
  assert.match(quickStart, /3\/3.*Try/);
  assert.match(quickStart, /Analyze this project/);
  assert.match(quickStart, /board CPU/);
}

{
  const quickStart = renderCliQuickStart(agent, disconnectedRuntime);
  assert.match(quickStart, /api key.*configured/);
  assert.match(quickStart, /\/connect <board-ip>/);
  assert.doesNotMatch(quickStart, /restart dmoss/i);
}

{
  const tools = renderCliTools(agent);
  assert.match(tools, /Tools run automatically/);
  assert.match(tools, /Ask for the outcome/);
  assert.match(tools, /\/quickstart/);
  assert.match(tools, /Ctrl\+V \/ paste path/);
  assert.doesNotMatch(tools, /\/attach <path>/);
  assert.match(tools, /\/detail verbose/);
  assert.doesNotMatch(tools, /read_file Read a file/);
}

{
  const status = renderCliStatus(agent, runtime);
  assert.match(status, /Status/);
  assert.match(status, /model: qwen3\.7-max \(qwen\)/);
  assert.match(status, literalPattern(`workspace: ${workspacePath}`));
  assert.match(status, /board: root@10\.64\.1\.10:22/);
  assert.match(status, /tools: 7/);
  assert.match(status, /setup: moss setup · \/model · \/quickstart/);
  assert.match(status, /Details: \/status --verbose/);
  assert.doesNotMatch(status, /profile: autonomous \(config\)/);
  assert.doesNotMatch(status, /token-plan\.cn-beijing\.maas\.aliyuncs\.com/);
}

{
  const status = renderCliStatus(agent, runtime, { verbose: true });
  assert.match(status, /session: cli/);
  assert.match(status, /provider: qwen/);
  assert.match(status, /profile: autonomous \(config\)/);
  assert.match(status, /token-plan\.cn-beijing\.maas\.aliyuncs\.com/);
  assert.match(status, /device: root@10\.64\.1\.10:22/);
  assert.match(status, /safety: workspace-write/);
  assert.match(status, /approval: never \(config\)/);
  assert.match(status, /trusted tools: exec \(config\)/);
  assert.match(status, /denied tools: device_exec \(config\)/);
  assert.match(status, /prompt cache: disabled \(config\)/);
  assert.match(status, /prompt cache debug: enabled \(config\)/);
  assert.match(status, /guardrails: guardrails in 2 out 1 \(config\)/);
  assert.match(status, /max turns: 18 \(config\)/);
  assert.match(status, /context tokens: 96000 \(config\)/);
  assert.match(status, /compaction: reserve 8000, keepRecent 9000 \(config\)/);
  assert.match(status, /image input: disabled \(provider default\)/);
  assert.match(status, /tools: 7/);
}

{
  const permissions = renderCliPermissions(runtime);
  assert.match(permissions, /Permissions & Config/);
  assert.match(permissions, literalPattern(`config file: ${configPath}`));
  assert.match(permissions, /profile: autonomous \(config\)/);
  assert.match(permissions, /safety: workspace-write \(config\)/);
  assert.match(permissions, /approval: never \(config\)/);
  assert.match(permissions, /trusted tools: exec \(config\)/);
  assert.match(permissions, /denied tools: device_exec \(config\)/);
  assert.match(permissions, /prompt cache: disabled \(config\)/);
  assert.match(permissions, /prompt cache debug: enabled \(config\)/);
  assert.match(permissions, /mcp: enabled \(config\)/);
  assert.match(permissions, literalPattern(`mcp config: ${mcpConfigPath} (config)`));
  assert.match(permissions, /guardrails: input 2, output 1 \(config\)/);
  assert.match(permissions, /max turns: 18 \(config\)/);
  assert.match(permissions, /context tokens: 96000 \(config\)/);
  assert.match(permissions, /compaction: reserve 8000, keepRecent 9000 \(config\)/);
  assert.match(permissions, /image input: disabled \(provider default\)/);
  assert.match(permissions, /config warnings: 1/);
  assert.match(permissions, /approval\.auto_approval: auto-approval is enabled via config/);
  assert.match(permissions, /edit guardrails\.input\/output/);
  assert.match(permissions, /moss config init --project/);
  assert.match(permissions, /moss config set agent\.maxTurns/);
  assert.match(permissions, /moss config set agent\.contextTokens/);
  assert.match(permissions, /moss config set agent\.compaction\.reserveTokens/);
  assert.match(permissions, /moss config set safetyMode/);
  assert.match(permissions, /moss config set --project safetyMode/);
  assert.match(permissions, /moss config set workspace/);
  assert.match(permissions, /moss config set profile/);
  assert.match(permissions, /moss config set trustedTools/);
  assert.match(permissions, /moss config set deniedTools/);
  assert.match(permissions, /moss config set promptCacheDebug/);
  assert.match(permissions, /moss config set provider/);
  assert.match(permissions, /moss config set model/);
  assert.match(permissions, /moss config set baseUrl/);
  assert.match(permissions, /moss config set imageInput/);
  assert.match(permissions, /moss config set mcp\.enabled/);
  assert.match(permissions, /moss config set mcp\.configPath/);
  assert.match(permissions, /moss config unset --project safetyMode/);
  assert.match(permissions, /moss config unset approvalPolicy/);
  assert.match(permissions, /trust the approved tool for the current session/);
  assert.match(permissions, /DMOSS_PROFILE/);
  // Model settings are config-only: their env vars must not be advertised.
  assert.doesNotMatch(permissions, /DMOSS_PROVIDER/);
  assert.doesNotMatch(permissions, /DMOSS_MODEL\b/);
  assert.doesNotMatch(permissions, /DMOSS_API_KEY/);
  assert.doesNotMatch(permissions, /DMOSS_BASE_URL/);
  assert.match(permissions, /model settings are config-only/i);
  assert.match(permissions, /DMOSS_IMAGE_INPUT/);
  assert.match(permissions, /DMOSS_SAFETY_MODE/);
  assert.match(permissions, /DMOSS_TRUSTED_TOOLS/);
  assert.match(permissions, /DMOSS_PROMPT_CACHE_DEBUG/);
  assert.match(permissions, /DMOSS_MCP_ENABLED/);
  assert.match(permissions, /DMOSS_MCP_CONFIG/);
  assert.match(permissions, /DMOSS_MAX_AGENT_TURNS/);
  assert.match(permissions, /DMOSS_CONTEXT_TOKENS/);
  assert.doesNotMatch(permissions, /test-key/);
}

{
  const safeRuntime = {
    ...runtime,
    config: {
      ...runtime.config,
      profile: 'balanced',
      approvalPolicy: 'prompt',
      approvalPolicySource: 'profile:balanced',
      trustedTools: [],
      trustedToolsSource: 'profile:balanced',
      deniedTools: [],
      deniedToolsSource: 'default',
    },
  };
  const permissions = renderCliPermissions(safeRuntime);
  assert.match(permissions, /config warnings: none/);
}

{
  const status = renderCliStatus(agent, { ...runtime, safetyMode: 'read-only' }, { verbose: true });
  assert.match(status, /safety: read-only/);
}

{
  const examples = renderCliExamples(agent, runtime);
  assert.match(examples, /Analyze this project/);
  assert.match(examples, /board CPU/);
  assert.match(examples, /ROS2 topics/);
  assert.match(examples, /mesh peer/);
}

{
  const examples = renderCliExamples(agent, disconnectedRuntime);
  assert.match(examples, /\/connect <board-ip>/);
}

{
  const detail = renderCliDetailHelp();
  assert.match(detail, /quiet/);
  assert.match(detail, /progress/);
  assert.match(detail, /verbose/);
  assert.match(detail, /raw thinking is hidden/);
}

{
  const help = renderCliInteractiveHelp();
  assert.match(help, /Work/);
  assert.match(help, /\/connect <ip>/);
  assert.match(help, /Inspect/);
  assert.match(help, /Configure/);
  assert.match(help, /\/compact\s+compress older conversation history into a summary/);
  assert.match(help, /Shortcuts/);
  assert.match(help, /Ctrl\+V\s+attach a copied image/);
  assert.doesNotMatch(help, /\/attach <path>/);
  assert.match(help, /Advanced commands still work/);
  assert.doesNotMatch(help, /\/permissions\s+show safety/);
  assert.doesNotMatch(help, /\/config\s+show config file/);
  assert.doesNotMatch(help, /\/upgrade\s+show install/);
}

{
  const upgrade = renderCliUpgradeHelp();
  assert.match(upgrade, /moss update/);
  assert.match(upgrade, /npm i -g @rdk-moss\/agent@latest/);
  assert.match(upgrade, /npx -y @rdk-moss\/agent@latest/);
  assert.doesNotMatch(upgrade, /API key/);
}

console.log('[PASS] CLI onboarding surfaces capabilities and controls');
