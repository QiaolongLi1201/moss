import path from 'node:path';
import { resolveConfigDir } from './config.js';
import { getPackageVersion } from './package-info.js';

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
    `  ${c.bold(c.cyan('dmoss'))}  ${c.dim('— standalone agent for robotics & edge devices')}`,
    '',
    `  ${c.bold('Quick start')}`,
    `    ${c.cyan('$')} dmoss setup                ${c.dim('# configure provider, model, and API key')}`,
    `    ${c.cyan('$')} dmoss                      ${c.dim('# interactive TUI')}`,
    `    ${c.cyan('$')} dmoss -m deepseek-v4-pro   ${c.dim('# override model for this run')}`,
    `    ${c.cyan('$')} dmoss resume --last        ${c.dim('# continue the latest saved session')}`,
    `    ${c.cyan('$')} dmoss "check disk usage"   ${c.dim('# one-shot mode')}`,
    `    ${c.cyan('$')} echo "list files" | dmoss  ${c.dim('# piped stdin')}`,
    '',
    `  ${c.bold('Setup & auth')}`,
    `    ${c.green('setup')}                 guided first-run model setup`,
    `    ${c.green('auth status')}           show provider/model/key source without printing secrets`,
    `    ${c.green('auth logout')}           remove stored API key from config`,
    `    ${c.green('doctor')}                inspect config, auth, workspace, runtime, and update state`,
    `    ${c.green('update')}                run npm global update for dmoss`,
    `    ${c.green('resume')} ${c.dim('[--last]')}       resume a saved JSONL session`,
    `    ${c.green('fork')} ${c.dim('[--last]')}         copy a saved session into a new branch`,
    `    ${c.green('config set model')} ${c.dim('<m>')}  update stored model`,
    `    ${c.green('config set baseUrl')} ${c.dim('<u>')} update stored OpenAI-compatible base URL`,
    `    ${c.green('config set provider')} ${c.dim('<p>')} qwen | openai | anthropic | openai-compatible`,
    `    ${c.green('config set promptCacheDebug')} ${c.dim('<bool>')} enable prompt-prefix cache diagnostics`,
    '',
    `  ${c.bold('Interactive commands')}`,
    `    ${c.green('/help')}            show interactive commands`,
    `    ${c.green('/tools')}           show registered tools grouped by capability`,
    `    ${c.green('/status')}          show model, workspace, runtime, device, and tool state`,
    `    ${c.green('/examples')}        show prompts matched to enabled capabilities`,
    `    ${c.green('/model')} ${c.dim('<name>')}    switch LLM model (e.g. /model gpt-4o)`,
    `    ${c.green('/models')}          list suggested model names`,
    `    ${c.green('/detail')} ${c.dim('<mode>')}   quiet | progress | verbose tool/thinking display`,
    `    ${c.green('/memory')}          show stored long-term memories`,
    `    ${c.green('/skills')}          list learned SKILL.md entries`,
    `    ${c.green('/upgrade')}         show install/update commands`,
    `    ${c.green('/quit')}            exit`,
    '',
    `  ${c.bold('Flags')}`,
    `    ${c.yellow('--debug')}              verbose logging (level=debug)`,
    `    ${c.yellow('--quiet')}              only warnings & errors (level=warn)`,
    `    ${c.yellow('--log-level=')}${c.dim('<lv>')}   debug | info | warn | error`,
    `    ${c.yellow('--json')}               emit logs as JSON lines (log aggregators)`,
    `    ${c.yellow('-m, --model')} ${c.dim('<m>')}     override model for this run`,
    `    ${c.yellow('-C, --cd')} ${c.dim('<dir>')}      use a different workspace`,
    `    ${c.yellow('-c, --config')} ${c.dim('k=v')}    override model/provider/baseUrl/workspace`,
    `    ${c.yellow('--provider')} ${c.dim('<p>')}      qwen | openai | anthropic | openai-compatible`,
    `    ${c.yellow('--base-url')} ${c.dim('<url>')}    override provider base URL`,
    `    ${c.yellow('--session')} ${c.dim('<key>')}     use a named session key`,
    `    ${c.yellow('--last')}               with resume/fork, use latest session`,
    `    ${c.yellow('--ask-for-approval')} ${c.dim('<p>')} never | on-request | untrusted`,
    `    ${c.yellow('--read-only')}          block mutating tools`,
    `    ${c.yellow('--workspace-write')}    allow workspace writes/exec with approval (default)`,
    `    ${c.yellow('--full-access')}        allow device/external tools with approval`,
    `    ${c.yellow('--no-color')}           disable ANSI colors`,
    `    ${c.yellow('--help, -h')}           show this help`,
    `    ${c.yellow('--version, -v')}        show version`,
    '',
    `  ${c.bold('Environment')}`,
    `    ${c.magenta('DMOSS_PROVIDER')}          ${c.dim('qwen | openai | anthropic | openai-compatible')}`,
    `    ${c.magenta('DMOSS_API_KEY')}           ${c.dim('LLM API key (required)')}`,
    `    ${c.magenta('DASHSCOPE_API_KEY')}       ${c.dim('Aliyun/Qwen API key fallback')}`,
    `    ${c.magenta('ANTHROPIC_API_KEY')}       ${c.dim('Anthropic API key fallback')}`,
    `    ${c.magenta('OPENAI_API_KEY')}          ${c.dim('OpenAI-compatible API key fallback')}`,
    `    ${c.magenta('DMOSS_MODEL')}             ${c.dim('model name (default: claude-sonnet-4-20250514)')}`,
    `    ${c.magenta('DMOSS_BASE_URL')}          ${c.dim('LLM API base URL')}`,
    `    ${c.magenta('DMOSS_WORKSPACE')}         ${c.dim('working directory (default: cwd)')}`,
    `    ${c.magenta('DMOSS_EXEC_BACKEND')}      ${c.dim('local (default) or docker')}`,
    `    ${c.magenta('DMOSS_SAFETY_MODE')}       ${c.dim('read-only | workspace-write | full-access')}`,
    `    ${c.magenta('DMOSS_CLI_AUTO_APPROVE')}  ${c.dim('=1 → approve allowed mutating tools without prompting')}`,
    `    ${c.magenta('DMOSS_DOCKER_IMAGE')}      ${c.dim('docker image (default: node:20-slim)')}`,
    `    ${c.magenta('DMOSS_DEVICE_HOST')}       ${c.dim('device IP/hostname (enables SSH tools)')}`,
    `    ${c.magenta('DMOSS_DEVICE_USER')}       ${c.dim('device SSH user (default: root)')}`,
    `    ${c.magenta('DMOSS_DEVICE_PASSWORD')}   ${c.dim('device SSH password')}`,
    `    ${c.magenta('DMOSS_DEVICE_PORT')}       ${c.dim('device SSH port (default: 22)')}`,
    `    ${c.magenta('DMOSS_DEVICE_KEY')}        ${c.dim('path to SSH private key')}`,
    `    ${c.magenta('DMOSS_LOG_LEVEL')}         ${c.dim('overrides default log level')}`,
    `    ${c.magenta('DMOSS_LOG_JSON')}          ${c.dim('=1 → JSON log lines')}`,
    `    ${c.magenta('DMOSS_CLI_DETAIL')}        ${c.dim('quiet | progress (default) | verbose')}`,
    `    ${c.magenta('DMOSS_SHOW_THINKING')}     ${c.dim('=true → print raw thinking deltas in verbose mode')}`,
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
    `  ${c.dim('Docs: https://github.com/QiaolongLi1201/moss/tree/main/packages/dmoss-agent · License: MIT')}`,
    '',
  ];
  console.log(lines.join('\n'));
  process.exit(0);
}

export function displayVersion(c: Colors): void {
  const version = getPackageVersion();
  console.log(`${c.bold('dmoss')} ${version === 'unknown' ? c.dim('(unknown version)') : c.cyan(`v${version}`)}`);
  process.exit(0);
}
