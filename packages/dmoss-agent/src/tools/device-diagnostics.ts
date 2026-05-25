/**
 * Device Diagnostics Tools — monitor hardware health metrics.
 *
 * Works by executing diagnostic commands on the connected device via SSH.
 * Supports: CPU temperature, NPU/BPU status, memory usage, disk usage,
 * process list, and network interfaces.
 */

import type { Tool } from '../core/tool-types.js';
import type { DeviceSshConfig } from './device-ssh.js';
import { execFileSync } from 'node:child_process';

/** Escape a single shell argument for POSIX sh. */
function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function buildSshCommand(config: DeviceSshConfig, remoteCmd: string): string[] {
  const user = config.user || 'root';
  const port = config.port || 22;
  const parts = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=5'];
  if (config.keyPath) parts.push('-i', config.keyPath);
  parts.push('-p', String(port), `${user}@${config.host}`, shellEscape(remoteCmd));
  return parts;
}

function sshExec(config: DeviceSshConfig, cmd: string, timeout = 10_000): string {
  const sshArgs = buildSshCommand(config, cmd);

  try {
    const sshBin = config.password ? 'sshpass' : 'ssh';
    const sshAllArgs = config.password ? ['-e', 'ssh', ...sshArgs] : sshArgs;
    return execFileSync(sshBin, sshAllArgs, {
      timeout,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
      env: { ...process.env, SSHPASS: config.password || '' },
    }).trim();
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

export function createDeviceDiagnosticsTools(config: DeviceSshConfig): Tool[] {
  const deviceTemperature: Tool = {
    name: 'device_temperature',
    description: 'Read CPU and NPU/BPU temperature from the device.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      const cmd = [
        'echo "=== CPU Temperature ==="',
        'cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | while read t; do echo "  $(echo "scale=1; $t/1000" | bc)°C"; done',
        'echo ""',
        'echo "=== BPU Temperature (RDK) ==="',
        'cat /sys/class/hwmon/hwmon*/temp*_input 2>/dev/null | while read t; do echo "  $(echo "scale=1; $t/1000" | bc)°C"; done',
        'echo ""',
        'echo "=== GPU Temperature ==="',
        'cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | head -5 | while read t; do echo "  $(echo "scale=1; $t/1000" | bc)°C"; done',
      ].join(' && ');
      return sshExec(config, cmd);
    },
  };

  const deviceResources: Tool = {
    name: 'device_resources',
    description: 'Get CPU, memory, and disk usage of the device.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
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
      return sshExec(config, cmd);
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
    async execute(input) {
      // H1: Coerce to number and clamp to safe range [1, 100]
      const count = Math.max(1, Math.min(Number(input.count) || 10, 100));
      return sshExec(config, `ps aux --sort=-%cpu | head -${count + 1}`);
    },
  };

  const deviceNetwork: Tool = {
    name: 'device_network',
    description: 'Get network interfaces and connectivity status of the device.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
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
      return sshExec(config, cmd);
    },
  };

  const deviceCameras: Tool = {
    name: 'device_cameras',
    description: 'Enumerate camera devices and their supported formats (V4L2).',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
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
      return sshExec(config, cmd, 15_000);
    },
  };

  return [deviceTemperature, deviceResources, deviceProcesses, deviceNetwork, deviceCameras];
}
