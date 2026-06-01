import fs from 'node:fs';
import path from 'node:path';
import { checkForCliUpdate } from './update-check.js';
import type { ResolvedCliConfig } from './config.js';

interface DoctorOptions {
  config: ResolvedCliConfig;
  configDir: string;
  runtimeDir: string;
  currentVersion: string;
  safetyMode: string;
  detailMode: string;
  npmLatest?: string;
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

export async function renderCliDoctor(options: DoctorOptions): Promise<string> {
  const lines = ['[doctor] dmoss-agent'];
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] || '0', 10);
  lines.push(nodeMajor >= 22 ? ok('node', process.version) : fail('node', `${process.version}; requires >=22.16.0`));
  lines.push(ok('version', options.currentVersion));
  lines.push(options.config.apiKey
    ? ok('auth', `configured via ${options.config.apiKeySource}`)
    : fail('auth', 'missing API key; run dmoss-agent setup or set DMOSS_API_KEY'));
  lines.push(ok('provider', `${options.config.provider} (${options.config.providerSource})`));
  lines.push(ok('model', `${options.config.model} (${options.config.modelSource})`));
  lines.push(ok('baseUrl', `${options.config.baseUrl} (${options.config.baseUrlSource})`));
  lines.push(canWriteDir(options.config.workspace)
    ? ok('workspace', `${options.config.workspace} (${options.config.workspaceSource})`)
    : fail('workspace', `${options.config.workspace} is not writable`));
  lines.push(canWriteDir(options.runtimeDir)
    ? ok('runtime', options.runtimeDir)
    : fail('runtime', `${options.runtimeDir} is not writable`));
  lines.push(ok('config', path.join(options.configDir, 'config.json')));
  lines.push(ok('safety', options.safetyMode));
  lines.push(ok('detail', options.detailMode));

  const envSources = [
    options.config.providerSource,
    options.config.apiKeySource,
    options.config.modelSource,
    options.config.baseUrlSource,
    options.config.workspaceSource,
  ].filter(sourceLooksEnv);
  if (envSources.length > 0) {
    lines.push(warn('env overrides', [...new Set(envSources)].join(', ')));
  }

  const notice = await checkForCliUpdate({
    configDir: options.configDir,
    currentVersion: options.currentVersion,
    timeoutMs: 1500,
  });
  if (notice) {
    lines.push(warn('npm update', `${notice.currentVersion} -> ${notice.latestVersion}; run dmoss-agent update`));
  } else if (options.npmLatest && options.npmLatest !== options.currentVersion) {
    lines.push(warn('npm registry', `latest is ${options.npmLatest}; installed source reports ${options.currentVersion}`));
  } else {
    lines.push(ok('npm update', 'no newer registry version detected'));
  }

  return lines.join('\n');
}
