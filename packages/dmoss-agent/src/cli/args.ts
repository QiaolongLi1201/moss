import path from 'node:path';
import { normalizeApprovalPolicyConfig, normalizeSafetyModeConfig, parseConfigBoolean, parseTrustedTools, type CliConfigOverrides } from './config.js';
import type { CliSafetyMode } from './approval.js';

export type CliCommand = 'chat' | 'setup' | 'auth' | 'config' | 'doctor' | 'update' | 'resume' | 'fork';
export type ApprovalPolicy = 'prompt' | 'never';

export interface ParsedCliArgs {
  command: CliCommand;
  commandArgs: string[];
  prompt: string;
  configOverrides: CliConfigOverrides;
  safetyModeOverride?: CliSafetyMode;
  approvalPolicy: ApprovalPolicy;
  sessionKey?: string;
  sessionLast: boolean;
  forkSource?: string;
  detailMode?: 'quiet' | 'progress' | 'verbose';
  mesh: boolean;
  help: boolean;
  version: boolean;
  rawArgv: string[];
}

function readValue(argv: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const current = argv[index];
  const eqIdx = current.indexOf('=');
  if (eqIdx !== -1) return { value: current.slice(eqIdx + 1), nextIndex: index };
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`${flag} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

function normalizeConfigKey(key: string): keyof CliConfigOverrides | null {
  const raw = key.trim().replace(/[-_]/g, '').toLowerCase();
  if (raw === 'model') return 'model';
  if (raw === 'provider') return 'provider';
  if (raw === 'baseurl') return 'baseUrl';
  if (raw === 'workspace' || raw === 'cwd' || raw === 'cd') return 'workspace';
  if (raw === 'safetymode' || raw === 'safety') return 'safetyMode';
  if (raw === 'approvalpolicy' || raw === 'approval') return 'approvalPolicy';
  if (raw === 'trustedtools' || raw === 'trusttools') return 'trustedTools';
  if (raw === 'promptcache' || raw === 'promptcacheenabled') return 'promptCacheEnabled';
  if (raw === 'promptcachedebug' || raw === 'promptprefixdebug') return 'promptCacheDebug';
  return null;
}

function applyConfigOverride(target: CliConfigOverrides, pair: string): void {
  const eqIdx = pair.indexOf('=');
  if (eqIdx === -1) {
    throw new Error(`--config expects key=value, got "${pair}"`);
  }
  const key = normalizeConfigKey(pair.slice(0, eqIdx));
  if (!key) {
    throw new Error(`Unsupported --config key "${pair.slice(0, eqIdx)}"`);
  }
  const value = pair.slice(eqIdx + 1);
  if (key === 'safetyMode') {
    const normalized = normalizeSafetyModeConfig(value);
    if (!normalized) throw new Error(`Unsupported safetyMode "${value}"`);
    target.safetyMode = normalized;
    return;
  }
  if (key === 'approvalPolicy') {
    const normalized = normalizeApprovalPolicyConfig(value);
    if (!normalized) throw new Error(`Unsupported approvalPolicy "${value}"`);
    target.approvalPolicy = normalized;
    return;
  }
  if (key === 'promptCacheEnabled') {
    const parsed = parseConfigBoolean(value);
    if (parsed === null) throw new Error(`Unsupported promptCache value "${value}"`);
    target.promptCacheEnabled = parsed;
    return;
  }
  if (key === 'trustedTools') {
    target.trustedTools = parseTrustedTools(value) ?? [];
    return;
  }
  if (key === 'promptCacheDebug') {
    const parsed = parseConfigBoolean(value);
    if (parsed === null) throw new Error(`Unsupported promptCacheDebug value "${value}"`);
    target.promptCacheDebug = parsed;
    return;
  }
  if (key === 'model' || key === 'provider' || key === 'baseUrl' || key === 'workspace') {
    target[key] = value;
  }
}

function normalizeSafetyMode(value: string): CliSafetyMode | null {
  return normalizeSafetyModeConfig(value);
}

function normalizeDetail(value: string): ParsedCliArgs['detailMode'] {
  const raw = value.toLowerCase().trim();
  if (raw === 'quiet' || raw === 'progress' || raw === 'verbose') return raw;
  throw new Error(`Unsupported detail mode "${value}"`);
}

function asCommand(value: string | undefined): CliCommand | null {
  if (
    value === 'setup' ||
    value === 'auth' ||
    value === 'config' ||
    value === 'doctor' ||
    value === 'update' ||
    value === 'resume' ||
    value === 'fork'
  ) {
    return value;
  }
  return null;
}

function flagConsumesNext(arg: string): boolean {
  return arg === '-m' ||
    arg === '--model' ||
    arg === '-C' ||
    arg === '--cd' ||
    arg === '-c' ||
    arg === '--config' ||
    arg === '--provider' ||
    arg === '--base-url' ||
    arg === '--ask-for-approval' ||
    arg === '--session' ||
    arg === '--fork-from' ||
    arg === '--detail' ||
    arg === '--log-level';
}

function findCommand(argv: string[]): { command: CliCommand; index: number } {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    const command = asCommand(arg);
    if (command) return { command, index: i };
    if (flagConsumesNext(arg)) i++;
  }
  return { command: 'chat', index: -1 };
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const foundCommand = findCommand(argv);
  const command = foundCommand.command;
  const commandArgs: string[] = [];
  const promptParts: string[] = [];
  const configOverrides: CliConfigOverrides = {};
  let safetyModeOverride: CliSafetyMode | undefined;
  let approvalPolicy: ApprovalPolicy = 'prompt';
  let sessionKey: string | undefined;
  let sessionLast = false;
  let forkSource: string | undefined;
  let detailMode: ParsedCliArgs['detailMode'];
  let mesh = false;
  let help = false;
  let version = false;
  let promptOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (i === foundCommand.index) continue;
    if (promptOnly) {
      promptParts.push(arg);
      continue;
    }
    if (arg === '--') {
      promptOnly = true;
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      version = true;
      continue;
    }
    if (arg === '--mesh') {
      mesh = true;
      continue;
    }
    if (arg === '--debug' || arg === '--json' || arg === '--no-color' || arg === '--setup') {
      continue;
    }
    if (arg === '--log-level' || arg.startsWith('--log-level=')) {
      const parsed = readValue(argv, i, arg);
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--read-only') {
      safetyModeOverride = 'read-only';
      continue;
    }
    if (arg === '--workspace-write') {
      safetyModeOverride = 'workspace-write';
      continue;
    }
    if (arg === '--full-access') {
      safetyModeOverride = 'full-access';
      continue;
    }
    if (arg === '--quiet') {
      detailMode = 'quiet';
      continue;
    }

    if (arg === '-m' || arg === '--model' || arg.startsWith('--model=')) {
      const parsed = readValue(argv, i, arg);
      configOverrides.model = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '-C' || arg === '--cd' || arg.startsWith('--cd=')) {
      const parsed = readValue(argv, i, arg);
      configOverrides.workspace = path.resolve(parsed.value);
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '-c' || arg === '--config' || arg.startsWith('--config=')) {
      const parsed = readValue(argv, i, arg);
      applyConfigOverride(configOverrides, parsed.value);
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--provider' || arg.startsWith('--provider=')) {
      const parsed = readValue(argv, i, arg);
      configOverrides.provider = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--base-url' || arg.startsWith('--base-url=')) {
      const parsed = readValue(argv, i, arg);
      configOverrides.baseUrl = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--ask-for-approval' || arg.startsWith('--ask-for-approval=')) {
      const parsed = readValue(argv, i, arg);
      const raw = parsed.value.toLowerCase().trim();
      if (raw === 'never') {
        approvalPolicy = 'never';
        configOverrides.approvalPolicy = 'never';
      }
      const safety = normalizeSafetyMode(raw);
      if (safety) safetyModeOverride = safety;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--session' || arg.startsWith('--session=')) {
      const parsed = readValue(argv, i, arg);
      sessionKey = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--last') {
      sessionLast = true;
      continue;
    }
    if (arg === '--fork-from' || arg.startsWith('--fork-from=')) {
      const parsed = readValue(argv, i, arg);
      forkSource = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--detail' || arg.startsWith('--detail=')) {
      const parsed = readValue(argv, i, arg);
      detailMode = normalizeDetail(parsed.value);
      i = parsed.nextIndex;
      continue;
    }

    if (arg.startsWith('-') && command !== 'chat') {
      commandArgs.push(arg);
      continue;
    }
    if (command === 'chat' || command === 'resume' || command === 'fork') {
      promptParts.push(arg);
    } else {
      commandArgs.push(arg);
    }
  }

  return {
    command,
    commandArgs,
    prompt: promptParts.join(' ').trim(),
    configOverrides,
    safetyModeOverride,
    approvalPolicy,
    sessionKey,
    sessionLast,
    forkSource,
    detailMode,
    mesh,
    help,
    version,
    rawArgv: argv,
  };
}
