/**
 * 统一错误分类系统（对标 Claude Code 的 actionable error 设计）。
 *
 * 裸用 `new Error('string')` 的问题：
 *   - 调用方无法按类型分支处理
 *   - 用户看到的消息经常是"Request failed"却不知道该怎么办
 *   - 日志聚合时无法聚合"同类错误"
 *
 * 这里定义：
 *   1. `ErrorCode` 枚举：全局稳定的错误码
 *   2. `DmossError`：携带 code + hint（actionable 建议） + recoverable + cause
 *   3. 轻量辅助函数：`throwDmoss()`、`wrapAsDmoss()`、`isDmossError()`
 *
 * 设计约束：
 *   - 零运行时依赖（不依赖 zod / 第三方）
 *   - `message` 保持用户可读；`hint` 是对开发者/用户的可执行建议
 *   - `code` 使用 `DOMAIN_REASON` 风格，稳定不重命名（新增 code 不 break 老 code）
 *   - `recoverable` 表示"业务层可否自行重试/降级"，用于 agent-loop 的决策
 */

export enum ErrorCode {
  /** 用户输入不合法（JSON Schema 验证失败、缺参数、格式错等） */
  USER_INPUT_INVALID = 'USER_INPUT_INVALID',
  /** LLM Provider 配置缺失（api key 空、baseUrl 无效） */
  PROVIDER_CONFIG_MISSING = 'PROVIDER_CONFIG_MISSING',
  /** LLM Provider 网络/超时/上游错误 */
  PROVIDER_UPSTREAM_ERROR = 'PROVIDER_UPSTREAM_ERROR',
  /** LLM 上下文溢出（context window 不够） */
  PROVIDER_CONTEXT_OVERFLOW = 'PROVIDER_CONTEXT_OVERFLOW',
  /** LLM 认证失败（401/403） */
  PROVIDER_AUTH_FAILED = 'PROVIDER_AUTH_FAILED',
  /** LLM 限频（429） */
  PROVIDER_RATE_LIMITED = 'PROVIDER_RATE_LIMITED',
  /** 工具执行失败（tool.execute 抛错） */
  TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED',
  /** 工具执行超时 */
  TOOL_EXECUTION_TIMEOUT = 'TOOL_EXECUTION_TIMEOUT',
  /** 工具未找到（LLM 造了不存在的工具名） */
  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',
  /** 工具不允许（授权拒绝） */
  TOOL_NOT_ALLOWED = 'TOOL_NOT_ALLOWED',
  /** Session 不存在或无法恢复 */
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  /** Session 写盘失败 */
  SESSION_PERSIST_FAILED = 'SESSION_PERSIST_FAILED',
  /** Skill 匹配或加载失败 */
  SKILL_LOAD_FAILED = 'SKILL_LOAD_FAILED',
  /** Mesh peer 连接失败 */
  MESH_PEER_UNREACHABLE = 'MESH_PEER_UNREACHABLE',
  /** Mesh peer 拒绝接受查询 */
  MESH_QUERY_REJECTED = 'MESH_QUERY_REJECTED',
  /** Device SSH 连接/认证失败 */
  DEVICE_SSH_FAILED = 'DEVICE_SSH_FAILED',
  /** 用户取消（AbortSignal 触发） */
  USER_ABORTED = 'USER_ABORTED',
  /** 配置文件读写失败 */
  CONFIG_IO_FAILED = 'CONFIG_IO_FAILED',
  /** 内部不变量被破坏（bug，应该 fix） */
  INTERNAL_INVARIANT_VIOLATED = 'INTERNAL_INVARIANT_VIOLATED',
  /** 未分类（迁移用，新代码应避免使用） */
  UNKNOWN = 'UNKNOWN',
}

export interface DmossErrorDetails {
  code: ErrorCode;
  /** 用户可读的简短描述 */
  message: string;
  /** 对开发者或终端用户的 actionable 建议（下一步怎么做） */
  hint?: string;
  /** 业务层可否自行重试/降级 */
  recoverable?: boolean;
  /** 原因（底层 Error 或任意 metadata） */
  cause?: unknown;
  /** 关联的上下文（runId / sessionId / toolName 等，便于日志聚合） */
  context?: Record<string, unknown>;
}

/**
 * 统一错误类。建议**只**通过 `throwDmoss()` / `wrapAsDmoss()` 创建，
 * 或继承派生类。直接 `throw new DmossError(...)` 也允许。
 */
export class DmossError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly recoverable: boolean;
  readonly context?: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(details: DmossErrorDetails) {
    super(details.message);
    this.name = 'DmossError';
    this.code = details.code;
    this.hint = details.hint;
    this.recoverable = details.recoverable ?? false;
    this.context = details.context;
    this.cause = details.cause;
  }

  /** 日志安全：结构化 JSON（logger 已经脱敏敏感字段） */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      hint: this.hint,
      recoverable: this.recoverable,
      context: this.context,
      stack: this.stack,
    };
  }
}

export function isDmossError(err: unknown): err is DmossError {
  return err instanceof DmossError || (
    typeof err === 'object'
    && err !== null
    && (err as { name?: string }).name === 'DmossError'
    && typeof (err as { code?: unknown }).code === 'string'
  );
}

export function throwDmoss(details: DmossErrorDetails): never {
  throw new DmossError(details);
}

/**
 * 将任意未分类错误包装成 DmossError，便于向上抛出时保持一致形态。
 * - 若原错误已是 DmossError，直接 return（不重包）
 * - 原错误 message 进入 `cause`，便于 logger 打印
 */
export function wrapAsDmoss(
  err: unknown,
  code: ErrorCode,
  opts: Partial<Omit<DmossErrorDetails, 'code' | 'message'>> & { message?: string } = {},
): DmossError {
  if (isDmossError(err)) return err;
  const origMessage = err instanceof Error ? err.message : String(err);
  return new DmossError({
    code,
    message: opts.message ?? origMessage ?? 'unknown error',
    hint: opts.hint,
    recoverable: opts.recoverable,
    context: opts.context,
    cause: err,
  });
}

/**
 * 把错误转为人读字符串（对 UI / CLI 输出友好）。
 * - DmossError：`[CODE] message — hint`
 * - 原生 Error：直接返回 message
 * - 其他：String(err)
 */
export function formatDmossError(err: unknown): string {
  if (isDmossError(err)) {
    const base = `[${err.code}] ${err.message}`;
    return err.hint ? `${base}\n→ ${err.hint}` : base;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 判断错误是否应触发 agent-loop 的自动重试（vs 直接失败返回给用户）。
 * 与 `DmossError.recoverable` + 若干默认 recoverable code 结合。
 */
export function isDmossErrorRecoverable(err: unknown): boolean {
  if (!isDmossError(err)) return false;
  if (err.recoverable === true) return true;
  return (
    err.code === ErrorCode.PROVIDER_RATE_LIMITED
    || err.code === ErrorCode.PROVIDER_UPSTREAM_ERROR
    || err.code === ErrorCode.TOOL_EXECUTION_TIMEOUT
  );
}
