#!/usr/bin/env node
// D-Moss Agent CLI — see --help for usage, config, and environment variables.

import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createCliToolApprovalHook, resolveCliSafetyMode } from './cli/approval.js';
import { loadConfigFile, loadEnvFromAncestors, resolveCliConfig, resolveConfigDir } from './cli/config.js';
import { parseCliArgs } from './cli/args.js';
import { renderCliDoctor } from './cli/doctor.js';
import { displayHelp, displayVersion } from './cli/help.js';
import { createCliProvider } from './cli/providers.js';
import { createMemoryTools } from './cli/tools.js';
import { runOneShot } from './cli/oneshot.js';
import { runInteractive } from './cli/repl.js';
import { resolveCliSession } from './cli/session.js';
import { runCliUpdate } from './cli/update.js';
import { getPackageVersion } from './cli/package-info.js';
import {
  offerSetupForInteractiveMissingConfig,
  printMissingConfigGuidance,
  renderAuthStatus,
  runAuthLogout,
  runConfigSet,
  runSetupWizard,
} from './cli/setup.js';
import { DmossAgent, JsonlSessionStore, MemoryManager } from './core/index.js';
import { configureRootLogger, type LogLevel } from './logger.js';
import pc from 'picocolors';
import { registerBuiltinTools } from './tools/builtin.js';
import { SkillLearner } from './core/memory/skill-learner.js';
import { SkillPipeline } from '@rdk-moss/skills';
import { WorkspaceMemory } from './core/memory/workspace-memory.js';
import { createDockerExecTool } from './tools/docker-exec.js';
import { createDeviceSshTools, getDeviceConfigFromEnv } from './tools/device-ssh.js';
import { createDeviceDiagnosticsTools } from './tools/device-diagnostics.js';
import { createRos2Tools } from './tools/device-ros2.js';
import { AgentMesh, createMeshTools, isMeshVerboseEnabled } from './mesh/agent-mesh.js';
import { MeshEventBus } from './mesh/index.js';
import { LanDiscovery } from './mesh/lan-discovery.js';
import { setTracer } from './observability/tracing.js';
import { redactSensitiveData } from './observability/redact.js';
import { resolveCliDetailMode } from './cli/output.js';
import type { DeviceSshConfig } from './tools/device-ssh.js';

const parsedArgs = parseCliArgs(process.argv.slice(2));

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message;
  const warningType = typeof args[0] === 'string' ? args[0] : warning instanceof Error ? warning.name : '';
  if (
    warningType === 'ExperimentalWarning' &&
    message.includes('SOCKS5 proxy support is experimental')
  ) {
    return;
  }
  return originalEmitWarning(warning as never, ...(args as never[]));
}) as typeof process.emitWarning;

const colorEnabled = (() => {
  if (process.argv.includes('--no-color')) return false;
  if (process.env.NO_COLOR || process.env.DMOSS_NO_COLOR === '1') return false;
  if (!process.stderr.isTTY && !process.stdout.isTTY) return false;
  return true;
})();

export const c = {
  bold: (s: string) => (colorEnabled ? pc.bold(s) : s),
  dim: (s: string) => (colorEnabled ? pc.dim(s) : s),
  red: (s: string) => (colorEnabled ? pc.red(s) : s),
  green: (s: string) => (colorEnabled ? pc.green(s) : s),
  yellow: (s: string) => (colorEnabled ? pc.yellow(s) : s),
  blue: (s: string) => (colorEnabled ? pc.blue(s) : s),
  cyan: (s: string) => (colorEnabled ? pc.cyan(s) : s),
  magenta: (s: string) => (colorEnabled ? pc.magenta(s) : s),
  gray: (s: string) => (colorEnabled ? pc.gray(s) : s),
};

const argv = parsedArgs.rawArgv;
if (parsedArgs.detailMode) process.env.DMOSS_CLI_DETAIL = parsedArgs.detailMode;

function resolveCliLogLevel(): LogLevel {
  if (argv.includes('--debug')) return 'debug';
  if (argv.includes('--quiet')) return 'warn';
  const explicit = argv.find((a) => a.startsWith('--log-level='));
  if (explicit) {
    const v = explicit.slice('--log-level='.length).toLowerCase() as LogLevel;
    if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
  }
  const env = (process.env.DMOSS_LOG_LEVEL ?? '').toLowerCase() as LogLevel;
  if (env === 'debug' || env === 'info' || env === 'warn' || env === 'error') return env;
  return 'info';
}

configureRootLogger({
  scope: 'dmoss-agent',
  level: resolveCliLogLevel(),
  json: argv.includes('--json') || process.env.DMOSS_LOG_JSON === '1',
});

if (process.env.DMOSS_TRACE === 'console' || process.env.DMOSS_TRACE === '1' || process.env.DMOSS_TRACE === 'true') {
  setTracer('console');
}

if (parsedArgs.help) displayHelp(c);
if (parsedArgs.version) displayVersion(c);

async function setupMesh(agent: DmossAgent, deviceConfig: DeviceSshConfig | null) {
  const meshPort = parseInt(process.env.DMOSS_MESH_PORT || '9090', 10);
  const meshId = process.env.DMOSS_MESH_ID || `dmoss-${Date.now()}`;
  const meshName = process.env.DMOSS_MESH_NAME || `D-Moss @ ${os.hostname()}`;
  const meshListenHost = process.env.DMOSS_MESH_LISTEN_HOST || undefined;
  const meshSharedSecret = process.env.DMOSS_MESH_SHARED_SECRET || process.env.DMOSS_MESH_SECRET || undefined;
  const meshPeers = (process.env.DMOSS_MESH_PEERS || '').split(',').filter(Boolean).map((p) => {
    const [host, port] = p.split(':');
    return { host, port: parseInt(port || '9090', 10) };
  });
  const allowIncoming = process.env.DMOSS_MESH_ALLOW_INCOMING !== 'false';
  const mesh = new AgentMesh({
    id: meshId, name: meshName, port: meshPort, listenHost: meshListenHost,
    sharedSecret: meshSharedSecret, peers: meshPeers,
    capabilities: deviceConfig ? ['device-control', 'ros2'] : ['general'],
    deviceInfo: deviceConfig ? `${deviceConfig.host}` : undefined, allowIncoming,
  });
  const meshEvents = new MeshEventBus();
  mesh.setEventBus(meshEvents);
  meshEvents.on((event) => {
    if (!isMeshVerboseEnabled()) return;
    console.error(`[mesh:event] ${event.type} ${JSON.stringify(redactSensitiveData(event))}`);
  });
  mesh.onQuery(async (query) => {
    const result = await agent.chat(`mesh-${Date.now()}`, query);
    return result.response || '(no response)';
  });
  await mesh.start();
  await mesh.announce();
  if (isMeshVerboseEnabled()) {
    console.error(`[mesh] Agent mesh started on port ${meshPort} (id: ${meshId})`);
    console.error(`[mesh] Listen host: ${meshListenHost || '127.0.0.1'}`);
    console.error(`[mesh] Shared secret: ${meshSharedSecret ? 'configured' : 'not configured'}`);
    console.error(`[mesh] Incoming queries: ${allowIncoming ? 'ALLOWED' : 'BLOCKED'} (set DMOSS_MESH_ALLOW_INCOMING=false to block)`);
    if (meshPeers.length) console.error(`[mesh] Known peers: ${meshPeers.map((p) => `${p.host}:${p.port}`).join(', ')}`);
  }
  for (const tool of createMeshTools(mesh)) agent.tools.register(tool);
  try {
    const discovery = new LanDiscovery({ mesh, meshPort, agentId: meshId, agentName: meshName, sharedSecret: meshSharedSecret });
    discovery.onNewPeer((peer) => {
      if (isMeshVerboseEnabled()) {
        console.error(`\n[mesh] 🔗 New peer discovered: ${peer.name} (${peer.host}:${peer.port})`);
        if (peer.deviceInfo) console.error(`[mesh]    Device: ${peer.deviceInfo}`);
      }
    });
    await discovery.start();
    if (isMeshVerboseEnabled()) console.error(`[mesh] LAN auto-discovery active (UDP broadcast on port 9091)`);
  } catch (err) {
    console.error(`[mesh] LAN discovery unavailable: ${err instanceof Error ? err.message : err}`);
  }
}

async function main() {
  if (process.platform === 'win32') {
    try { execSync('chcp 65001', { stdio: 'ignore' }); } catch { /* best-effort UTF-8 */ }
  }

  if (parsedArgs.command === 'setup' || argv.includes('--setup')) {
    await runSetupWizard();
    return;
  }
  if (parsedArgs.command === 'auth' && parsedArgs.commandArgs[0] === 'status') {
    console.error(renderAuthStatus());
    return;
  }
  if (parsedArgs.command === 'auth' && parsedArgs.commandArgs[0] === 'logout') {
    await runAuthLogout();
    return;
  }
  if (parsedArgs.command === 'config' && parsedArgs.commandArgs[0] === 'set') {
    runConfigSet(parsedArgs.commandArgs.slice(1));
    return;
  }

  if (parsedArgs.configOverrides.workspace) {
    loadEnvFromAncestors(parsedArgs.configOverrides.workspace);
  }
  const resolvedConfig = resolveCliConfig(process.env, loadConfigFile(), parsedArgs.configOverrides);
  const safetyMode = parsedArgs.safetyModeOverride ?? resolvedConfig.safetyMode ?? resolveCliSafetyMode(argv);
  const workspace = resolvedConfig.workspace;
  const model = resolvedConfig.model;
  const baseUrl = resolvedConfig.baseUrl;
  const runtimeDir = path.join(workspace, '.dmoss-runtime');

  if (parsedArgs.command === 'doctor') {
    console.error(await renderCliDoctor({
      config: resolvedConfig,
      configDir: resolveConfigDir(),
      runtimeDir,
      currentVersion: getPackageVersion(),
      safetyMode,
      detailMode: resolveCliDetailMode(argv),
    }));
    return;
  }
  if (parsedArgs.command === 'update') {
    const code = await runCliUpdate({
      configDir: resolveConfigDir(),
      currentVersion: getPackageVersion(),
    });
    process.exit(code);
  }

  const oneShotMessage = parsedArgs.prompt;
  if (!resolvedConfig.apiKey) {
    if (process.stdin.isTTY && !oneShotMessage) {
      await offerSetupForInteractiveMissingConfig();
      return;
    }
    printMissingConfigGuidance(false);
    process.exit(1);
  }

  const sessionStore = new JsonlSessionStore({ dir: path.join(runtimeDir, 'sessions') });
  const session = await resolveCliSession({
    command: parsedArgs.command === 'resume' || parsedArgs.command === 'fork' ? parsedArgs.command : 'chat',
    store: sessionStore,
    sessionKey: parsedArgs.sessionKey,
    useLast: parsedArgs.sessionLast,
    forkSource: parsedArgs.forkSource,
  });
  if (session.notice) console.error(`[session] ${session.notice}`);
  const memoryManager = new MemoryManager(path.join(runtimeDir, 'memory'));
  const skillLearner = new SkillLearner({ skillsDir: path.join(workspace, 'skills') });
  const skillPipeline = new SkillPipeline({ workspaceDir: workspace, model });
  const workspaceMemory = new WorkspaceMemory({ workspaceDir: workspace });
  const wsContext = await workspaceMemory.loadContext();
  const wsPromptLayer = workspaceMemory.buildPromptLayer(wsContext);
  const extraPromptLayers: string[] = [];
  if (wsPromptLayer) extraPromptLayers.push(wsPromptLayer);

  const agent = new DmossAgent({
    llmProvider: createCliProvider(resolvedConfig), sessionStore, model,
    enableToolOutputTruncation: true, extraPromptLayers, skillPipeline,
    promptCache: {
      enabled: resolvedConfig.promptCacheEnabled,
      debug: resolvedConfig.promptCacheDebug,
    },
    hooks: {
      enrichToolContext: (ctx) => ({ ...ctx, workspaceDir: workspace }),
      onBeforeToolExec: createCliToolApprovalHook(safetyMode, process.env, {
        approvalPolicy: resolvedConfig.approvalPolicy,
      }),
    },
  });
  registerBuiltinTools(agent);

  if ((process.env.DMOSS_EXEC_BACKEND || 'local') === 'docker') {
    agent.tools.register(createDockerExecTool({ workspaceDir: workspace, image: process.env.DMOSS_DOCKER_IMAGE }));
  }
  for (const tool of createMemoryTools(memoryManager)) agent.tools.register(tool);

  const deviceConfig = getDeviceConfigFromEnv();
  if (process.env.DMOSS_MESH_ENABLED === 'true' || parsedArgs.mesh) {
    await setupMesh(agent, deviceConfig);
  }

  if (deviceConfig) {
    console.error(`[device] Connected to ${deviceConfig.host} (${deviceConfig.user || 'root'}@${deviceConfig.host}:${deviceConfig.port || 22})`);
    for (const tool of createDeviceSshTools(deviceConfig)) agent.tools.register(tool);
    for (const tool of createDeviceDiagnosticsTools(deviceConfig)) agent.tools.register(tool);
    for (const tool of createRos2Tools(deviceConfig)) agent.tools.register(tool);
  }

  if (oneShotMessage) { await runOneShot(agent, oneShotMessage, skillLearner, { sessionKey: session.sessionKey }); return; }

  if (!process.stdin.isTTY) {
    let piped = '';
    for await (const chunk of process.stdin) piped += chunk;
    if (piped.trim()) await runOneShot(agent, piped.trim(), skillLearner, { sessionKey: session.sessionKey });
    return;
  }
  await runInteractive(agent, skillLearner, {
    workspace,
    runtimeDir,
    configDir: resolveConfigDir(),
    baseUrl,
    execBackend: process.env.DMOSS_EXEC_BACKEND || 'local',
    safetyMode,
    dockerImage: process.env.DMOSS_DOCKER_IMAGE,
    meshEnabled: process.env.DMOSS_MESH_ENABLED === 'true' || parsedArgs.mesh,
    sessionKey: session.sessionKey,
    config: resolvedConfig,
    device: deviceConfig
      ? { host: deviceConfig.host, user: deviceConfig.user, port: deviceConfig.port }
      : null,
  }, { sessionKey: session.sessionKey });
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
