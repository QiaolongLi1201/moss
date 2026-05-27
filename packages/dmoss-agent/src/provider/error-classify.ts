/**
 * Provider 错误分类器（2026-04-24-provider-error-ux-surface MVP 子集）
 *
 * 职责：把 LLM provider 返回的 raw error（`errorMessage` / `status` / `code`）
 * 翻译成**用户友好**的短文案 + 结构化下一步建议，避免终端用户直接看到
 * `400 The reasoning_content ...` / `tool id(call_function_...) not found (2013)` 等 SDK
 * 原文（post-v1.1.3 窗口占 21.9% 的回复，`provider-error-surfacing.spec.md §背景`）。
 *
 * 本 MVP 版硬编码中文文案，不走 i18n（避免与并发 session 对 `src/i18n/*` 的 WIP 冲突；
 * i18n 化由 follow-up `provider-error-ux-surface-i18n` 接手）。英文 fallback 留给
 * 下一版接入时在 caller 侧注入。
 *
 * 不泄露：API Key / Bearer token / 代理 URL / tool call-id / `(2013)` 等 SDK 错误码。
 * Raw message 由 caller 单独写入 `error_detail` 列 + log（此分类器**只**负责分类 + 文案）。
 *
 * 相关 task:
 *  - 父 epic: `2026-04-24-provider-error-surfacing`（P0）
 *  - 本 MVP: `2026-04-24-provider-error-ux-surface`（子任务 A MVP 切片，本次会话）
 *  - follow-up 姊妹: `2026-04-24-provider-error-context-roundtrip`（子任务 B，未开始）
 */

import { sanitizeSecrets } from '../safety/secret-sanitizer.js';

export type ProviderErrorCategory =
  | 'auth'
  | 'context_corruption'
  | 'timeout'
  | 'rate_limit'
  | 'quota_exceeded'
  | 'aborted_by_user'
  | 'aborted_by_server'
  | 'network'
  /** 上游 404 / "model not found" / "model deprecated" —— 用户多见于 vendor 后台关停老模型 */
  | 'model_not_found'
  /** 上游 502/503 / "service unavailable" —— 临时性，建议稍后重试或换车道 */
  | 'service_unavailable'
  /** "context_length_exceeded" / "maximum context tokens" —— 用户多见于长会话或超大附件 */
  | 'context_length_exceeded'
  /** "tools not supported" / "function call not supported" —— 用户切到不支持工具的模型时常见 */
  | 'tools_not_supported'
  /** "stream not supported" / 流式不发字节 —— OpenAI 兼容网关偶发 */
  | 'streaming_not_supported'
  /** 200 OK 但 content 全空（思考类模型把全部输出放 reasoning，content 为空） */
  | 'empty_response'
  /** 板端/协作运行时生命周期错误，例如 agent harness 未注册或协议不匹配 */
  | 'runtime_lifecycle'
  | 'unknown'
  /**
   * `ambiguous`：输入意图不明（typically server-side `ambiguous_short_circuit` 命中），
   *  caller 通常用 `errorMessage: 'ambiguous_short_circuit:<reason>'` 触发。详见
   *  `2026-05-01-moss-reliability-fallback-ux` G-5a。
   */
  | 'ambiguous';

export interface ProviderErrorAction {
  /**
   * 稳定 id；前端按钮 / 后端事件的 key。
   *
   * - `retry` / `openSettings` / `switchModel` / `newSession` / `resetSession`：
   *   2026-04-24 `provider-error-ux-surface` MVP 引入。
   * - `useFallbackProvider`：2026-05-01 `moss-reliability-fallback-ux` G-3 引入；
   *   仅在用户配置了备用 provider 时由 caller 追加，不会自动切换，需要显式点击。
   * - `openBoardAgent`：打开宿主的板端协作运行时页面；core package 只声明动作语义，
   *   具体跳转目标由宿主 UI 决定。
   */
  id:
    | 'retry'
    | 'openSettings'
    | 'switchModel'
    | 'newSession'
    | 'resetSession'
    | 'useFallbackProvider'
    | 'openBoardAgent';
  /** 中文显式文案（MVP 阶段硬编码；i18n 化由前端 `aidock.providerError.action*` keys 接管） */
  label: string;
  /** 视觉级别建议（纯 markdown 渲染时忽略） */
  variant: 'primary' | 'secondary' | 'ghost';
}

export interface ProviderErrorSurface {
  category: ProviderErrorCategory;
  /** 用户可见的短文案（≤ 60 字；硬编码中文，MVP 阶段） */
  userMessage: string;
  /** 用户可选的下一步动作（0-3 个） */
  actions: ProviderErrorAction[];
  /** 是否完全静默（不写 assistant_message）—— 仅 `aborted_by_user` 为 true */
  silent: boolean;
  /**
   * 是否适合自动重试（caller 可调用 `runWithProviderRetry` 在 retryable=true 的 surface
   * 上做最多 1 次透明重试）。仅 `aborted_by_server` / `rate_limit` / `timeout` 为 true，
   * `auth` / `quota_exceeded` / `context_corruption` 重试无效保持 false。
   *
   * 2026-05-01 `moss-reliability-fallback-ux` G-2 引入。零字段 caller 不读时无影响。
   */
  retryable: boolean;
}

export interface ProviderErrorInput {
  errorMessage?: string;
  status?: number;
  code?: string;
  /** 若 AbortController 触发，caller 可以把 reason 传进来以区分 user-initiated vs server-initiated */
  abortReason?: 'user' | 'server' | 'timeout';
  /** Optional host context used to improve local-model error copy. */
  provider?: string;
  baseUrl?: string;
  /** D-Moss response lane; `quick` is often backed by a local shortcut model. */
  lane?: 'quick' | 'thinking';
}

/** 静默（不写 assistant message）的特殊 surface，用于 user-abort */
const SILENT_USER_ABORT: ProviderErrorSurface = {
  category: 'aborted_by_user',
  userMessage: '',
  actions: [],
  silent: true,
  retryable: false,
};

const ACTION_RETRY: ProviderErrorAction = { id: 'retry', label: '重试', variant: 'primary' };
const ACTION_OPEN_SETTINGS: ProviderErrorAction = {
  id: 'openSettings',
  label: '打开设置',
  variant: 'secondary',
};
const ACTION_OPEN_BOARD_AGENT: ProviderErrorAction = {
  id: 'openBoardAgent',
  label: '检查板端智能体',
  variant: 'primary',
};
const ACTION_SWITCH_MODEL: ProviderErrorAction = {
  id: 'switchModel',
  label: '换个模型',
  variant: 'ghost',
};
const ACTION_NEW_SESSION: ProviderErrorAction = {
  id: 'newSession',
  label: '开新对话',
  variant: 'ghost',
};

function matchAuth(msg: string, status?: number): boolean {
  if (status === 401) return true;
  const m = msg.toLowerCase();
  return /incorrect api key|invalid api key|unauthorized|api key/i.test(m);
}

function matchContextCorruption(msg: string): { hit: boolean; flavor: 'thinking' | 'tool' | null } {
  const m = msg.toLowerCase();
  if (m.includes('reasoning_content') && m.includes('thinking mode')) {
    return { hit: true, flavor: 'thinking' };
  }
  if (m.includes('tool result') && m.includes('not found')) {
    return { hit: true, flavor: 'tool' };
  }
  if (/\(2013\)/.test(m)) {
    return { hit: true, flavor: 'tool' };
  }
  return { hit: false, flavor: null };
}

function matchAbort(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('request was aborted') || m.includes('aborterror') || m === 'aborted';
}

/**
 * 额度耗尽（配额类 429 的子集）
 *
 * HTTP 429 本身有两种语义：
 *  - 限速（rate limit / too many requests）：短时间窗超限，重试有效
 *  - **额度耗尽**（quota / monthly / plan limit）：重试无效，必须换模型或等配额重置
 *
 * 命中关键词需要同时满足："明确提到 quota/额度/plan"，**不要**光看 status===429
 * 就认为是额度耗尽（会把真·限速误报为额度问题）。空 errorMessage 的 429 保守
 * 回落到 `matchRateLimit`。
 */
function matchQuotaExceeded(msg: string): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    /exceeded (?:the |your )?(?:monthly |daily |current )?(?:usage )?quota/.test(m) ||
    /monthly usage (?:quota|limit)/.test(m) ||
    /usage limit (?:exceeded|reached)/.test(m) ||
    /plan (?:quota|limit)/.test(m) ||
    /insufficient_quota/.test(m) ||
    /out of credits/.test(m)
  );
}

function matchRateLimit(msg: string, status?: number): boolean {
  if (status === 429) return true;
  const m = msg.toLowerCase();
  return /rate[ _-]?limit|quota|too many requests|limit exceeded/i.test(m);
}

function matchNetwork(msg: string): boolean {
  const m = msg.toLowerCase();
  return /econnreset|connection reset|econnrefused|etimedout|enotfound|eai_again|network ?error|fetch failed|networkerror/i.test(
    m,
  );
}

function matchOpaqueStreamConnectionDrop(msg: string): boolean {
  const m = msg.toLowerCase().trim();
  return (
    m === 'terminated' ||
    m === 'connection error' ||
    m === 'connection error.' ||
    /^(?:llm\s+stream\s+error:\s*)?terminated\.?$/i.test(msg.trim()) ||
    /^(?:llm\s+stream\s+error:\s*)?connection error\.?$/i.test(msg.trim()) ||
    /terminated.*other side closed|other side closed|stream.*terminated/i.test(m)
  );
}

function matchToolUnsupported(msg: string): boolean {
  const m = msg.toLowerCase();
  return /does not support tools|tools? (?:are )?not supported|tool use (?:is )?not supported|unsupported.*tools?|function[ _]call(?:ing)? not supported|no tools? (?:are )?available/i.test(
    m,
  );
}

function matchTimeout(msg: string, status?: number): boolean {
  if (status === 504) return true;
  const m = msg.toLowerCase();
  return /\btimed? ?out\b|timeout exceeded|first[ -]?event timeout|piaifirsteventtimeouterror/i.test(
    m,
  );
}

function inferLocalInferenceStack(input: ProviderErrorInput): boolean {
  const p = String(input.provider || '').toLowerCase();
  const raw = `${input.baseUrl || ''}|${input.errorMessage || ''}`.toLowerCase();
  return (
    p === 'ollama' ||
    raw.includes('localhost:11434') ||
    raw.includes('127.0.0.1:11434') ||
    raw.includes('[::1]:11434') ||
    /\boolama\b/.test(raw)
  );
}

function matchModelNotFound(msg: string, status?: number, code?: string): boolean {
  if (status === 404) return true;
  if ((code ?? '').toLowerCase() === 'model_not_found') return true;
  const raw = msg.trim();
  if (
    /\b无效模型\b|无效\s*的?\s*模型|模型\s*无效|未知模型|没有该模型|无此模型|模型不存在/.test(
      raw,
    ) ||
    /\binvalid\s+model\b|invalid\s+model\s+name/.test(msg.toLowerCase())
  ) {
    return true;
  }
  const m = msg.toLowerCase();
  return /\bmodel[_ ]not[_ ]found\b|no such model|model.*does not exist|the model (?:is )?(?:has been )?deprecated|model.*not (?:available|supported|enabled|active)|the requested model is/i.test(
    m,
  );
}

function matchServiceUnavailable(msg: string, status?: number): boolean {
  if (status === 502 || status === 503) return true;
  const m = msg.toLowerCase();
  return /service unavailable|temporarily unavailable|upstream (?:server|gateway) (?:error|busy)|gateway timeout|bad gateway|upstream connect error|model is currently overloaded|overloaded_error|server is busy|(?:llm\s+stream\s+error:\s*)?codex\s+stream\s+error/i.test(
    m,
  );
}

function matchContextLengthExceeded(msg: string, code?: string): boolean {
  if ((code ?? '').toLowerCase() === 'context_length_exceeded') return true;
  const c = (code ?? '').toLowerCase();
  if (
    (c === 'invalid_request_error' || c === 'bad_request') &&
    /context|token|length|窗口|超限|过长/i.test(msg)
  ) {
    return true;
  }
  const raw = msg.trim();
  if (
    /上下文\s*(?:长度|窗口)?\s*(?:超限|超过|溢出)|(?:超过|超出)\s*(?:最大)?\s*上下文|prompt\s*过长|输入\s*(?:过长|超限)|(?:消息|文本).*过长|token\s*(?:超限|不足|溢出)|(?:超过|超出).*?\btokens?\b/i.test(
      raw,
    )
  ) {
    return true;
  }
  const m = msg.toLowerCase();
  return /context_length_exceeded|maximum context (?:length|tokens)|max(?:imum)?_tokens|context window(?: exceeded)?|token\s*(?:limit|count).*exceed|exceeds?.*(?:model\s*)?(?:max(?:imum)?|allowed).*tokens|exceeds.*context|prompt is too long|too many tokens|total.*?tokens.*?high|input.*?too long|maximum input length|input length.*exceeds.*maximum|exceeds.*maximum.*(?:input|length|tokens)|requested.*?tokens/i.test(
    m,
  );
}

function matchStreamingUnsupported(msg: string): boolean {
  const m = msg.toLowerCase();
  return /stream(?:ing)? (?:is )?not supported|does not support stream|stream (?:is )?disabled|cannot stream/i.test(
    m,
  );
}

function matchEmptyResponse(msg: string): boolean {
  const m = msg.toLowerCase();
  return /empty (?:response|content|completion)|received (?:an )?empty|model returned empty|response had no content/i.test(
    m,
  );
}

function matchRuntimeLifecycle(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    /lifecyle_error|lifecycle_error|requested agent harness|agent harness .*not registered|protocol mismatch|agent session failed|occode/i.test(
      msg,
    ) ||
    /anthropic messages transport requires a positive maxtokens value|requires a positive maxTokens value/i.test(
      msg,
    ) ||
    (m.includes('board agent') && /gateway|protocol|lifecycle|harness|not registered|maxtokens/.test(m))
  );
}

/**
 * 把 provider raw error 映射到用户友好的 surface。
 *
 * 调用约定：
 *  - input 至少要有 errorMessage（空字符串也行，会命中 unknown）；
 *  - 若 surface.silent === true（`aborted_by_user`），caller 应完全不写 assistant_message；
 *  - caller 仍然负责把 raw errorMessage + category 写入 `error_detail` 列（本函数不处理持久化）；
 *  - 返回值是**只读**语义上的；caller 不应修改 actions 数组。
 */
export function classifyProviderError(input: ProviderErrorInput): ProviderErrorSurface {
  const raw = String(input.errorMessage ?? '').trim();
  const status = input.status;

  // 0. abort：区分 user / server / timeout
  if (matchAbort(raw)) {
    if (input.abortReason === 'user') return SILENT_USER_ABORT;
    if (input.abortReason === 'timeout') {
      return {
        category: 'timeout',
        userMessage: '模型响应超时，请稍后重试。',
        actions: [ACTION_RETRY, ACTION_SWITCH_MODEL],
        silent: false,
        retryable: true,
      };
    }
    return {
      category: 'aborted_by_server',
      userMessage: '请求被中断，请稍后重试。',
      actions: [ACTION_RETRY],
      silent: false,
      retryable: true,
    };
  }

  // 1. auth
  if (matchAuth(raw, status)) {
    return {
      category: 'auth',
      userMessage: '模型访问密钥无效或配置异常，请在设置中校验。',
      actions: [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: false,
    };
  }

  // 2. context corruption（v1.2.0 context 管理器引入的 regression；等 sub-task B 修根因）
  const ctx = matchContextCorruption(raw);
  if (ctx.hit) {
    if (ctx.flavor === 'thinking') {
      return {
        category: 'context_corruption',
        userMessage: '思考模式历史上下文缺少 reasoning 信息，建议开新对话或重试。',
        actions: [ACTION_NEW_SESSION, ACTION_RETRY],
        silent: false,
        retryable: false,
      };
    }
    return {
      category: 'context_corruption',
      userMessage: '工具调用上下文丢失，建议重新提问。',
      actions: [ACTION_RETRY, ACTION_NEW_SESSION],
      silent: false,
      retryable: false,
    };
  }

  // 3a. quota exceeded（429 子集：额度耗尽；重试无效，需换模型/等配额重置）
  //     必须先于 rate_limit 判定——否则 "quota" 子串会被 rate_limit 的正则先抢走。
  if (matchQuotaExceeded(raw)) {
    return {
      category: 'quota_exceeded',
      userMessage: '当前模型的调用额度已用尽，建议换个模型或在设置中调整。',
      actions: [ACTION_SWITCH_MODEL, ACTION_OPEN_SETTINGS],
      silent: false,
      retryable: false,
    };
  }

  // 3b. rate limit（真·短时间窗超限；重试有效）
  if (matchRateLimit(raw, status)) {
    return {
      category: 'rate_limit',
      userMessage: '访问太频繁，请稍后再试。',
      actions: [ACTION_RETRY],
      silent: false,
      retryable: true,
    };
  }

  // 4. network
  if (matchNetwork(raw)) {
    return {
      category: 'network',
      userMessage: '网络连接失败，请检查网络或代理配置。',
      actions: [ACTION_RETRY, ACTION_OPEN_SETTINGS],
      silent: false,
      retryable: true,
    };
  }

  // 5a. model not found —— 上游说没有这个模型 ID（用户最常踩的「模型不可用」根因）
  if (matchModelNotFound(raw, status, input.code)) {
    const localish = inferLocalInferenceStack(input);
    const quickLocal = input.lane === 'quick' && localish;
    const userMessage = quickLocal
      ? '本机快速模型不可用：请确认 Ollama 已启动且已拉取该模型；可打开「本地模型」完成安装与下发。'
      : localish
        ? '本机找不到该模型或未启动推理服务。请在「本地模型」检查运行状态与模型列表，或核对设置中的模型 ID。'
        : '云端或网关找不到该模型 ID。请到服务商控制台核对名称/权限，或在设置中更换模型。';
    return {
      category: 'model_not_found',
      userMessage,
      actions: [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: false,
    };
  }

  // 5b. context length —— 先于泛化 5xx：网关常以 503 返回「上下文过长」类文案
  if (matchContextLengthExceeded(raw, input.code)) {
    return {
      category: 'context_length_exceeded',
      userMessage:
        '本轮模型流式连接在长上下文处理后中断。建议开启新对话，让 Moss 先查看上一个会话内容再继续；也可以重试或换用更大上下文模型。',
      actions: [ACTION_NEW_SESSION, ACTION_RETRY, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: true,
    };
  }

  // 5c. service unavailable —— 上游 5xx 或裸流中断，可重试或换车道
  if (matchServiceUnavailable(raw, status) || matchOpaqueStreamConnectionDrop(raw)) {
    return {
      category: 'service_unavailable',
      userMessage: '厂商服务暂时不可用，请稍后再试或切换深度/快速车道。',
      actions: [ACTION_RETRY, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: true,
    };
  }

  // 5d. streaming not supported
  if (matchStreamingUnsupported(raw)) {
    return {
      category: 'streaming_not_supported',
      userMessage: '当前模型/网关不支持流式输出，请到设置中换一个支持 stream 的模型。',
      actions: [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: false,
    };
  }

  // 5e. tools not supported
  if (matchToolUnsupported(raw)) {
    return {
      category: 'tools_not_supported',
      userMessage:
        '当前模型不支持工具调用，工具任务可能失败；请到设置换用支持 tools 的模型（推荐 qwen3 / qwen3-coder / llama3.1 / claude / gpt-4.x）。',
      actions: [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: false,
    };
  }

  // 5f. empty response
  if (matchEmptyResponse(raw)) {
    return {
      category: 'empty_response',
      userMessage:
        '模型返回空内容（常见于思考类模型把所有输出放进 reasoning）。请到设置把「推理可见度」改为「stream」让思考过程可见，或换一个非纯思考模型。',
      actions: [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: true,
    };
  }

  // 5g. runtime lifecycle（board agent / collaboration gateway contract）
  if (matchRuntimeLifecycle(raw)) {
    return {
      category: 'runtime_lifecycle',
      userMessage:
        '板端协作运行时没有准备好，Moss 需要先恢复板端智能体或 Gateway 后才能继续。',
      actions: [ACTION_OPEN_BOARD_AGENT, ACTION_RETRY, ACTION_OPEN_SETTINGS],
      silent: false,
      retryable: true,
    };
  }

  // 5h. timeout（非 abort 触发的那种）
  if (matchTimeout(raw, status)) {
    return {
      category: 'timeout',
      userMessage: '模型响应超时，请稍后重试或在设置里换一个更快的模型。',
      actions: [ACTION_RETRY, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: true,
    };
  }

  // 6. unknown fallback
  return {
    category: 'unknown',
    userMessage:
      '模型暂时不可用。若当前对话反复失败，请开启新对话并让 Moss 查看上一个会话内容后继续。',
    actions: [ACTION_RETRY, ACTION_NEW_SESSION, ACTION_SWITCH_MODEL],
    silent: false,
    retryable: false,
  };
}

/**
 * 把 surface 渲染成最终 assistant 可见的 markdown 字符串。
 *
 * Caller 语义：
 *  - 若 surface.silent === true，**不要**调用此函数，直接不写 assistant_message；
 *  - 否则写入 assistant content 的 `text` block（actions 渲染为 markdown 文本，
 *    前端按 label 展示）。
 *
 * Host UIs can carry the structured surface over their event channel and render
 * actions as buttons. This markdown renderer remains the fallback for hosts
 * without structured UI rendering, and for CLI-style consumers.
 *
 * 输出示例：
 *   ```
 *   模型访问密钥无效或配置异常，请在设置中校验。
 *
 *   下一步：打开设置 · 换个模型
 *   ```
 */
export function renderProviderErrorSurface(surface: ProviderErrorSurface): string {
  if (surface.silent) return '';
  const head = surface.userMessage;
  if (surface.actions.length === 0) return head;
  const actionsLine = surface.actions.map((a) => a.label).join(' · ');
  return `${head}\n\n下一步：${actionsLine}`;
}

/**
 * 从 raw errorMessage 里剥离敏感 token，
 * 用于写入 `error_detail` 列前的最后一道防线。
 *
 * 复用 `secret-sanitizer.ts` 的全集规则（22 条），避免子集遗漏导致泄露。
 */
export function sanitizeRawErrorForDetail(raw: string): string {
  if (!raw) return '';
  return sanitizeSecrets(raw);
}
