/**
 * 统一日志模块（对齐 docs/logging.md 规范）
 *
 * 目标：
 *   - 级别控制（error/warn/info/debug）
 *   - Scope 前缀规范（[server] / [dmoss] / [agent] / [provider:pi-ai] 等）
 *   - 上下文继承（child logger 叠加 scope 并继承 runId / sessionId 等字段）
 *   - 敏感字段默认脱敏（apiKey / token / sessionId / password）
 *   - JSON 模式可选，便于 `jq` / 日志聚合
 *   - 默认 Node stdout/stderr；提供 sink 钩子供宿主替换（Electron 主进程写日志文件等）
 *
 * 该模块不依赖 Node 专有 API（globalThis.process 为可选），可在 Electron renderer / browser 里运行。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface Logger {
  /**
   * 创建子 logger：
   * - `scope` 追加到父 scope（如 `agent:tool`）
   * - 合并 context（子的覆盖父的同名字段）
   * - 继承 level / json / sink 配置
   */
  child(scope: string, context?: Record<string, unknown>): Logger;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  /** 允许宿主运行时调整级别（例如 CLI 收到 --debug） */
  setLevel(level: LogLevel): void;
  /** 当前级别 */
  getLevel(): LogLevel;
  /** scope 链（用于调试） */
  readonly scope: string;
}

export interface LoggerOptions {
  scope?: string;
  level?: LogLevel;
  /** JSON 输出（默认 false；CI/日志聚合时设 true） */
  json?: boolean;
  /** 额外上下文字段，每条日志都会注入（runId / sessionId / deviceId 等） */
  context?: Record<string, unknown>;
  /** 自定义 sink，默认打到 stdout/stderr。宿主可重定向到文件/IPC */
  sink?: (entry: LogEntry) => void;
  /** 脱敏字段名（大小写不敏感），默认见 DEFAULT_SENSITIVE_KEYS */
  sensitiveKeys?: readonly string[];
}

const DEFAULT_SENSITIVE_KEYS = [
  'apikey',
  'api_key',
  'token',
  'bearer',
  'authorization',
  'password',
  'secret',
  'sessionid',
  'session_id',
  'cookie',
  'refresh_token',
] as const;

function envLevel(): LogLevel | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  const env =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const raw = String(env.DMOSS_LOG_LEVEL ?? '').trim().toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return undefined;
}

function envJson(): boolean {
  if (typeof globalThis === 'undefined') return false;
  const env =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const raw = String(env.DMOSS_LOG_JSON ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 脱敏单条数据：返回新对象，原对象不动。
 * 规则：
 *   - 字段名（不区分大小写）在 sensitiveKeys 中 → 值遮蔽
 *   - 字段值为对象 → 递归（深度 ≤ 4，避免循环）
 */
export function redactSensitive(
  data: Record<string, unknown> | undefined,
  sensitiveKeys: readonly string[] = DEFAULT_SENSITIVE_KEYS,
  depth = 0,
  seen?: WeakSet<object>,
): Record<string, unknown> | string | undefined {
  if (!data || typeof data !== 'object') return data;
  if (depth > 4) return '[REDACTED:depth]';
  if (!seen) seen = new WeakSet<object>();
  if (seen.has(data)) return '[Circular]';
  seen.add(data);
  const lowerKeys = new Set(sensitiveKeys.map((k) => k.toLowerCase()));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const isSensitive = lowerKeys.has(k.toLowerCase());
    if (isSensitive) {
      out[k] = maskValue(v);
      continue;
    }
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) {
        out[k] = v.map((item) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            return redactSensitive(item as Record<string, unknown>, sensitiveKeys, depth + 1, seen);
          }
          return item;
        });
      } else {
        out[k] = redactSensitive(v as Record<string, unknown>, sensitiveKeys, depth + 1, seen);
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function maskValue(v: unknown): string {
  if (typeof v !== 'string' || !v) return '***';
  if (v.length <= 8) return '***';
  return `${v.slice(0, 2)}***${v.slice(-4)}`;
}

function formatConsole(entry: LogEntry): string {
  const scope = entry.scope ? `[${entry.scope}]` : '';
  const levelTag = entry.level === 'debug' ? ' [debug]' : '';
  let suffix = '';
  if (entry.data && Object.keys(entry.data).length > 0) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(entry.data)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        parts.push(`${k}=${v}`);
      } else {
        parts.push(`${k}=${safeStringify(v)}`);
      }
    }
    if (parts.length) suffix = ' · ' + parts.join(' · ');
  }
  return `${scope}${levelTag} ${entry.msg}${suffix}`;
}

function safeStringify(v: unknown, max = 400): string {
  try {
    const s = JSON.stringify(v);
    if (!s) return String(v);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(v);
  }
}

function defaultSink(entry: LogEntry, json: boolean): void {
  if (typeof globalThis === 'undefined') return;
  const c = (globalThis as { console?: Console }).console;
  if (!c) return;
  if (json) {
    const payload = JSON.stringify({
      ts: entry.ts,
      level: entry.level,
      scope: entry.scope,
      msg: entry.msg,
      ...(entry.data ?? {}),
    });
    if (entry.level === 'error') c.error(payload);
    else if (entry.level === 'warn') c.warn(payload);
    else c.log(payload);
    return;
  }
  const line = formatConsole(entry);
  if (entry.level === 'error') c.error(line);
  else if (entry.level === 'warn') c.warn(line);
  else if (entry.level === 'debug') c.log(line);
  else c.log(line);
}

/**
 * 创建根 logger 或子 logger。
 *
 * @example
 * ```ts
 * import { createLogger } from '@rdk-moss/agent';
 * const log = createLogger({ scope: 'server' });
 * log.info('启动完成', { port: 8787 });
 *
 * const runLog = log.child('dmoss', { runId: 'a7f9' });
 * runLog.debug('拉取 skills', { count: 42 });
 * // 输出：[server:dmoss] [debug] 拉取 skills · runId=a7f9 · count=42
 * ```
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const parentScope = opts.scope ?? '';
  let currentLevel: LogLevel = opts.level ?? envLevel() ?? 'info';
  const useJson = opts.json ?? envJson();
  const sink = opts.sink ?? ((entry: LogEntry) => defaultSink(entry, useJson));
  const sensitiveKeys = opts.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS;
  const baseContext = { ...(opts.context ?? {}) };

  function emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentLevel]) return;
    const merged: Record<string, unknown> | undefined =
      (data && Object.keys(data).length > 0) || Object.keys(baseContext).length > 0
        ? { ...baseContext, ...(data ?? {}) }
        : undefined;
    const safe = redactSensitive(merged, sensitiveKeys) as Record<string, unknown> | undefined;
    sink({
      ts: nowIso(),
      level,
      scope: parentScope,
      msg,
      data: safe,
    });
  }

  const logger: Logger = {
    scope: parentScope,
    getLevel: () => currentLevel,
    setLevel: (level) => {
      currentLevel = level;
    },
    debug: (msg, data) => emit('debug', msg, data),
    info: (msg, data) => emit('info', msg, data),
    warn: (msg, data) => emit('warn', msg, data),
    error: (msg, data) => emit('error', msg, data),
    child: (childScope, childContext) => {
      const nextScope = parentScope && childScope ? `${parentScope}:${childScope}` : childScope || parentScope;
      return createLogger({
        scope: nextScope,
        level: currentLevel,
        json: useJson,
        context: { ...baseContext, ...(childContext ?? {}) },
        sink,
        sensitiveKeys,
      });
    },
  };

  return logger;
}

/**
 * 全局共享的"根 logger"，便于未接入 DI 的调用方直接 `import { logger } from '@rdk-moss/agent/logger'` 使用。
 * 特别建议 library（@rdk-moss/agent）内部使用子 logger：`rootLogger.child('agent:tool')`；
 * 宿主只需在启动时调一次 `configureRootLogger({...})` 即可全局生效。
 */
let rootLogger: Logger | null = null;
let rootLoggerOptions: LoggerOptions = {};

export function configureRootLogger(opts: LoggerOptions = {}): void {
  rootLoggerOptions = opts;
  rootLogger = createLogger(opts);
}

export function getRootLogger(): Logger {
  if (!rootLogger) {
    rootLogger = createLogger(rootLoggerOptions);
  }
  return rootLogger;
}
