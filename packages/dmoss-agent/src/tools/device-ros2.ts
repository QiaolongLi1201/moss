/**
 * ROS2 Tools — interact with ROS2/TROS nodes, topics, and services
 * on a connected device.
 *
 * Requires ROS2 (or TROS) installed on the device.
 * Commands are executed via SSH on the target device.
 */

import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import type { DeviceSshConfig } from './device-ssh.js';
import { safeChildEnv } from '../utils/safe-child-env.js';
import { runProcess, ProcessError } from '../utils/run-process.js';
import { wrapAsDmoss, ErrorCode } from '../errors.js';

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

const ROS_SETUP = 'source /opt/tros/humble/setup.bash 2>/dev/null || source /opt/ros/humble/setup.bash 2>/dev/null || true';

function buildSshCommand(config: DeviceSshConfig, remoteCmd: string): string[] {
  const user = config.user || 'root';
  const port = config.port || 22;
  const parts = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=5'];
  if (config.keyPath) parts.push('-i', config.keyPath);
  parts.push('-p', String(port), `${user}@${config.host}`, shellEscape(remoteCmd));
  return parts;
}

async function sshExec(
  config: DeviceSshConfig,
  cmd: string,
  timeout = 15_000,
  ctx?: ToolContext,
): Promise<string> {
  const remoteCmd = `${ROS_SETUP} && ${cmd}`;
  const sshArgs = buildSshCommand(config, remoteCmd);

  try {
    const sshBin = config.password ? 'sshpass' : 'ssh';
    const sshAllArgs = config.password ? ['-e', 'ssh', ...sshArgs] : sshArgs;
    const result = await runProcess(sshBin, {
      args: sshAllArgs,
      timeout,
      maxBuffer: 5 * 1024 * 1024,
      signal: ctx?.abortSignal,
      env: safeChildEnv(config.password ? { SSHPASS: config.password } : undefined),
    });
    return result.stdout.trim();
  } catch (err) {
    if (err instanceof ProcessError) {
      const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
      return output || `Error: ${err.message}`;
    }
    throw wrapAsDmoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
      hint: 'Check SSH connectivity and ROS2 installation',
      recoverable: true,
    });
  }
}

export function createRos2Tools(config: DeviceSshConfig): Tool[] {
  const ros2TopicList: Tool = {
    name: 'ros2_topic_list',
    description: 'List all active ROS2 topics on the device.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      return sshExec(config, 'ros2 topic list -t', 15_000, ctx);
    },
  };

  const ros2TopicEcho: Tool = {
    name: 'ros2_topic_echo',
    description: 'Subscribe to a ROS2 topic and show one message.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic name (e.g. /camera/image_raw)' },
      },
      required: ['topic'],
    },
    async execute(input, ctx) {
      return sshExec(config, `timeout 5 ros2 topic echo ${shellEscape(input.topic)} --once 2>&1 || echo "(no message within 5s)"`, 10_000, ctx);
    },
  };

  const ros2TopicHz: Tool = {
    name: 'ros2_topic_hz',
    description: 'Measure the publishing rate of a ROS2 topic.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic name' },
      },
      required: ['topic'],
    },
    async execute(input, ctx) {
      return sshExec(config, `timeout 5 ros2 topic hz ${shellEscape(input.topic)} 2>&1 | tail -5`, 10_000, ctx);
    },
  };

  const ros2NodeList: Tool = {
    name: 'ros2_node_list',
    description: 'List all active ROS2 nodes on the device.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      return sshExec(config, 'ros2 node list', 15_000, ctx);
    },
  };

  const ros2ServiceList: Tool = {
    name: 'ros2_service_list',
    description: 'List all active ROS2 services on the device.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      return sshExec(config, 'ros2 service list -t', 15_000, ctx);
    },
  };

  const ros2ServiceCall: Tool = {
    name: 'ros2_service_call',
    description: 'Call a ROS2 service with specified arguments.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name' },
        type: { type: 'string', description: 'Service type (e.g. std_srvs/srv/Trigger)' },
        args: { type: 'string', description: 'YAML arguments (e.g. "{}") ' },
      },
      required: ['service', 'type'],
    },
    async execute(input, ctx) {
      const args = input.args || '{}';
      return sshExec(config, `ros2 service call ${shellEscape(input.service)} ${shellEscape(input.type)} ${shellEscape(args)}`, 15_000, ctx);
    },
  };

  const ros2Launch: Tool = {
    name: 'ros2_launch',
    description: 'Launch a ROS2 launch file on the device (runs detached).',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: 'ROS2 package name' },
        launch_file: { type: 'string', description: 'Launch file name' },
        args: { type: 'string', description: 'Additional launch arguments' },
      },
      required: ['package', 'launch_file'],
    },
    async execute(input, ctx) {
      const args = input.args ? ` ${shellEscape(input.args)}` : '';
      const cmd = `nohup ros2 launch ${shellEscape(input.package)} ${shellEscape(input.launch_file)}${args} > /tmp/ros2_launch_${shellEscape(input.package)}.log 2>&1 &`;
      await sshExec(config, cmd, 5_000, ctx);
      return `Launched ${input.package}/${input.launch_file} (detached). Log: /tmp/ros2_launch_${input.package}.log`;
    },
  };

  const ros2PkgList: Tool = {
    name: 'ros2_pkg_list',
    description: 'List installed ROS2 packages on the device.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filter by name (grep pattern)' },
      },
    },
    async execute(input, ctx) {
      const cmd = input.filter
        ? `ros2 pkg list | grep -i ${shellEscape(input.filter)}`
        : 'ros2 pkg list | head -50';
      return sshExec(config, cmd, 15_000, ctx);
    },
  };

  return [ros2TopicList, ros2TopicEcho, ros2TopicHz, ros2NodeList, ros2ServiceList, ros2ServiceCall, ros2Launch, ros2PkgList];
}
