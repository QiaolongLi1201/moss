import fs from 'node:fs';
import path from 'node:path';
import { checkForCliUpdate } from './update-check.js';
import { auditResolvedCliConfig, hasTrustedToolWildcard } from './config.js';
import type { ResolvedCliConfig } from './config.js';
import { loadMcpConfigWithDiagnostics } from '../mcp/index.js';

interface DoctorOptions {
  config: ResolvedCliConfig;
  configDir: string;
  runtimeDir: string;
  currentVersion: string;
  safetyMode: string;
  detailMode: string;
  npmLatest?: string;
  updateFetchImpl?: typeof fetch;
}

function ok(label: string, detail: string): string {
  return `  ok    ${label}: ${detail}`;
}

function warn(label: string, detail: string): string {
  return `  warn  ${label}: ${detail}`;
}

function fail(label: string, detail: string): string {
  return `  fail  ${label}: ${detail}`;
}

function canWriteDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function sourceLooksEnv(source: string): boolean {
  return source.startsWith('DMOSS_') ||
    source.endsWith('_API_KEY') ||
    source.endsWith('_BASE_URL') ||
    source === 'OPENAI_BASE_URL' ||
    source === 'ANTHROPIC_BASE_URL' ||
    source === 'DASHSCOPE_BASE_URL';
}

function renderMcpDoctor(config: ResolvedCliConfig): string {
  if (!config.mcpEnabled) {
    return ok('mcp', `disabled (${config.mcpEnabledSource}); config ${config.mcpConfigPath}`);
  }

  if (!fs.existsSync(config.mcpConfigPath)) {
    return fail('mcp', `enabled (${config.mcpEnabledSource}) but config is missing at ${config.mcpConfigPath}`);
  }

  const mcpLoadResult = loadMcpConfigWithDiagnostics(config.mcpConfigPath);
  const mcpConfig = mcpLoadResult.config;
  if (!mcpConfig) {
    const invalidServerNames = mcpLoadResult.diagnostics
      .map((diagnostic) => diagnostic.serverName)
      .filter((serverName): serverName is string => Boolean(serverName));
    if (invalidServerNames.length > 0) {
      const allNeedCommand = mcpLoadResult.diagnostics.every((diagnostic) =>
        diagnostic.message.toLowerCase().includes('command'),
      );
      const details = allNeedCommand
        ? 'each server needs a command'
        : mcpLoadResult.diagnostics
          .map((diagnostic) => diagnostic.serverName
            ? `${diagnostic.serverName}: ${diagnostic.message}`
            : diagnostic.message)
          .join('; ');
      return fail('mcp', `invalid server entries (${invalidServerNames.join(', ')}); ${details}`);
    }
    return fail('mcp', `enabled (${config.mcpEnabledSource}) but config is invalid at ${config.mcpConfigPath}`);
  }

  const serverNames = Object.keys(mcpConfig.mcpServers);
  if (serverNames.length === 0) {
    return warn('mcp', `enabled (${config.mcpEnabledSource}) but no servers are configured at ${config.mcpConfigPath}`);
  }

  const invalidServers = serverNames.filter((name) => {
    const server = mcpConfig.mcpServers[name];
    return !server || typeof server.command !== 'string' || server.command.trim() === '';
  });
  if (invalidServers.length > 0) {
    return fail('mcp', `invalid server entries (${invalidServers.join(', ')}); each server needs a command`);
  }

  return ok('mcp', `enabled (${config.mcpEnabledSource}); ${serverNames.length} server(s) from ${config.mcpConfigPath}`);
}

function renderApprovalDoctor(config: ResolvedCliConfig): string[] {
  const lines: string[] = [
    ok('approval', `${config.approvalPolicy} (${config.approvalPolicySource})`),
  ];

  const auditWarnings = auditResolvedCliConfig(config);
  for (const auditWarning of auditWarnings) {
    const label = auditWarning.code.startsWith('trustedTools.') ? 'trustedTools' : 'approval policy';
    lines.push(warn(label, auditWarning.message));
  }

  const hasBroadTrustedPattern = auditWarnings.some((entry) => entry.code === 'trustedTools.broad_patterns');
  if (config.trustedTools.length > 0 && hasTrustedToolWildcard(config) && !hasBroadTrustedPattern) {
    lines.push(ok('trustedTools', `${config.trustedTools.length} configured (${config.trustedToolsSource}); wildcard patterns are narrow`));
  } else {
    lines.push(ok('trustedTools', `${config.trustedTools.length ? config.trustedTools.join(', ') : 'none'} (${config.trustedToolsSource})`));
  }

  return lines;
}

function renderBaseUrlDoctor(config: ResolvedCliConfig): string {
  if (config.usingBundledDefault) {
    return ok('baseUrl', 'built-in default (hidden)');
  }
  return ok('baseUrl', `${config.baseUrl} (${config.baseUrlSource})`);
}

export async function renderCliDoctor(options: DoctorOptions): Promise<string> {
  const lines = ['[doctor] dmoss'];
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] || '0', 10);
  lines.push(nodeMajor >= 22 ? ok('node', process.version) : fail('node', `${process.version}; requires >=22.16.0`));
  lines.push(ok('version', options.currentVersion));
  lines.push(options.config.apiKey
    ? ok('auth', `configured via ${options.config.apiKeySource}`)
    : fail('auth', 'missing API key; run dmoss setup or set DEEPSEEK_API_KEY'));
  lines.push(ok('provider', `${options.config.provider} (${options.config.providerSource})`));
  lines.push(ok('model', `${options.config.model} (${options.config.modelSource})`));
  lines.push(renderBaseUrlDoctor(options.config));
  lines.push(canWriteDir(options.config.workspace)
    ? ok('workspace', `${options.config.workspace} (${options.config.workspaceSource})`)
    : fail('workspace', `${options.config.workspace} is not writable`));
  lines.push(canWriteDir(options.runtimeDir)
    ? ok('runtime', options.runtimeDir)
    : fail('runtime', `${options.runtimeDir} is not writable`));
  lines.push(ok('config', path.join(options.configDir, 'config.json')));
  lines.push(ok('safety', options.safetyMode));
  lines.push(...renderApprovalDoctor(options.config));
  lines.push(ok('detail', options.detailMode));
  lines.push(renderMcpDoctor(options.config));

  const envSources = [
    options.config.providerSource,
    options.config.apiKeySource,
    options.config.modelSource,
    options.config.baseUrlSource,
    options.config.workspaceSource,
    options.config.mcpEnabledSource,
    options.config.mcpConfigPathSource,
  ].filter(sourceLooksEnv);
  if (envSources.length > 0) {
    lines.push(warn('env overrides', [...new Set(envSources)].join(', ')));
  }

  const notice = await checkForCliUpdate({
    configDir: options.configDir,
    currentVersion: options.currentVersion,
    timeoutMs: 1500,
    fetchImpl: options.updateFetchImpl,
  });
  if (notice) {
    lines.push(warn('npm update', `${notice.currentVersion} -> ${notice.latestVersion}; run dmoss update`));
  } else if (options.npmLatest && options.npmLatest !== options.currentVersion) {
    lines.push(warn('npm registry', `latest is ${options.npmLatest}; installed source reports ${options.currentVersion}`));
  } else {
    lines.push(ok('npm update', 'no newer registry version detected'));
  }

  return lines.join('\n');
}
