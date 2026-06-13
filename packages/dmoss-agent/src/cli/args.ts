import path from 'node:path';
import { normalizeApprovalPolicyConfig, normalizeConfigProfile, normalizeSafetyModeConfig, parseConfigBoolean, parseTrustedTools, safeProcessCwd, type CliConfigOverrides } from './config.js';
import type { CliSafetyMode } from './approval.js';

export type CliCommand = 'chat' | 'setup' | 'auth' | 'config' | 'doctor' | 'update' | 'resume' | 'fork' | 'mcp';
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
  /** `--continue`: auto-resume the most recent session on the default chat command. */
  continueLast: boolean;
  forkSource?: string;
  detailMode?: 'quiet' | 'progress' | 'verbose';
  mesh: boolean;
  help: boolean;
  helpAll: boolean;
  version: boolean;
  print: boolean;
  outputFormat: 'text' | 'json' | 'stream-json';
  maxTurns?: number;
  /**
   * Set when a bare single-token invocation looks like a mistyped subcommand
   * (e.g. `moss confgi`). The caller must surface "unknown command, did you
   * mean …?" and exit non-zero instead of starting a billable chat one-shot.
   */
  unknownCommand?: { token: string; suggestion: string };
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
  if (raw === 'profile') return 'profile';
  if (raw === 'model') return 'model';
  if (raw === 'provider') return 'provider';
  if (raw === 'baseurl') return 'baseUrl';
  if (raw === 'workspace' || raw === 'cwd' || raw === 'cd') return 'workspace';
  if (raw === 'safetymode' || raw === 'safety') return 'safetyMode';
  if (raw === 'approvalpolicy' || raw === 'approval') return 'approvalPolicy';
  if (raw === 'trustedtools' || raw === 'trusttools') return 'trustedTools';
  if (raw === 'deniedtools' || raw === 'denytools') return 'deniedTools';
  if (raw === 'promptcache' || raw === 'promptcacheenabled') return 'promptCacheEnabled';
  if (raw === 'promptcachedebug' || raw === 'promptprefixdebug') return 'promptCacheDebug';
  if (raw === 'imageinput' || raw === 'vision' || raw === 'visioninput') return 'imageInput';
  if (raw === 'maxagentturns' || raw === 'maxturns') return 'maxAgentTurns';
  if (raw === 'contexttokens' || raw === 'contextwindow') return 'contextTokens';
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
  if (key === 'profile') {
    const normalized = normalizeConfigProfile(value);
    if (!normalized) throw new Error(`Unsupported profile "${value}"`);
    target.profile = normalized;
    return;
  }
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
  if (key === 'deniedTools') {
    target.deniedTools = parseTrustedTools(value) ?? [];
    return;
  }
  if (key === 'promptCacheDebug') {
    const parsed = parseConfigBoolean(value);
    if (parsed === null) throw new Error(`Unsupported promptCacheDebug value "${value}"`);
    target.promptCacheDebug = parsed;
    return;
  }
  if (key === 'imageInput') {
    const parsed = parseConfigBoolean(value);
    if (parsed === null) throw new Error(`Unsupported imageInput value "${value}"`);
    target.imageInput = parsed;
    return;
  }
  if (key === 'maxAgentTurns' || key === 'contextTokens') {
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Unsupported ${key} value "${value}"`);
    target[key] = parsed;
    return;
  }
  if (key === 'model' || key === 'provider' || key === 'baseUrl' || key === 'workspace') {
    target[key] = value;
  }
}

function normalizeSafetyMode(value: string): CliSafetyMode | null {
  return normalizeSafetyModeConfig(value);
}

function resolveWorkspaceArg(value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(safeProcessCwd(), value);
}

function normalizeDetail(value: string): ParsedCliArgs['detailMode'] {
  const raw = value.toLowerCase().trim();
  if (raw === 'quiet' || raw === 'progress' || raw === 'verbose') return raw;
  throw new Error(`Unsupported detail mode "${value}"`);
}

const KNOWN_COMMANDS: readonly CliCommand[] = [
  'setup',
  'auth',
  'config',
  'doctor',
  'update',
  'resume',
  'fork',
  'mcp',
];

function asCommand(value: string | undefined): CliCommand | null {
  return value && (KNOWN_COMMANDS as readonly string[]).includes(value) ? (value as CliCommand) : null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Closest known subcommand within edit distance 2, or null. Used to turn a
 * mistyped `moss confgi` into a "did you mean 'config'?" error instead of a
 * silent billable chat one-shot. Deliberately conservative: an exact command
 * match is handled earlier, and legitimate one-word prompts (`moss hi`) sit far
 * outside distance 2 from every command so they keep flowing to chat.
 * @public
 */
export function closestKnownCommand(token: string): string | null {
  const candidate = token.toLowerCase().trim();
  if (!candidate || (KNOWN_COMMANDS as readonly string[]).includes(candidate)) return null;
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const command of KNOWN_COMMANDS) {
    const distance = levenshtein(candidate, command);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = command;
    }
  }
  return bestDistance <= 2 ? best : null;
}

function flagConsumesNext(arg: string): boolean {
  return arg === '-m' ||
    arg === '--model' ||
    arg === '-C' ||
    arg === '--cd' ||
    arg === '-c' ||
    arg === '--config' ||
    arg === '--config-file' ||
    arg === '--provider' ||
    arg === '--base-url' ||
    arg === '--ask-for-approval' ||
    arg === '--session' ||
    arg === '--fork-from' ||
    arg === '--detail' ||
    arg === '--output-format' ||
    arg === '--max-turns' ||
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
  let continueLast = false;
  let forkSource: string | undefined;
  let detailMode: ParsedCliArgs['detailMode'];
  let mesh = false;
  let help = false;
  let helpAll = false;
  let version = false;
  let print = false;
  let outputFormat: ParsedCliArgs['outputFormat'] = 'text';
  let maxTurns: number | undefined;
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
    if (arg === '--all') {
      helpAll = true;
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
    if (arg === '-p' || arg === '--print') {
      print = true;
      continue;
    }
    if (arg === '--output-format' || arg.startsWith('--output-format=')) {
      const parsed = readValue(argv, i, arg);
      const fmt = parsed.value.trim();
      if (fmt !== 'text' && fmt !== 'json' && fmt !== 'stream-json') {
        throw new Error(`--output-format must be text|json|stream-json, got "${fmt}"`);
      }
      outputFormat = fmt;
      print = true;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--max-turns' || arg.startsWith('--max-turns=')) {
      const parsed = readValue(argv, i, arg);
      const n = Number(parsed.value.trim());
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--max-turns must be a positive integer, got "${parsed.value}"`);
      }
      maxTurns = n;
      configOverrides.maxAgentTurns = n;
      i = parsed.nextIndex;
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
      configOverrides.workspace = resolveWorkspaceArg(parsed.value);
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '-c' || arg === '--config' || arg.startsWith('--config=')) {
      const parsed = readValue(argv, i, arg);
      applyConfigOverride(configOverrides, parsed.value);
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--config-file' || arg.startsWith('--config-file=')) {
      const parsed = readValue(argv, i, arg);
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
      const approval = normalizeApprovalPolicyConfig(raw);
      const safety = normalizeSafetyMode(raw);
      if (!approval && !safety) {
        // Silently dropping unknown values let `--ask-for-approval yolo` look
        // accepted while changing nothing; reject so the user sees the typo.
        throw new Error(
          `--ask-for-approval must be never|prompt|on-request|read-only|workspace-write|full-access, got "${parsed.value}"`,
        );
      }
      if (approval === 'never') {
        approvalPolicy = 'never';
        configOverrides.approvalPolicy = 'never';
      }
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
    if (arg === '--continue') {
      // Auto-resume the most recent session for the cwd on a bare `moss` (parity
      // with Claude Code's `claude --continue`). `-c` is already `--config`.
      continueLast = true;
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

  // Catch a mistyped subcommand BEFORE it becomes a billable chat one-shot.
  // Only a bare single-token invocation (`moss confgi`) with no flags qualifies;
  // multi-word prose prompts and flag-bearing invocations are never intercepted.
  let unknownCommand: ParsedCliArgs['unknownCommand'];
  if (
    command === 'chat' &&
    commandArgs.length === 0 &&
    promptParts.length === 1 &&
    !argv.includes('--') &&
    !argv.some((token) => token.startsWith('-'))
  ) {
    const suggestion = closestKnownCommand(promptParts[0]);
    if (suggestion) unknownCommand = { token: promptParts[0], suggestion };
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
    continueLast,
    forkSource,
    detailMode,
    mesh,
    help,
    helpAll,
    version,
    print,
    outputFormat,
    maxTurns,
    unknownCommand,
    rawArgv: argv,
  };
}
