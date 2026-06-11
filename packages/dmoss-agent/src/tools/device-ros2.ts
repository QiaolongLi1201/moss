/**
 * ROS2 Tools — interact with ROS2/TROS nodes, topics, and services
 * on a connected device.
 *
 * Requires ROS2 (or TROS) installed on the device.
 * Commands are executed via SSH on the target device.
 */

import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import type { DeviceSshConfig } from './device-ssh.js';
import { wrapAsDmoss, ErrorCode } from '../errors.js';
import { buildSshCommand, runSsh, sshBinFor, shellEscape, sshFailureToError } from './ssh-utils.js';

const ROS_SETUP = 'source /opt/tros/humble/setup.bash 2>/dev/null || source /opt/ros/humble/setup.bash 2>/dev/null || true';

/** @internal */
export const ROS2_LAUNCH_OK_MARKER = '__MOSS_ROS2_LAUNCH_OK__';
/** @internal */
export const ROS2_LAUNCH_DEAD_MARKER = '__MOSS_ROS2_LAUNCH_DEAD__';

/**
 * Interpret the marker-tagged output of the ros2_launch verification script.
 * Exported for tests. Throws when the launched process died within 1s.
 *
 * @internal
 */
export function interpretRos2LaunchOutput(output: string, pkg: string, launchFile: string): string {
  const okLine = output.split('\n').find((line) => line.includes(ROS2_LAUNCH_OK_MARKER));
  if (okLine) {
    const pid = okLine.match(/pid=(\d+)/)?.[1];
    return `Launched ${pkg}/${launchFile} (detached${pid ? `, pid ${pid}` : ''}, alive after 1s). Log: /tmp/ros2_launch_${pkg}.log`;
  }
  if (output.includes(ROS2_LAUNCH_DEAD_MARKER)) {
    const logTail = output
      .split('\n')
      .filter((line) => !line.includes(ROS2_LAUNCH_DEAD_MARKER))
      .join('\n')
      .trim();
    throw new Error(
      `ros2 launch ${pkg}/${launchFile} exited within 1s — it did NOT start.\n${logTail ? `Log tail:\n${logTail}` : 'Log was empty.'}`,
    );
  }
  throw new Error(
    `ros2_launch could not verify the process state (unexpected output):\n${output || '(no output)'}`,
  );
}

async function sshExec(
  config: DeviceSshConfig,
  cmd: string,
  timeout = 15_000,
  ctx?: ToolContext,
): Promise<string> {
  const remoteCmd = `${ROS_SETUP} && ${cmd}`;
  const sshArgs = buildSshCommand(config, remoteCmd, 5);

  try {
    const result = await runSsh(config, sshArgs, {
      timeout,
      maxBuffer: 5 * 1024 * 1024,
      signal: ctx?.abortSignal,
    });
    return result.stdout.trim();
  } catch (err) {
    // Failures must THROW so the pipeline marks the result isError —
    // returning the text here used to render SSH failures (auth errors,
    // unreachable host, failed ros2 commands) as successful tool calls.
    const sshError = sshFailureToError(err, sshBinFor(config));
    if (sshError) throw sshError;
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
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      return sshExec(config, 'ros2 topic list -t', 15_000, ctx);
    },
  };

  const ros2TopicEcho: Tool = {
    name: 'ros2_topic_echo',
    description: 'Subscribe to a ROS2 topic and show one message.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
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
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
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
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      return sshExec(config, 'ros2 node list', 15_000, ctx);
    },
  };

  const ros2ServiceList: Tool = {
    name: 'ros2_service_list',
    description: 'List all active ROS2 services on the device.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      return sshExec(config, 'ros2 service list -t', 15_000, ctx);
    },
  };

  const ros2ServiceCall: Tool = {
    name: 'ros2_service_call',
    description: 'Call a ROS2 service with specified arguments.',
    // Actuates the robot (can move motors, arm/disarm, trigger motion) — a real
    // device mutation. Without this the approval layer's name-inference defaults
    // it to readonly (no 'call' verb) and runs it ungated, even in --read-only.
    metadata: { sideEffectClass: 'device_mutation', planMode: 'requires_user_confirmation' },
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
    description: 'Launch a ROS2 launch file on the device (runs detached; verifies the process is still alive after 1s).',
    // Starts node processes on the robot — a device mutation; same gating as
    // ros2_service_call (name-inference has no 'launch' verb either).
    metadata: { sideEffectClass: 'device_mutation', planMode: 'requires_user_confirmation' },
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
      const logFile = `/tmp/ros2_launch_${shellEscape(input.package)}.log`;
      // Launch detached, then verify the process survived 1s — `nohup ... &`
      // exits 0 even when the launch dies instantly (bad package, missing
      // launch file), so a fixed "Launched" string here was a past lie.
      const cmd =
        `nohup ros2 launch ${shellEscape(input.package)} ${shellEscape(input.launch_file)}${args} > ${logFile} 2>&1 & ` +
        `pid=$!; sleep 1; ` +
        `if kill -0 "$pid" 2>/dev/null; then echo "${ROS2_LAUNCH_OK_MARKER} pid=$pid"; ` +
        `else echo "${ROS2_LAUNCH_DEAD_MARKER}"; tail -n 20 ${logFile} 2>/dev/null; fi`;
      const output = await sshExec(config, cmd, 10_000, ctx);
      return interpretRos2LaunchOutput(output, input.package, input.launch_file);
    },
  };

  const ros2PkgList: Tool = {
    name: 'ros2_pkg_list',
    description: 'List installed ROS2 packages on the device.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
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
