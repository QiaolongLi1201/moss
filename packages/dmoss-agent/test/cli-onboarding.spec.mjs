#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-onboarding.spec.mjs
 */
import assert from 'node:assert/strict';
import {
  renderCliDetailHelp,
  renderCliExamples,
  renderCliInteractiveHelp,
  renderCliPermissions,
  renderCliStatus,
  renderCliTools,
  renderCliUpgradeHelp,
  renderCliWelcome,
} from '../dist/cli/onboarding.js';

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

const runtime = {
  workspace: '/tmp/dmoss-workspace',
  runtimeDir: '/tmp/dmoss-runtime',
  configDir: '/tmp/dmoss-config',
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
    workspace: '/tmp/dmoss-workspace',
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
    mcpConfigPath: '/tmp/dmoss-config/mcp.json',
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
    configPath: '/tmp/dmoss-config/config.json',
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
  assert.match(welcome, /D-Moss Agent/);
  assert.match(welcome, /model: qwen3\.7-max/);
  assert.match(welcome, /session: cli/);
  assert.doesNotMatch(welcome, /\+-+\+/);
  assert.match(welcome, /capabilities: workspace 2/);
  assert.match(welcome, /device root@10\.64\.1\.10:22/);
  assert.match(welcome, /mesh on/);
  assert.match(welcome, /profile autonomous/);
  assert.match(welcome, /approval never/);
  assert.match(welcome, /cache off/);
  assert.match(welcome, /guardrails in 2 out 1/);
  assert.match(welcome, /commands.*\/help.*\/tools.*\/status/);
}

{
  const welcome = renderCliWelcome(agent, disconnectedRuntime);
  assert.match(welcome, /device not configured/);
}

{
  const tools = renderCliTools(agent);
  assert.match(tools, /Tools/);
  assert.match(tools, /Workspace/);
  assert.match(tools, /read_file Read a file/);
  assert.match(tools, /Memory/);
  assert.match(tools, /Device SSH/);
  assert.match(tools, /ROS2\/TROS/);
  assert.match(tools, /Agent Mesh/);
}

{
  const status = renderCliStatus(agent, runtime);
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
  assert.match(status, /tools: 7/);
}

{
  const permissions = renderCliPermissions(runtime);
  assert.match(permissions, /Permissions & Config/);
  assert.match(permissions, /config file: \/tmp\/dmoss-config\/config\.json/);
  assert.match(permissions, /profile: autonomous \(config\)/);
  assert.match(permissions, /safety: workspace-write \(config\)/);
  assert.match(permissions, /approval: never \(config\)/);
  assert.match(permissions, /trusted tools: exec \(config\)/);
  assert.match(permissions, /denied tools: device_exec \(config\)/);
  assert.match(permissions, /prompt cache: disabled \(config\)/);
  assert.match(permissions, /prompt cache debug: enabled \(config\)/);
  assert.match(permissions, /mcp: enabled \(config\)/);
  assert.match(permissions, /mcp config: \/tmp\/dmoss-config\/mcp\.json \(config\)/);
  assert.match(permissions, /guardrails: input 2, output 1 \(config\)/);
  assert.match(permissions, /max turns: 18 \(config\)/);
  assert.match(permissions, /context tokens: 96000 \(config\)/);
  assert.match(permissions, /compaction: reserve 8000, keepRecent 9000 \(config\)/);
  assert.match(permissions, /config warnings: 1/);
  assert.match(permissions, /approval\.auto_approval: auto-approval is enabled via config/);
  assert.match(permissions, /edit guardrails\.input\/output/);
  assert.match(permissions, /dmoss config init --project/);
  assert.match(permissions, /dmoss config set agent\.maxTurns/);
  assert.match(permissions, /dmoss config set agent\.contextTokens/);
  assert.match(permissions, /dmoss config set agent\.compaction\.reserveTokens/);
  assert.match(permissions, /dmoss config set safetyMode/);
  assert.match(permissions, /dmoss config set --project safetyMode/);
  assert.match(permissions, /dmoss config set workspace/);
  assert.match(permissions, /dmoss config set profile/);
  assert.match(permissions, /dmoss config set trustedTools/);
  assert.match(permissions, /dmoss config set deniedTools/);
  assert.match(permissions, /dmoss config set promptCacheDebug/);
  assert.match(permissions, /dmoss config set mcp\.enabled/);
  assert.match(permissions, /dmoss config set mcp\.configPath/);
  assert.match(permissions, /dmoss config unset --project safetyMode/);
  assert.match(permissions, /dmoss config unset approvalPolicy/);
  assert.match(permissions, /trust the approved tool for the current session/);
  assert.match(permissions, /DMOSS_PROFILE/);
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
  const status = renderCliStatus(agent, { ...runtime, safetyMode: 'read-only' });
  assert.match(status, /safety: read-only/);
}

{
  const examples = renderCliExamples(agent, runtime);
  assert.match(examples, /分析当前工程结构/);
  assert.match(examples, /检查板端 CPU/);
  assert.match(examples, /列出板端 ROS2 topic/);
  assert.match(examples, /mesh peer/);
}

{
  const examples = renderCliExamples(agent, disconnectedRuntime);
  assert.match(examples, /DMOSS_DEVICE_HOST/);
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
  assert.match(help, /Inspect/);
  assert.match(help, /Configure/);
  assert.match(help, /\/permissions/);
  assert.match(help, /\/config/);
  assert.match(help, /\/upgrade/);
}

{
  const upgrade = renderCliUpgradeHelp();
  assert.match(upgrade, /dmoss update/);
  assert.match(upgrade, /npm i -g @rdk-moss\/agent@latest/);
  assert.match(upgrade, /npx -y @rdk-moss\/agent@latest/);
  assert.doesNotMatch(upgrade, /API key/);
}

console.log('[PASS] CLI onboarding surfaces capabilities and controls');
