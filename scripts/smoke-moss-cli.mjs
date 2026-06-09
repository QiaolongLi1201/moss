#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dummyZeroConfig = JSON.stringify({
  provider: 'openai-compatible',
  model: 'moss-smoke-model',
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'smoke-test-key',
});
const workspacePacks = [
  {
    name: '@rdk-moss/core',
    requiredFiles: ['dist/index.js'],
  },
  {
    name: '@rdk-moss/memory',
    requiredFiles: ['dist/index.js'],
  },
  {
    name: '@rdk-moss/skills',
    requiredFiles: ['dist/index.js'],
  },
  {
    name: '@rdk-moss/agent',
    requiredFiles: [
      'dist/cli.js',
      'zero-config-default.json',
      'assets/moss-tui-demo.gif',
      'assets/moss-connect-vision.gif',
    ],
    withDummyZeroConfig: true,
  },
];
const agentZeroConfigPath = path.join(repoRoot, 'packages', 'dmoss-agent', 'zero-config-default.json');

function log(step) {
  console.log(`[smoke:moss-cli] ${step}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    shell: options.shell ?? false,
  });
  if (result.status !== 0) {
    const rendered = [
      `$ ${command} ${args.join(' ')}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n');
    throw new Error(rendered);
  }
  return result;
}

function parsePackJson(stdout) {
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error(`npm pack did not emit JSON:\n${stdout}`);
  return JSON.parse(stdout.slice(start));
}

function assertMatch(text, pattern, label) {
  if (!pattern.test(text)) {
    throw new Error(`${label} did not match ${pattern}\n--- text ---\n${text}`);
  }
}

function assertNoDeprecatedInstallWarning(text) {
  const blocked = [
    /deprecated\s+@mariozechner\/pi-ai/i,
    /deprecated\s+node-domexception/i,
    /deprecated\s+node-fetch/i,
    /deprecated\s+fetch-blob/i,
  ];
  for (const pattern of blocked) {
    if (pattern.test(text)) throw new Error(`install emitted deprecated dependency warning: ${pattern}\n${text}`);
  }
}

function assertInstalledLocalWorkspaceTarballs(tempRoot) {
  const lockfilePath = path.join(tempRoot, 'package-lock.json');
  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  for (const workspace of workspacePacks) {
    const packagePath = `node_modules/${workspace.name}`;
    const entry = lockfile.packages?.[packagePath];
    if (!entry) throw new Error(`package-lock.json is missing ${packagePath}`);
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('file:')) {
      throw new Error(`${workspace.name} did not install from a local tarball: ${entry.resolved ?? '<missing>'}`);
    }
  }
}

function cleanMossEnv(tempRoot) {
  const env = {
    ...process.env,
    HOME: path.join(tempRoot, 'home'),
    XDG_CONFIG_HOME: path.join(tempRoot, 'home', '.config'),
    DMOSS_CONFIG_DIR: path.join(tempRoot, 'home', '.config', 'dmoss'),
    DMOSS_RUNTIME_DIR: path.join(tempRoot, 'home', '.dmoss-runtime'),
    DMOSS_NO_UPDATE_CHECK: '1',
    DMOSS_NO_COLOR: '1',
  };
  for (const key of [
    'DMOSS_API_KEY',
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DASHSCOPE_API_KEY',
    'ALIYUN_API_KEY',
    'DMOSS_PROVIDER',
    'DMOSS_MODEL',
    'DMOSS_BASE_URL',
    'OPENAI_BASE_URL',
    'ANTHROPIC_BASE_URL',
    'DASHSCOPE_BASE_URL',
    'DMOSS_NO_BUNDLED_DEFAULT',
    'DMOSS_BUNDLED_DEFAULT_FILE',
    'DMOSS_ZERO_CONFIG_DEFAULT_FILE',
    'DMOSS_ZERO_CONFIG_DEFAULT_JSON',
  ]) {
    delete env[key];
  }
  return env;
}

function runPtyStartup(binPath, tempRoot) {
  const python = process.platform === 'win32' ? null : (spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0 ? 'python3' : null);
  if (!python) {
    log('skipping PTY startup check because python3/pty is unavailable');
    return;
  }
  const code = String.raw`
import os, pty, select, subprocess, sys, tempfile, time
bin_path = sys.argv[1]
temp_root = sys.argv[2]
master, slave = pty.openpty()
home = tempfile.mkdtemp(prefix='home-', dir=temp_root)
workspace = tempfile.mkdtemp(prefix='workspace-', dir=temp_root)
env = {
  'PATH': os.environ.get('PATH', ''),
  'HOME': home,
  'TERM': 'xterm-256color',
  'LANG': 'C.UTF-8',
  'DMOSS_NO_UPDATE_CHECK': '1',
  'DMOSS_NO_COLOR': '1',
  'DMOSS_CONFIG_DIR': os.path.join(home, 'config'),
  'DMOSS_RUNTIME_DIR': os.path.join(home, 'runtime'),
}
proc = subprocess.Popen([bin_path], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=workspace)
os.close(slave)
data = b''
try:
  deadline = time.time() + 5
  while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 0.2)
    if r:
      chunk = os.read(master, 8192)
      if not chunk:
        break
      data += chunk
      if b'Moss' in data and (b'/help' in data or b'Ask Moss' in data or b'login' in data.lower()):
        break
  try:
    os.write(master, b'\x03')
  except OSError:
    pass
  try:
    proc.wait(timeout=2)
  except subprocess.TimeoutExpired:
    proc.kill()
    proc.wait(timeout=2)
finally:
  os.close(master)
text = data.decode('utf-8', 'replace')
print(text[:2000])
if 'Moss' not in text or not ('/help' in text or 'Ask Moss' in text or 'login' in text.lower()):
  raise SystemExit('Moss TUI startup text was not detected')
`;
  const result = run(python, ['-c', code, binPath, tempRoot], { cwd: repoRoot });
  assertMatch(result.stdout, /Moss/, 'PTY startup');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-cli-smoke-'));
const tarballPaths = [];

try {
  log('building @rdk-moss/agent');
  run('npm', ['run', 'build', '-w', '@rdk-moss/agent'], { stdio: 'inherit' });

  log('packing current @rdk-moss workspaces');
  for (const workspace of workspacePacks) {
    if (workspace.withDummyZeroConfig && fs.existsSync(agentZeroConfigPath)) {
      throw new Error(
        'Refusing to pack @rdk-moss/agent while packages/dmoss-agent/zero-config-default.json already exists. ' +
        'Remove the local file or run the release pack path instead; smoke must not package a real gateway secret.',
      );
    }
    const packEnv = { ...process.env };
    if (workspace.withDummyZeroConfig) {
      packEnv.DMOSS_ZERO_CONFIG_DEFAULT_JSON = dummyZeroConfig;
    } else {
      delete packEnv.DMOSS_ZERO_CONFIG_DEFAULT_JSON;
    }
    delete packEnv.DMOSS_ZERO_CONFIG_DEFAULT_FILE;
    delete packEnv.DMOSS_BUNDLED_DEFAULT_FILE;
    const pack = run('npm', ['pack', '--workspace', workspace.name, '--json'], { env: packEnv });
    const packInfo = parsePackJson(pack.stdout)[0];
    const tarballPath = path.join(repoRoot, packInfo.filename);
    tarballPaths.push(tarballPath);
    const packedFiles = new Set(packInfo.files.map((file) => file.path));
    for (const required of workspace.requiredFiles) {
      if (!packedFiles.has(required)) throw new Error(`${workspace.name} tarball is missing ${required}`);
    }
    if ((packInfo.bundled ?? []).length !== 0) {
      throw new Error(`${workspace.name} has unexpected bundled dependencies: ${packInfo.bundled.join(', ')}`);
    }
  }

  log('installing packed workspace tarballs into a temporary project');
  run('npm', ['init', '-y'], { cwd: tempRoot });
  const install = run('npm', ['install', ...tarballPaths, '--no-audit', '--no-fund'], { cwd: tempRoot });
  assertNoDeprecatedInstallWarning(`${install.stdout}\n${install.stderr}`);
  assertInstalledLocalWorkspaceTarballs(tempRoot);

  const packageJsonPath = path.join(tempRoot, 'node_modules', '@rdk-moss', 'agent', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (packageJson.bin?.moss !== 'dist/cli.js') throw new Error('package.json bin.moss is missing or incorrect');
  if (packageJson.bin?.dmoss !== 'dist/cli.js') throw new Error('package.json bin.dmoss is missing or incorrect');
  if (packageJson.bin?.['dmoss-agent'] !== 'dist/cli.js') throw new Error('package.json bin.dmoss-agent is missing or incorrect');
  if (!fs.existsSync(path.join(tempRoot, 'node_modules', '@rdk-moss', 'agent', 'assets', 'moss-tui-demo.gif'))) {
    throw new Error('installed package is missing README GIF assets');
  }

  const binDir = path.join(tempRoot, 'node_modules', '.bin');
  const mossBin = path.join(binDir, process.platform === 'win32' ? 'moss.cmd' : 'moss');
  const dmossBin = path.join(binDir, process.platform === 'win32' ? 'dmoss.cmd' : 'dmoss');
  const dmossAgentBin = path.join(binDir, process.platform === 'win32' ? 'dmoss-agent.cmd' : 'dmoss-agent');
  const binRunOptions = { shell: process.platform === 'win32' };

  log('checking moss/dmoss/dmoss-agent command aliases');
  const mossVersion = run(mossBin, ['--version'], binRunOptions).stdout;
  const dmossVersion = run(dmossBin, ['--version'], binRunOptions).stdout;
  const dmossAgentVersion = run(dmossAgentBin, ['--version'], binRunOptions).stdout;
  assertMatch(mossVersion, /moss v\d+\.\d+\.\d+/, 'moss --version');
  assertMatch(dmossVersion, /moss v\d+\.\d+\.\d+/, 'dmoss --version');
  assertMatch(dmossAgentVersion, /moss v\d+\.\d+\.\d+/, 'dmoss-agent --version');

  const help = run(mossBin, ['--help'], binRunOptions).stdout;
  assertMatch(help, /Most useful/, 'moss --help');
  assertMatch(help, /Inside Moss/, 'moss --help');
  assertMatch(help, /dmoss remains a compatible alias/, 'moss --help');
  assertMatch(help, /\/connect <ip>/, 'moss --help');

  const configHelp = run(mossBin, ['config', '--help'], binRunOptions).stdout;
  assertMatch(configHelp, /moss config init/, 'moss config --help');
  assertMatch(configHelp, /Moss reads \.moss\/config\.json/, 'moss config --help');

  log('checking installed zero-config source reporting');
  const installedZeroConfig = path.join(tempRoot, 'node_modules', '@rdk-moss', 'agent', 'zero-config-default.json');
  if (!fs.existsSync(installedZeroConfig)) {
    throw new Error('installed @rdk-moss/agent package is missing zero-config-default.json');
  }
  const configShow = run(mossBin, ['config', 'show', '--json'], {
    ...binRunOptions,
    env: cleanMossEnv(tempRoot),
  }).stdout;
  const parsedConfig = JSON.parse(configShow);
  if (!parsedConfig.apiKeyConfigured) throw new Error('installed zero-config default did not configure an API key');
  if (parsedConfig.providerSource !== 'built-in') throw new Error(`expected providerSource built-in, got ${parsedConfig.providerSource}`);
  if (parsedConfig.modelSource !== 'built-in') throw new Error(`expected modelSource built-in, got ${parsedConfig.modelSource}`);
  if (parsedConfig.baseUrlSource !== 'built-in') throw new Error(`expected baseUrlSource built-in, got ${parsedConfig.baseUrlSource}`);
  if (parsedConfig.apiKeySource !== 'built-in') throw new Error(`expected apiKeySource built-in, got ${parsedConfig.apiKeySource}`);
  if (Object.hasOwn(parsedConfig, 'apiKey')) throw new Error('config show --json must not print apiKey');

  log('checking interactive TUI startup through a PTY');
  runPtyStartup(mossBin, tempRoot);

  log('PASS');
} finally {
  for (const tarballPath of tarballPaths) fs.rmSync(tarballPath, { force: true });
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
