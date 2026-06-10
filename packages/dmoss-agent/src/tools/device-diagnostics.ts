/**
 * Device Diagnostics Tools — monitor hardware health metrics.
 *
 * Works by executing diagnostic commands on the connected device via SSH.
 * Supports: CPU temperature, NPU/BPU status, memory usage, disk usage,
 * process list, and network interfaces.
 */

import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import type { DeviceSshConfig } from './device-ssh.js';
import { safeChildEnv } from '../utils/safe-child-env.js';
import { runProcess, ProcessError } from '../utils/run-process.js';
import { wrapAsDmoss, ErrorCode } from '../errors.js';
import { buildSshCommand, missingSshExecutableProcessError } from './ssh-utils.js';

async function sshExec(
  config: DeviceSshConfig,
  cmd: string,
  timeout = 10_000,
  ctx?: ToolContext,
): Promise<string> {
  const sshArgs = buildSshCommand(config, cmd, 5);

  try {
    const sshBin = config.password ? 'sshpass' : 'ssh';
    const sshAllArgs = config.password ? ['-e', 'ssh', ...sshArgs] : sshArgs;
    const result = await runProcess(sshBin, {
      args: sshAllArgs,
      timeout,
      maxBuffer: 1024 * 1024,
      signal: ctx?.abortSignal,
      env: safeChildEnv(config.password ? { SSHPASS: config.password } : undefined),
    });
    return result.stdout.trim();
  } catch (err) {
    // Failures must THROW so the pipeline marks the result isError (UI "err",
    // skill evidence failed:true). Returning the text rendered SSH failures
    // as successful tool calls.
    const missingExecutable = missingSshExecutableProcessError(
      err,
      config.password ? 'sshpass' : 'ssh',
    );
    if (missingExecutable) throw new Error(missingExecutable.stderr);
    if (err instanceof ProcessError) {
      const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
      throw new Error(output || err.message);
    }
    throw wrapAsDmoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
      hint: 'Check SSH connectivity and device power',
      recoverable: true,
    });
  }
}

export function createDeviceDiagnosticsTools(config: DeviceSshConfig): Tool[] {
  const deviceTemperature: Tool = {
    name: 'device_temperature',
    description: 'Read CPU and NPU/BPU temperature from the device.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      const cmd = [
        'echo "=== CPU Temperature ==="',
        'cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | while read t; do echo "  $(echo "scale=1; $t/1000" | bc)°C"; done',
        'echo ""',
        'echo "=== Accelerator Temperature ==="',
        'cat /sys/class/hwmon/hwmon*/temp*_input 2>/dev/null | while read t; do echo "  $(echo "scale=1; $t/1000" | bc)°C"; done',
        'echo ""',
        'echo "=== GPU Temperature ==="',
        'cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | head -5 | while read t; do echo "  $(echo "scale=1; $t/1000" | bc)°C"; done',
      ].join(' && ');
      return sshExec(config, cmd, 10_000, ctx);
    },
  };

  const deviceResources: Tool = {
    name: 'device_resources',
    description: 'Get CPU, memory, and disk usage of the device.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      const cmd = [
        'echo "=== CPU Usage ==="',
        'top -bn1 | head -5',
        'echo ""',
        'echo "=== Memory ==="',
        'free -h',
        'echo ""',
        'echo "=== Disk ==="',
        'df -h / /tmp /userdata 2>/dev/null | grep -v tmpfs',
        'echo ""',
        'echo "=== NPU/BPU Status ==="',
        'cat /sys/devices/system/bpu/bpu*/ratio 2>/dev/null && echo "(BPU load)" || echo "N/A"',
      ].join(' && ');
      return sshExec(config, cmd, 10_000, ctx);
    },
  };

  const deviceProcesses: Tool = {
    name: 'device_processes',
    description: 'List top processes by CPU/memory usage on the device.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of processes to show (default: 10)' },
      },
    },
    async execute(input, ctx) {
      const count = Math.max(1, Math.min(Number(input.count) || 10, 100));
      return sshExec(config, `ps aux --sort=-%cpu | head -${count + 1}`, 10_000, ctx);
    },
  };

  const deviceNetwork: Tool = {
    name: 'device_network',
    description: 'Get network interfaces and connectivity status of the device.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      const cmd = [
        'echo "=== IP Addresses ==="',
        'ip -4 addr show | grep -E "inet " | awk \'{print $NF, $2}\'',
        'echo ""',
        'echo "=== Default Route ==="',
        'ip route | grep default',
        'echo ""',
        'echo "=== DNS ==="',
        'cat /etc/resolv.conf | grep nameserver',
        'echo ""',
        'echo "=== Internet Check ==="',
        'ping -c 1 -W 2 8.8.8.8 > /dev/null 2>&1 && echo "Online" || echo "Offline"',
      ].join(' && ');
      return sshExec(config, cmd, 10_000, ctx);
    },
  };

  const deviceCameras: Tool = {
    name: 'device_cameras',
    description: 'Enumerate camera devices and their supported formats (V4L2).',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      const cmd = [
        'echo "=== Video Devices ==="',
        'ls -la /dev/video* 2>/dev/null || echo "No video devices"',
        'echo ""',
        'for dev in /dev/video*; do',
        '  echo "=== $dev ==="',
        '  v4l2-ctl -d "$dev" --list-formats-ext 2>/dev/null | head -30',
        '  echo ""',
        'done',
      ].join(' ');
      return sshExec(config, cmd, 15_000, ctx);
    },
  };

  return [deviceTemperature, deviceResources, deviceProcesses, deviceNetwork, deviceCameras];
}
