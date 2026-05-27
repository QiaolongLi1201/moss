import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigDir } from './config.js';

type ColorFn = (s: string) => string;

interface Colors {
  bold: ColorFn;
  dim: ColorFn;
  red: ColorFn;
  green: ColorFn;
  yellow: ColorFn;
  blue: ColorFn;
  cyan: ColorFn;
  magenta: ColorFn;
  gray: ColorFn;
}

export function displayHelp(c: Colors): void {
  const configDir = resolveConfigDir();
  const lines = [
    '',
    `  ${c.bold(c.cyan('dmoss-agent'))}  ${c.dim('— standalone agent for robotics & edge devices')}`,
    '',
    `  ${c.bold('Quick start')}`,
    `    ${c.cyan('$')} dmoss-agent                      ${c.dim('# interactive REPL')}`,
    `    ${c.cyan('$')} dmoss-agent "check disk usage"   ${c.dim('# one-shot mode')}`,
    `    ${c.cyan('$')} echo "list files" | dmoss-agent  ${c.dim('# piped stdin')}`,
    '',
    `  ${c.bold('Interactive commands')}`,
    `    ${c.green('/model')} ${c.dim('<name>')}    switch LLM model (e.g. /model gpt-4o)`,
    `    ${c.green('/models')}          list suggested model names`,
    `    ${c.green('/memory')}          show stored long-term memories`,
    `    ${c.green('/skills')}          list learned SKILL.md entries`,
    `    ${c.green('/quit')}            exit`,
    '',
    `  ${c.bold('Flags')}`,
    `    ${c.yellow('--debug')}              verbose logging (level=debug)`,
    `    ${c.yellow('--quiet')}              only warnings & errors (level=warn)`,
    `    ${c.yellow('--log-level=')}${c.dim('<lv>')}   debug | info | warn | error`,
    `    ${c.yellow('--json')}               emit logs as JSON lines (log aggregators)`,
    `    ${c.yellow('--no-color')}           disable ANSI colors`,
    `    ${c.yellow('--help, -h')}           show this help`,
    `    ${c.yellow('--version, -v')}        show version`,
    '',
    `  ${c.bold('Environment')}`,
    `    ${c.magenta('DMOSS_API_KEY')}           ${c.dim('LLM API key (required)')}`,
    `    ${c.magenta('DMOSS_MODEL')}             ${c.dim('model name (default: claude-sonnet-4-20250514)')}`,
    `    ${c.magenta('DMOSS_BASE_URL')}          ${c.dim('LLM API base URL')}`,
    `    ${c.magenta('DMOSS_WORKSPACE')}         ${c.dim('working directory (default: cwd)')}`,
    `    ${c.magenta('DMOSS_EXEC_BACKEND')}      ${c.dim('local (default) or docker')}`,
    `    ${c.magenta('DMOSS_DOCKER_IMAGE')}      ${c.dim('docker image (default: node:20-slim)')}`,
    `    ${c.magenta('DMOSS_DEVICE_HOST')}       ${c.dim('device IP/hostname (enables SSH tools)')}`,
    `    ${c.magenta('DMOSS_DEVICE_USER')}       ${c.dim('device SSH user (default: root)')}`,
    `    ${c.magenta('DMOSS_DEVICE_PASSWORD')}   ${c.dim('device SSH password')}`,
    `    ${c.magenta('DMOSS_DEVICE_PORT')}       ${c.dim('device SSH port (default: 22)')}`,
    `    ${c.magenta('DMOSS_DEVICE_KEY')}        ${c.dim('path to SSH private key')}`,
    `    ${c.magenta('DMOSS_LOG_LEVEL')}         ${c.dim('overrides default log level')}`,
    `    ${c.magenta('DMOSS_LOG_JSON')}          ${c.dim('=1 → JSON log lines')}`,
    `    ${c.magenta('DMOSS_TRACE')}             ${c.dim('console → emit tracing spans to stderr')}`,
    `    ${c.magenta('DMOSS_LLM_USAGE_LOG')}     ${c.dim('path to append LLM usage JSONL records')}`,
    `    ${c.magenta('DMOSS_LLM_USAGE')}         ${c.dim('=1 → enable usage logging even without explicit path')}`,
    `    ${c.magenta('DMOSS_SELF_LEARNING')}     ${c.dim('=true → extract user correction feedback as memory')}`,
    '',
    `  ${c.bold('Config file')}`,
    `    ${c.gray(path.join(configDir, 'config.json'))}`,
    '',
    `  ${c.bold('Built-in features')}`,
    `    ${c.green('✓')} Session persistence (JSONL) with ${c.cyan('--resume')}-style recovery`,
    `    ${c.green('✓')} Long-term memory (memory_read / write / delete)`,
    `    ${c.green('✓')} Workspace context (USER.md, MEMORY.md, AGENTS.md auto-loaded)`,
    `    ${c.green('✓')} Skill learning — successful runs crystallize into SKILL.md`,
    `    ${c.green('✓')} Docker sandbox (${c.yellow('DMOSS_EXEC_BACKEND=docker')})`,
    `    ${c.green('✓')} ${c.cyan('LAN Agent Mesh')} — P2P discovery via UDP broadcast`,
    `    ${c.green('✓')} Framework-level tool-call self-healing (stream-error resilient)`,
    '',
    `  ${c.bold('Device & robotics tools')}`,
    `    ${c.blue('device_exec')} · ${c.blue('device_info')} · ${c.blue('device_file_read')} · ${c.blue('device_file_list')}`,
    `    ${c.blue('device_temperature')} · ${c.blue('device_resources')} · ${c.blue('device_processes')} · ${c.blue('device_network')} · ${c.blue('device_cameras')}`,
    `    ${c.blue('ros2_topic_list')} · ${c.blue('ros2_topic_echo')} · ${c.blue('ros2_topic_hz')} · ${c.blue('ros2_node_list')}`,
    `    ${c.blue('ros2_service_list')} · ${c.blue('ros2_service_call')} · ${c.blue('ros2_launch')} · ${c.blue('ros2_pkg_list')}`,
    '',
    `  ${c.dim('Docs: https://github.com/D-Moss/dmoss-agent · License: MIT')}`,
    '',
  ];
  console.log(lines.join('\n'));
  process.exit(0);
}

export function displayVersion(c: Colors): void {
  try {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'package.json',
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    console.log(`${c.bold('dmoss-agent')} ${c.cyan(`v${pkg.version}`)}`);
  } catch {
    console.log(`${c.bold('dmoss-agent')} ${c.dim('(unknown version)')}`);
  }
  process.exit(0);
}
