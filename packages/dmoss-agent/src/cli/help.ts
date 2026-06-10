import { resolveConfigPath } from './config.js';
import { INTERACTIVE_COMMAND_SECTIONS } from './interactive-commands.js';
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

export function displayHelp(c: Colors, options: { all?: boolean } = {}): void {
  const configPath = resolveConfigPath();
  const interactiveLines = INTERACTIVE_COMMAND_SECTIONS.flatMap((section) => [
    `    ${c.bold(section.title)}`,
    ...section.rows.map((row) => `      ${c.green(row.command.padEnd(24))} ${row.description}`),
  ]);
  if (!options.all) {
    const lines = [
      '',
      `  ${c.bold(c.cyan('moss'))}  ${c.dim('— Moss, the D-Robotics robotics agent')}`,
      '',
      `  ${c.bold('Most useful')}`,
      `    ${c.cyan('$')} moss                          ${c.dim('# start interactive Moss; built-in model is ready')}`,
      `    ${c.cyan('$')} moss auth login               ${c.dim('# optional: link a D-Robotics community account')}`,
      `    ${c.cyan('$')} moss auth login --manual      ${c.dim('# optional SSH/board login fallback: paste redirect URL or token')}`,
      `    ${c.cyan('$')} moss setup                    ${c.dim('# use your own provider/model/API key instead')}`,
      `    ${c.cyan('$')} moss "check this project"      ${c.dim('# one-shot mode')}`,
      '',
      `  ${c.bold('Inside Moss')}`,
      `    ${c.green('/help')}          focused command help`,
      `    ${c.green('/status')}        current model, login, workspace, board`,
      `    ${c.green('/model')}         choose/switch model for this session`,
      `    ${c.green('Ctrl+V / paste path')} attach copied images, Finder files, or file paths in the TUI`,
      `    ${c.green('/connect <ip>')}  connect an RDK board for this session`,
      '',
      `  ${c.bold('Model configuration')}`,
      `    Built-in: no model API key or community login is required; ${c.green('moss auth login')} is optional.`,
      `    Own model example:`,
      `      moss setup ${c.dim('# interactive: choose provider + model, paste API key')}`,
      `    OpenAI-compatible example:`,
      `      moss config set provider openai-compatible`,
      `      moss config set model <your-model>`,
      `      moss config set baseUrl <https://host/v1>`,
      `      moss config set imageInput true ${c.dim('# only if that gateway accepts image_url')}`,
      `      moss setup ${c.dim('# stores the API key (hidden prompt)')}`,
      `    Priority: ${c.bold('CLI flags/-c')} > ${c.bold('project .moss/config.json')} > ${c.bold('user config')} > ${c.bold('built-in default')}.`,
      `    Model settings are never read from environment variables (DEEPSEEK_API_KEY etc. are ignored).`,
      '',
      `  ${c.dim('Full reference: moss --help --all · config reference: moss config --help · dmoss remains a compatible alias')}`,
      `  ${c.dim(`Config file: ${configPath}`)}`,
      '',
    ];
    console.log(lines.join('\n'));
    process.exit(0);
  }
  const lines = [
    '',
    `  ${c.bold(c.cyan('moss'))}  ${c.dim('— standalone agent for robotics & edge devices')}`,
    '',
    `  ${c.bold('Quick start')}`,
    `    ${c.cyan('$')} moss                       ${c.dim('# interactive TUI; built-in model works without login')}`,
    `    ${c.cyan('$')} moss setup                 ${c.dim('# optional: use your own provider, model, and API key')}`,
    `    ${c.cyan('$')} moss -m qwen-plus          ${c.dim('# override model for this run')}`,
    `    ${c.cyan('$')} moss resume --last         ${c.dim('# continue the latest saved session')}`,
    `    ${c.cyan('$')} moss --session work        ${c.dim('# continue or create a named session')}`,
    `    ${c.cyan('$')} moss "check disk usage"    ${c.dim('# one-shot mode')}`,
    `    ${c.cyan('$')} echo "list files" | moss   ${c.dim('# piped stdin')}`,
    '',
    `  ${c.bold('Setup & auth')}`,
    `    ${c.green('setup')}                 configure your own provider/model/API key`,
    `    ${c.green('auth login')}            optional: link a D-Robotics developer community account`,
    `    ${c.green('auth status')}           show community login and provider/model/key status`,
    `    ${c.green('auth logout')}           remove stored community login and API key config`,
    `    ${c.green('doctor')}                inspect config, auth, workspace, runtime, and update state`,
    `    ${c.green('update')}                run npm global update for Moss`,
    `    ${c.green('resume')} ${c.dim('[--last]')}       resume a saved JSONL session`,
    `    ${c.green('fork')} ${c.dim('[--last]')}         copy a saved session into a new branch`,
    `    ${c.green('mcp list')}             show configured MCP servers`,
    `    ${c.green('mcp add')} ${c.dim('<name> <cmd> [args...]')} register an MCP server (no JSON editing)`,
    `    ${c.green('mcp remove')} ${c.dim('<name>')}    remove a configured MCP server`,
    `    ${c.green('config')}               show resolved config values and sources`,
    `    ${c.green('config show')}          same as config; safe for scripts`,
    `    ${c.green('config show --json')}   emit redacted resolved config JSON`,
    `    ${c.green('config validate')}      check config files and audit warnings`,
    `    ${c.green('config validate --strict')} fail when audit warnings are present`,
    `    ${c.green('config init')}          create a user or project config file`,
    `    ${c.green('config set model')} ${c.dim('<m>')}  update stored model`,
    `    ${c.green('config set baseUrl')} ${c.dim('<u>')} update stored OpenAI-compatible base URL`,
    `    ${c.green('config set profile')} ${c.dim('<p>')} cautious | balanced | autonomous`,
    `    ${c.green('config set provider')} ${c.dim('<p>')} deepseek | qwen | openai | anthropic | openai-compatible`,
    `    ${c.green('config set imageInput')} ${c.dim('<bool>')} send image_url parts to vision-capable providers`,
    `    ${c.green('config set trustedTools')} ${c.dim('<csv>')} auto-approve tool names/globs after safety checks`,
    `    ${c.green('config set deniedTools')} ${c.dim('<csv>')} always block tool names/globs`,
    `    ${c.green('config set promptCacheDebug')} ${c.dim('<bool>')} enable prompt-prefix cache diagnostics`,
    `    ${c.green('config set guardrails.input.redactPatterns')} ${c.dim('<csv>')} redact matching user text`,
    `    ${c.green('config set guardrails.output.blockPatterns')} ${c.dim('<csv>')} block matching responses`,
    `    ${c.green('config set mcp.enabled')} ${c.dim('<bool>')} enable MCP servers from config`,
    `    ${c.green('config set mcp.configPath')} ${c.dim('<path>')} set MCP server config path`,
    `    ${c.green('config set agent.maxTurns')} ${c.dim('<n>')} set per-request agent turn budget`,
    `    ${c.green('config set agent.contextTokens')} ${c.dim('<n>')} set context budget used by pruning/compaction`,
    `    ${c.green('config unset')} ${c.dim('<key>')}   remove a stored user/project override`,
    '',
    `  ${c.bold('Interactive commands')}`,
    ...interactiveLines,
    '',
    `  ${c.bold('Flags')}`,
    `    ${c.yellow('--debug')}              verbose logging (level=debug)`,
    `    ${c.yellow('--quiet')}              only warnings & errors (level=warn)`,
    `    ${c.yellow('--log-level=')}${c.dim('<lv>')}   debug | info | warn | error`,
    `    ${c.yellow('--json')}               emit logs as JSON lines (log aggregators)`,
    `    ${c.yellow('-m, --model')} ${c.dim('<m>')}     override model for this run`,
    `    ${c.yellow('-C, --cd')} ${c.dim('<dir>')}      use a different workspace`,
    `    ${c.yellow('-c, --config')} ${c.dim('k=v')}    override profile/model/provider/baseUrl/workspace/policy`,
    `    ${c.yellow('--config-file')} ${c.dim('<p>')}   read/write an explicit config JSON file`,
    `    ${c.yellow('--provider')} ${c.dim('<p>')}      deepseek | qwen | openai | anthropic | openai-compatible`,
    `    ${c.yellow('--base-url')} ${c.dim('<url>')}    override provider base URL`,
    `    ${c.yellow('--session')} ${c.dim('<key>')}     continue or create a named session key`,
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
    `    ${c.dim('Model settings (provider/model/baseUrl/apiKey) are never read from env vars —')}`,
    `    ${c.dim('use moss setup / moss config set. Leftover DEEPSEEK_API_KEY etc. are ignored.')}`,
    `    ${c.magenta('DMOSS_IMAGE_INPUT')}       ${c.dim('=true only for vision-capable OpenAI-compatible gateways')}`,
    `    ${c.magenta('DMOSS_PROFILE')}           ${c.dim('cautious | balanced | autonomous config profile')}`,
    `    ${c.magenta('DMOSS_CONFIG_FILE')}       ${c.dim('explicit config JSON path (overrides config dir)')}`,
    `    ${c.magenta('DMOSS_WORKSPACE')}         ${c.dim('working directory (default: cwd)')}`,
    `    ${c.magenta('DMOSS_EXEC_BACKEND')}      ${c.dim('local (default) or docker')}`,
    `    ${c.magenta('DMOSS_BROWSER_EXECUTABLE')} ${c.dim('Chrome/Chromium executable for browser tools')}`,
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
    `    ${c.gray(configPath)}`,
    `    ${c.gray('.moss/config.json')} ${c.dim('in the current workspace is read as project defaults')}`,
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
    `  ${c.dim('Docs: https://github.com/D-Robotics/moss/tree/main/packages/dmoss-agent · License: MIT')}`,
    '',
  ];
  console.log(lines.join('\n'));
  process.exit(0);
}

export function displayVersion(c: Colors): void {
  const version = getPackageVersion();
  console.log(`${c.bold('moss')} ${version === 'unknown' ? c.dim('(unknown version)') : c.cyan(`v${version}`)}`);
  process.exit(0);
}
