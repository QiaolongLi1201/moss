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
  assert.match(welcome, /Model: qwen3\.7-max/);
  assert.match(welcome, /\+-+\+/);
  assert.match(welcome, /Workspace: read_file, write_file/);
  assert.match(welcome, /Device SSH: device_resources/);
  assert.match(welcome, /ROS2\/TROS: ros2_topic_list/);
  assert.match(welcome, /Mesh: enabled/);
  assert.match(welcome, /Try: \/tools \| \/status \| \/examples \| \/upgrade/);
}

{
  const welcome = renderCliWelcome(agent, disconnectedRuntime);
  assert.match(welcome, /Device: not connected - set DMOSS_DEVICE_HOST/);
}

{
  const tools = renderCliTools(agent);
  assert.match(tools, /\[tools\]/);
  assert.match(tools, /Workspace/);
  assert.match(tools, /- read_file: Read a file/);
  assert.match(tools, /Memory/);
  assert.match(tools, /Device SSH/);
  assert.match(tools, /ROS2\/TROS/);
  assert.match(tools, /Agent Mesh/);
}

{
  const status = renderCliStatus(agent, runtime);
  assert.match(status, /provider: token-plan\.cn-beijing\.maas\.aliyuncs\.com/);
  assert.match(status, /device: root@10\.64\.1\.10:22/);
  assert.match(status, /safety: workspace-write/);
  assert.match(status, /tools: 7/);
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
  assert.match(help, /\/upgrade/);
}

{
  const upgrade = renderCliUpgradeHelp();
  assert.match(upgrade, /npm i -g @rdk-moss\/agent@latest/);
  assert.match(upgrade, /npx -y @rdk-moss\/agent@latest/);
  assert.doesNotMatch(upgrade, /API key/);
}

console.log('[PASS] CLI onboarding surfaces capabilities and controls');
