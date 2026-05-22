/**
 * pi-ai LLM Provider adapter — bridges @mariozechner/pi-ai SDK to the
 * D-Moss LLMProvider interface.
 *
 * This adapter enables DmossAgent to use any pi-ai compatible LLM provider
 * (Anthropic, OpenAI, DeepSeek, Qwen, etc.) through the generic D-Moss API.
 *
 * Usage:
 * ```ts
 * import { streamSimple, registerBuiltInApiProviders } from '@mariozechner/pi-ai';
 * registerBuiltInApiProviders();
 *
 * const provider = new PiAiLLMProvider({
 *   streamFn: streamSimple,
 *   model: { api: 'anthropic', provider: 'anthropic', id: 'claude-sonnet-4-20250514' },
 *   apiKey: process.env.ANTHROPIC_API_KEY!,
 * });
 *
 * const agent = new DmossAgent({ llmProvider: provider, sessionStore: ... });
 * ```
 */

import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMMessage,
  LLMContentBlock,
} from '../core/llm-provider.js';
import { envPreferDmoss } from '../utils/env-compat.js';
import { combineAbortSignals } from '../core/abort.js';
import { getRootLogger } from '../logger.js';
import { classifyProviderError, type ProviderErrorSurface } from './error-classify.js';
import { isContextOverflowError } from './errors.js';
import { shouldSuppressReasoningForToolFollowUpRound } from '../core/follow-up-guard.js';
import { shouldRoundTripAssistantThinking } from '../core/message-convert.js';

const log = getRootLogger().child('provider:pi-ai');

// ============== 首包超时：防止上游 429/5xx 内部重试把单次调用拖到数分钟 ==============

const FIRST_EVENT_TIMEOUT_MS_DEFAULT = 45_000;
const FIRST_EVENT_TIMEOUT_MS_MIN = 5_000;
const FIRST_EVENT_TIMEOUT_MS_MAX = 600_000;

function resolveFirstEventTimeoutMs(): number {
  const raw = envPreferDmoss('DMOSS_PI_AI_FIRST_EVENT_TIMEOUT_MS', 'PI_AI_FIRST_EVENT_TIMEOUT_MS');
  if (raw == null) return FIRST_EVENT_TIMEOUT_MS_DEFAULT;
  const s = String(raw).trim();
  if (!s) return FIRST_EVENT_TIMEOUT_MS_DEFAULT;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) return FIRST_EVENT_TIMEOUT_MS_DEFAULT;
  if (n <= 0) return 0; // 0/负值 = 禁用
  return Math.min(FIRST_EVENT_TIMEOUT_MS_MAX, Math.max(FIRST_EVENT_TIMEOUT_MS_MIN, n));
}

/**
 * pi-ai 首包超时错误：上游长时间无任何事件（包括 text/thinking/toolcall/error），
 * 大概率是 provider 内部在 429/5xx 默默重试，此时主动中止并向上抛出，让 host 层
 * 决定是快速失败给用户还是换模型，而不是让用户盯着「回复中…」干等几分钟。
 *
 * 该 Error 的 name 被 dmoss-agent 的 shouldRetry 识别为「不重试」——与 pi-ai 内部
 * 的重试叠加等于放大等待，再去外层重试几乎不会更快缓解，不如早退并让用户换个模型。
 */
export class PiAiFirstEventTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly provider: string;
  readonly model: string;
  constructor(params: { timeoutMs: number; provider: string; model: string }) {
    super(
      `pi-ai (${params.provider} / ${params.model}) 在 ${Math.round(params.timeoutMs / 1000)}s 内未吐出任何流事件，` +
        `多半是上游网关在 429/过载/超时后内部反复重试。已主动中止本次调用，建议稍后再试或换一个模型/供应商。`,
    );
    this.name = 'PiAiFirstEventTimeoutError';
    this.timeoutMs = params.timeoutMs;
    this.provider = params.provider;
    this.model = params.model;
  }
}

class PiAiProviderRuntimeError extends Error {
  readonly surface: ProviderErrorSurface;

  constructor(params: { message: string; surface: ProviderErrorSurface }) {
    super(params.message || params.surface.userMessage || 'Provider runtime error');
    this.name = 'PiAiProviderRuntimeError';
    this.surface = params.surface;
  }
}

export interface PiAiModelInfo {
  api: string;
  provider: string;
  id: string;
  baseUrl?: string;
  [key: string]: unknown;
}

/**
 * Minimal pi-ai StreamFunction signature — avoids hard dependency on pi-ai
 * types so the adapter can work with any compatible stream function.
 */
export type PiAiStreamFunction = (
  model: PiAiModelInfo,
  context: unknown,
  options?: Record<string, unknown>,
) => AsyncIterable<PiAiStreamEvent>;

export interface PiAiStreamEvent {
  type: string;
  text?: string;
  /** Delta text for incremental streaming (text_delta, thinking_delta) */
  delta?: string;
  toolCall?: {
    id: string;
    name: string;
    arguments?: Record<string, unknown>;
    partialArgs?: string;
    partial?: boolean;
  };
  usage?: { input: number; output: number };
  stopReason?: string;
  /** Alias for stopReason used by some pi-ai event shapes */
  reason?: string;
  thinking?: string;
  /** Full message payload on 'done'/'result' events */
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      arguments?: Record<string, unknown>;
    }>;
    usage?: { input: number; output: number };
  };
  /** Error payload on 'error' events */
  error?: {
    errorMessage?: string;
    /** 部分网关用 error 事件携带完整 assistant 块（含 thinking / text / toolCall） */
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      arguments?: Record<string, unknown>;
      partial?: boolean;
      partialArgs?: string;
    }>;
    usage?: { input: number; output: number };
    stopReason?: string;
    [key: string]: unknown;
  };
}

export interface PiAiLLMProviderConfig {
  streamFn: PiAiStreamFunction;
  model: PiAiModelInfo;
  apiKey: string;
  baseUrl?: string;
  displayName?: string;
  /** pi-ai reasoning level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null */
  reasoning?: string | null;
  /** Optional host-specific repair for truncated URL tool arguments. */
  repairToolCallUrl?: (url: string) => string;
}

function appendToolUseBlock(
  content: LLMContentBlock[],
  tc: {
    id: string;
    name: string;
    arguments?: Record<string, unknown>;
    input?: Record<string, unknown>;
  },
): void {
  if (content.some((b) => b.type === 'tool_use' && b.id === tc.id)) return;
  content.push({
    type: 'tool_use',
    id: tc.id,
    name: tc.name,
    input: tc.arguments ?? tc.input ?? {},
  });
}

/** OpenAI / Doubao 等：`toolCall` 与 `tool_call` 等价 */
function isPiAssistantToolCallBlockType(type: string | undefined): boolean {
  const n = String(type ?? '')
    .toLowerCase()
    .replace(/_/g, '');
  return n === 'toolcall';
}

type PiErrAssistantBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  /** Doubao 流式 tool 可能在 JSON 未闭合时结束，参数以字符串碎片形式出现 */
  partial?: boolean;
  partialArgs?: string;
};

function isHttpErrorStatus(value: unknown): boolean {
  return typeof value === 'number' && value >= 400;
}

function extractAssistantBlockThinking(block: PiErrAssistantBlock): string {
  if (typeof block.thinking === 'string' && block.thinking) return block.thinking;
  if ((block.type === 'thinking' || block.type === 'reasoning') && typeof block.text === 'string') {
    return block.text;
  }
  return '';
}

function extractErrorPayloadText(
  payload: NonNullable<PiAiStreamEvent['error']> | undefined,
): string {
  if (!payload?.content || !Array.isArray(payload.content)) return '';
  return payload.content
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function buildProviderRuntimeErrorMessage(
  payload: NonNullable<PiAiStreamEvent['error']> | undefined,
  fallback = 'Provider runtime error',
): string {
  if (!payload) return fallback;
  const message = String(
    payload.errorMessage ||
      payload.code ||
      payload.status ||
      extractErrorPayloadText(payload) ||
      fallback,
  );
  return message.trim() || fallback;
}

function hasProviderRuntimeErrorSignal(
  payload: NonNullable<PiAiStreamEvent['error']> | undefined,
): boolean {
  if (!payload) return false;
  if (typeof payload.errorMessage === 'string' && payload.errorMessage.trim()) return true;
  if (isHttpErrorStatus(payload.status)) return true;
  if (typeof payload.code === 'string' && payload.code.trim()) return true;
  const text = extractErrorPayloadText(payload);
  return /^(?:\d{3}\s+)?(?:bad request|unauthorized|forbidden|too many requests|connection error)\b|reasoning_content.*must be passed back/iu.test(
    text,
  );
}

/**
 * 网关截断 JSON 时 `arguments` 可能为空或不完整；`partialArgs` 含未闭合的 JSON 字符串。
 * 对常见「打开论坛」URL 做补全，避免 tool_use 无法执行。
 */
function tryParsePartialArgsString(s: string): Record<string, unknown> | null {
  const t = s.trim();
  if (!t) return null;
  try {
    const j = JSON.parse(t) as unknown;
    if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>;
  } catch {
    /* 未闭合 JSON */
  }
  const m = t.match(/"url"\s*:\s*"([^"]*)/);
  if (m?.[1]) {
    return { url: m[1] };
  }
  return null;
}

function defaultRepairToolCallUrl(url: string): string {
  return url.trim();
}

function normalizeToolCallArgumentsFromAssistantBlock(
  block: PiErrAssistantBlock,
  repairToolCallUrl: (url: string) => string = defaultRepairToolCallUrl,
): Record<string, unknown> {
  let args: Record<string, unknown> = {};
  if (block.arguments && typeof block.arguments === 'object' && !Array.isArray(block.arguments)) {
    args = { ...block.arguments };
  }
  if (typeof block.partialArgs === 'string' && block.partialArgs.trim()) {
    const parsed = tryParsePartialArgsString(block.partialArgs);
    if (parsed && Object.keys(parsed).length > 0) {
      args = { ...args, ...parsed };
    }
  }
  if (typeof args.url === 'string') {
    args = { ...args, url: repairToolCallUrl(args.url) };
  }
  return args;
}

/**
 * 部分 pi-ai / 网关：`type: error` 时完整 assistant 在 `event.error`，
 * 也有变体把 `role` + `content[]` 直接放在事件顶层（无 `error` 键），否则 toolCall 无法合并。
 */
function resolvePiStreamErrorPayload(
  event: PiAiStreamEvent,
): NonNullable<PiAiStreamEvent['error']> | undefined {
  if (event.error && typeof event.error === 'object') {
    return event.error;
  }
  const top = event as PiAiStreamEvent & {
    role?: string;
    content?: PiErrAssistantBlock[];
    errorMessage?: string;
  };
  if (event.type === 'error' && Array.isArray(top.content)) {
    return {
      content: top.content as NonNullable<PiAiStreamEvent['error']>['content'],
      role: top.role,
      errorMessage: top.errorMessage,
      usage: top.usage,
      stopReason: top.stopReason,
    } as NonNullable<PiAiStreamEvent['error']>;
  }
  return undefined;
}

/**
 * Guard against Anthropic OAuth / session tokens.
 *
 * Upstream pi-ai's `anthropic` provider detects `apiKey.includes("sk-ant-oat")`
 * and enters a "Claude Code compatibility" code path: it injects a Claude Code
 * identity string, rewrites tool names via `toClaudeCodeName()`, and sends a
 * `claude-code-20250219,oauth-2025-04-20` beta header. `@dmoss/agent` does not
 * impersonate any third-party product on the wire, so we refuse such tokens
 * here — **before** the request ever leaves this package.
 *
 * Rationale: this guard is what lets us stop shipping a patch-package patch
 * that rewrites pi-ai's hard-coded identity string. With this guard active,
 * pi-ai's `isOAuthToken` branch is unreachable through `PiAiLLMProvider`.
 *
 * We only guard the `anthropic` API shape; OpenAI-compatible gateways and
 * other providers never see pi-ai's OAuth branch regardless of the token
 * format, so no guard is needed there.
 */
function rejectAnthropicOAuthToken(apiKey: string, api: string | undefined): void {
  const looksAnthropic = typeof api === 'string' && /^anthropic/i.test(api);
  if (!looksAnthropic) return;
  if (typeof apiKey === 'string' && apiKey.includes('sk-ant-oat')) {
    throw new Error(
      '@dmoss/agent refuses Anthropic OAuth / session tokens (sk-ant-oat*). ' +
        'Please provide an official API key (sk-ant-api03-*) or configure an ' +
        'OpenAI-compatible gateway via DMOSS_BASE_URL. See SECURITY.md for ' +
        'the rationale ("Provider credentials & identity").',
    );
  }
}

/** pi-ai 流式路径在收到 usage 时会读 `model.cost.*`；convertMessages 会读 `model.input.includes(...)`。 */
type PiAiModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number };

const DEFAULT_PI_AI_COST: PiAiModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function mergePiAiModelCost(incoming: unknown): PiAiModelCost {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { ...DEFAULT_PI_AI_COST };
  }
  const o = incoming as Record<string, unknown>;
  return {
    input: typeof o.input === 'number' ? o.input : DEFAULT_PI_AI_COST.input,
    output: typeof o.output === 'number' ? o.output : DEFAULT_PI_AI_COST.output,
    cacheRead: typeof o.cacheRead === 'number' ? o.cacheRead : DEFAULT_PI_AI_COST.cacheRead,
    cacheWrite: typeof o.cacheWrite === 'number' ? o.cacheWrite : DEFAULT_PI_AI_COST.cacheWrite,
  };
}

/**
 * 合并调用方传入的 model 与 pi-ai 运行时硬依赖字段，避免「只传 api/id/provider」时流式首包抛错。
 * 若已传完整 `cost` / `input`（如 buildModelDef），则保留调用方值。
 */
function normalizePiAiModelInfo(model: PiAiModelInfo, baseUrl?: string): PiAiModelInfo {
  const merged: PiAiModelInfo = {
    ...model,
    ...(baseUrl ? { baseUrl } : {}),
    cost: mergePiAiModelCost(model.cost),
    input: Array.isArray(model.input) && model.input.length > 0 ? model.input : ['text'],
  };
  return merged;
}

/**
 * 与 {@link PiAiLLMProvider} 内 `convertMessages` 产物一致：每条 `user` 内的 `tool_result` 会拆成独立一条
 * `role: 'toolResult'` 消息。仅靠「`LLMMessage` 最后一条是否含 tool_result」会漏检（多块顺序、
 * 中间插入 steering user 等）。这里用 **与上游网关完全一致的线格式** 判定：在**最后一条
 * `assistant` 之后**若仍存在 `toolResult`，说明本轮请求处在「向模型喂入工具结果、等待其下一句」
 * 阶段，必须关本次新 reasoning 开关；但上一拍 assistant 的 `reasoning_content`
 * 仍要随消息回传，否则网关会报「must be passed back」。
 */
function findLastPiWireAssistantIndex(converted: readonly unknown[]): number {
  for (let i = converted.length - 1; i >= 0; i--) {
    if ((converted[i] as { role?: string })?.role === 'assistant') return i;
  }
  return -1;
}

function wireConvertedHasToolResultAfterLastAssistant(converted: readonly unknown[]): boolean {
  const aix = findLastPiWireAssistantIndex(converted);
  const last = converted[converted.length - 1] as { role?: string } | undefined;
  return converted.length > aix + 1 && last?.role === 'toolResult';
}

function resolveToolFollowReasoningSuppress(
  internalMessages: LLMMessage[] | undefined,
  converted: readonly unknown[],
): boolean {
  if (Array.isArray(internalMessages) && internalMessages.length > 0) {
    if (shouldSuppressReasoningForToolFollowUpRound(internalMessages)) return true;
  }
  return wireConvertedHasToolResultAfterLastAssistant(converted);
}

function hasThinkingModeConfigured(
  model: PiAiModelInfo,
  providerReasoning: string | null | undefined,
  requestReasoning: string | null | undefined,
): boolean {
  const modelReasoning = (model as { reasoning?: unknown }).reasoning;
  const modelSupportsThinkingHistory =
    modelReasoning !== undefined &&
    modelReasoning !== null &&
    modelReasoning !== false &&
    modelReasoning !== '';
  if (modelSupportsThinkingHistory) return true;
  if (requestReasoning === null || requestReasoning === '') return false;
  if (requestReasoning !== undefined) return true;
  return providerReasoning !== undefined && providerReasoning !== null && providerReasoning !== '';
}

function hasProviderNativeThinkingHistory(
  model: PiAiModelInfo,
  providerReasoning: string | null | undefined,
): boolean {
  return hasThinkingModeConfigured(model, providerReasoning, undefined);
}

function hasAssistantThinkingHistory(messages: LLMMessage[] | undefined): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((msg) =>
    msg.role === 'assistant' &&
    Array.isArray((msg as { thinking?: unknown }).thinking) &&
    (msg as { thinking: unknown[] }).thinking.some((item) => String(item ?? '').trim()),
  );
}

export class PiAiLLMProvider implements LLMProvider {
  readonly id: string;
  readonly displayName: string;

  private streamFn: PiAiStreamFunction;
  private model: PiAiModelInfo;
  private apiKey: string;
  private baseUrl?: string;
  private reasoning?: string | null;
  private repairToolCallUrl: (url: string) => string;

  constructor(config: PiAiLLMProviderConfig) {
    rejectAnthropicOAuthToken(config.apiKey, config.model?.api);
    this.streamFn = config.streamFn;
    this.model = normalizePiAiModelInfo(config.model, config.baseUrl);
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.reasoning = config.reasoning;
    this.repairToolCallUrl = config.repairToolCallUrl ?? defaultRepairToolCallUrl;
    this.id = `pi-ai-${config.model.provider}`;
    this.displayName = config.displayName ?? `pi-ai (${config.model.provider})`;
  }

  /**
   * 工具结果跟进轮只抑制新的 reasoning_effort；model 上的 reasoning 标记仍需保留。
   * pi-ai 的 OpenAI 兼容转换依赖这个标记/compat 来序列化历史 thinking block，
   * 如果把它也摘掉，部分网关会认为上一轮 assistant 的 reasoning_content 没有被带回。
   *
   * `toolFollowSuppress` 由 {@link resolveToolFollowReasoningSuppress} 统一给出（线格式 + 结构化启发式双保险）。
   */
  private buildPiModelForCall(
    options: LLMRequestOptions,
    _toolFollowSuppress: boolean,
  ): PiAiModelInfo {
    if (options.reasoning === '') {
      const m = { ...this.model } as PiAiModelInfo;
      delete m.reasoning;
      return m;
    }
    if (options.reasoning !== undefined && options.reasoning !== null) {
      return { ...this.model, reasoning: options.reasoning } as PiAiModelInfo;
    }
    return this.model;
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const content: LLMContentBlock[] = [];
    /**
     * Always pass a `thinkingChunks` array — `processEvent` will route
     * `thinking` / `thinking_delta` events into it instead of synthesising
     * a `<think>...</think>` text block in `content`. The accumulated
     * thinking is then surfaced via `LLMResponse.thinking`.
     */
    const thinkingChunks: string[] = [];
    let stopReason: LLMResponse['stopReason'] = 'end_turn';
    let usage = { inputTokens: 0, outputTokens: 0 };

    const requestThinkingMode = hasThinkingModeConfigured(
      this.model,
      this.reasoning,
      options.reasoning,
    );
    let convertedMessages = this.convertMessages(options.messages, requestThinkingMode);
    const toolFollowSuppress = resolveToolFollowReasoningSuppress(
      options.messages,
      convertedMessages,
    );
    if (
      toolFollowSuppress &&
      !requestThinkingMode &&
      (hasProviderNativeThinkingHistory(this.model, this.reasoning) ||
        hasAssistantThinkingHistory(options.messages))
    ) {
      convertedMessages = this.convertMessages(options.messages, true);
    }
    const piContext = this.buildPiContext(options, convertedMessages);
    const watchdog = this.startFirstEventWatchdog(options.abortSignal);
    const piOptions = this.buildPiOptions(options, watchdog.signal, toolFollowSuppress);
    const piModel = this.buildPiModelForCall(options, toolFollowSuppress);

    try {
      for await (const event of this.streamFn(piModel, piContext, piOptions)) {
        watchdog.onActivity();
        const parsed = this.processEvent(event, content, thinkingChunks);
        if (parsed.stopReason) stopReason = parsed.stopReason;
        if (parsed.usage) usage = parsed.usage;
      }
    } catch (err) {
      throw watchdog.translateError(err);
    } finally {
      watchdog.dispose();
    }

    if (thinkingChunks.length > 0 && content.length === 0) {
      log.warn(
        'LLM completed (non-streaming) with only thinking content (no visible text, no tool_use); ' +
          'host should surface a placeholder via LLMResponse.thinking',
        {
          thinkingChars: thinkingChunks.join('').length,
          model: this.model.id,
          provider: this.model.provider,
        },
      );
    }

    return {
      stopReason,
      content,
      usage,
      ...(thinkingChunks.length > 0 ? { thinking: thinkingChunks } : {}),
    };
  }

  async stream(
    options: LLMRequestOptions,
    onEvent: (event: LLMStreamEvent) => void,
  ): Promise<LLMResponse> {
    const content: LLMContentBlock[] = [];
    const thinkingChunks: string[] = [];
    let stopReason: LLMResponse['stopReason'] = 'end_turn';
    let usage = { inputTokens: 0, outputTokens: 0 };

    const requestThinkingMode = hasThinkingModeConfigured(
      this.model,
      this.reasoning,
      options.reasoning,
    );
    let convertedMessages = this.convertMessages(options.messages, requestThinkingMode);
    const toolFollowSuppress = resolveToolFollowReasoningSuppress(
      options.messages,
      convertedMessages,
    );
    if (
      toolFollowSuppress &&
      !requestThinkingMode &&
      (hasProviderNativeThinkingHistory(this.model, this.reasoning) ||
        hasAssistantThinkingHistory(options.messages))
    ) {
      convertedMessages = this.convertMessages(options.messages, true);
    }
    const piContext = this.buildPiContext(options, convertedMessages);
    const watchdog = this.startFirstEventWatchdog(options.abortSignal);
    const piOptions = this.buildPiOptions(options, watchdog.signal, toolFollowSuppress);
    const piModel = this.buildPiModelForCall(options, toolFollowSuppress);

    /** 设为 `1` / `true` 时，流结束后打一行 JSON，便于核对 pi-ai 是否曾发出 toolCall / done（排查「只有正文无工具」） */
    const tracePiAiStream =
      process.env.DMOSS_TRACE_PI_AI_STREAM === '1' ||
      process.env.DMOSS_TRACE_PI_AI_STREAM === 'true';
    const eventTypeCounts: Record<string, number> = {};

    let streamError: Error | null = null;
    try {
      for await (const event of this.streamFn(piModel, piContext, piOptions)) {
        watchdog.onActivity();
        if (tracePiAiStream) {
          const et = String((event as PiAiStreamEvent).type ?? 'unknown');
          eventTypeCounts[et] = (eventTypeCounts[et] ?? 0) + 1;
        }
        const llmEvent = this.convertStreamEvent(event);
        if (llmEvent) onEvent(llmEvent);

        const parsed = this.processEvent(event, content, thinkingChunks);
        if (parsed.stopReason) stopReason = parsed.stopReason;
        if (parsed.usage) usage = parsed.usage;
      }
    } catch (err) {
      const translated = watchdog.translateError(err);
      /**
       * 首包超时 / 用户 abort 必须向外重抛——
       * 它们不是「模型产出不全」，而是「我们主动停了上游」，外层 retry / run 流程需要看到原始错误。
       */
      if (translated instanceof PiAiFirstEventTimeoutError || options.abortSignal?.aborted) {
        watchdog.dispose();
        throw translated;
      }
      streamError = translated instanceof Error ? translated : new Error(String(translated));
      log.warn('stream threw after processing events', {
        error: streamError.message,
        model: this.model.id,
      });
    } finally {
      watchdog.dispose();
    }

    /**
     * Industry-standard separation of thinking vs final answer (Anthropic
     * `thinking` / `text` blocks; OpenAI Responses `reasoning` vs
     * `output_text`; DeepSeek/Qwen `reasoning_content` vs `content`).
     *
     * Thinking deltas are surfaced to the host **only** via the live stream
     * (`convertStreamEvent` emits `deltaRole: 'thinking'`). They MUST NOT be
     * folded back into `LLMResponse.content` as a synthetic `<think>` text
     * block — doing so:
     *   1) pollutes the persisted assistant turn (the next round's prompt
     *      ships planner-speak back to the upstream model, which then
     *      escalates its own reasoning, snowballing across turns); and
     *   2) makes upstream behaviour drift from Claude / GPT-5 / R1, where
     *      the agent loop is supposed to see "no visible answer" and decide
     *      whether to retry / nudge / surface a placeholder.
     *
     * The only case we still escalate as a hard error is when the stream was
     * interrupted (`streamError`) AND we have no visible text / tool_use.
     * That genuinely is a "model reasoned but was cut off" condition, and
     * upstream agent-loop / dmoss-agent.streamChat use the thrown error to
     * trigger retry / user-facing failure messaging.
     */
    if (thinkingChunks.length > 0) {
      const thinkingText = thinkingChunks.join('');
      const hasVisibleText = content.some(
        (b) => b.type === 'text' && 'text' in b && (b as { text: string }).text?.trim(),
      );
      const hasToolUse = content.some((b) => b.type === 'tool_use');

      if (streamError && !hasVisibleText && !hasToolUse) {
        log.warn(
          'stream error with only thinking content; model reasoned but was interrupted before response',
          { thinkingChars: thinkingText.length, error: streamError.message },
        );
        throw new Error(
          `LLM stream error: model completed reasoning but was interrupted before producing a response. ` +
            `This is usually a gateway timeout or upstream error. Original: ${streamError.message}`,
        );
      }

      if (!hasVisibleText && !hasToolUse) {
        log.warn(
          'LLM completed with only thinking content (no visible text, no tool_use); ' +
            'host agent loop should surface a placeholder or retry — thinking will NOT be folded into content',
          {
            thinkingChars: thinkingText.length,
            model: this.model.id,
            provider: this.model.provider,
          },
        );
      } else {
        log.debug(
          'thinking deltas observed; not folded into content (industry-standard separation)',
          {
            thinkingChars: thinkingText.length,
            hasVisibleText,
            hasToolUse,
          },
        );
      }
    }

    if (streamError) {
      throw streamError;
    }

    if (tracePiAiStream) {
      const hasToolUseBlock = content.some((b) => b.type === 'tool_use');
      const visibleChars = content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && 'text' in b)
        .reduce((n, b) => n + (b.text?.length ?? 0), 0);
      log.debug('stream trace', {
        model: this.model.id,
        provider: this.model.provider,
        eventTypeCounts,
        stopReason,
        hasToolUseBlock,
        visibleChars,
        thinkingChars: thinkingChunks.reduce((n, s) => n + s.length, 0),
        streamError: null,
      });
    }

    return {
      stopReason,
      content,
      usage,
      ...(thinkingChunks.length > 0 ? { thinking: thinkingChunks } : {}),
    };
  }

  private buildPiContext(options: LLMRequestOptions, convertedMessages: unknown[]): unknown {
    const tools = options.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }));

    return {
      systemPrompt: options.systemPrompt,
      messages: convertedMessages,
      tools: tools ?? [],
      apiKey: this.apiKey,
      ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
    };
  }

  private buildPiOptions(
    options: LLMRequestOptions,
    overrideAbortSignal?: AbortSignal,
    toolFollowSuppress = false,
  ): Record<string, unknown> {
    /**
     * OpenAI 兼容：`tool_choice` 可强制至少一次 function call（`required`）。
     * 仅用于排查「模型只写规划、协议层从不出现 tool_calls」；全局开启会破坏纯问答轮次，默认不设。
     * @see https://platform.openai.com/docs/api-reference/chat/create#chat-create-tool_choice
     */
    const tcRaw = envPreferDmoss('DMOSS_PI_AI_TOOL_CHOICE', 'PI_AI_TOOL_CHOICE');
    const toolChoice =
      tcRaw === 'required' || tcRaw === 'auto' || tcRaw === 'none' ? tcRaw : undefined;

    /**
     * 首包超时 watchdog 会把 caller 的 abortSignal 与内部的 timeout signal 合并后传进来；
     * 若 host 没配置 watchdog（complete/stream 外的路径）则退回到原始 options.abortSignal。
     * pi-ai 的不同版本/provider 对 abort 字段命名不一致（signal / abortSignal），两个键都带上兼容。
     */
    const effectiveSignal = overrideAbortSignal ?? options.abortSignal;

    let reasoningForPi: string | undefined;
    if (options.reasoning === null || options.reasoning === '' || toolFollowSuppress) {
      reasoningForPi = undefined;
    } else if (options.reasoning !== undefined) {
      reasoningForPi = options.reasoning;
    } else if (this.reasoning !== undefined && this.reasoning !== null && this.reasoning !== '') {
      reasoningForPi = this.reasoning;
    }

    return {
      apiKey: this.apiKey,
      ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
      ...(reasoningForPi ? { reasoning: reasoningForPi } : {}),
      maxTokens: options.maxTokens ?? 4096,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(effectiveSignal ? { abortSignal: effectiveSignal, signal: effectiveSignal } : {}),
      ...(toolChoice ? { toolChoice } : {}),
    };
  }

  /**
   * 启动首包超时监视：若 `timeoutMs` 内（默认 45s）上游没有任何流事件，就触发
   * 内部 AbortController，把 streamFn 的 HTTP 请求掐掉，并在调用方捕获时把底层错误
   * 翻译成 `PiAiFirstEventTimeoutError`。首个事件到达后 dispose 即可，不会影响后续
   * 流程；用户点「停止」抛出的 AbortError 也会原样透传，保留现有的 abort 行为。
   */
  private startFirstEventWatchdog(callerSignal?: AbortSignal): {
    signal: AbortSignal | undefined;
    onActivity: () => void;
    dispose: () => void;
    translateError: (err: unknown) => unknown;
  } {
    const timeoutMs = resolveFirstEventTimeoutMs();
    if (timeoutMs <= 0) {
      return {
        signal: callerSignal,
        onActivity: () => {},
        dispose: () => {},
        translateError: (err) => err,
      };
    }

    const ctrl = new AbortController();
    let firedByTimeout = false;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      firedByTimeout = true;
      try {
        ctrl.abort();
      } catch {
        /* noop */
      }
    }, timeoutMs);

    const combined = combineAbortSignals(callerSignal, ctrl.signal) ?? ctrl.signal;

    const clear = () => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    return {
      signal: combined,
      onActivity: () => {
        clear();
      },
      dispose: () => {
        clear();
      },
      translateError: (err: unknown) => {
        if (!firedByTimeout) return err;
        if (callerSignal?.aborted) return err;
        return new PiAiFirstEventTimeoutError({
          timeoutMs,
          provider: this.model.provider ?? 'unknown',
          model: this.model.id ?? 'unknown',
        });
      },
    };
  }

  private convertMessages(messages: LLMMessage[], thinkingMode: boolean): unknown[] {
    const result: unknown[] = [];

    for (let index = 0; index < messages.length; index += 1) {
      const msg = messages[index];
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'user', content: msg.content });
        } else {
          for (const block of msg.content) {
            if (block.type === 'text') {
              result.push({ role: 'user', content: [{ type: 'text', text: block.text }] });
            } else if (block.type === 'tool_result') {
              result.push({
                role: 'toolResult',
                toolCallId: block.tool_use_id,
                toolName: '',
                content: [{ type: 'text', text: block.content }],
                isError: block.is_error ?? false,
              });
            }
          }
        }
      } else if (msg.role === 'assistant') {
        /**
         * OpenAI 兼容 + thinking（DeepSeek 等）：thinking 模式要求历史 assistant
         * 的 `reasoning_content` 原样带回，否则下一轮会被 400 拒绝。非 thinking
         * 模型仍只在工具结果跟进轮回传，避免把 UI 回放用 thinking 塞进普通历史。
         * @see node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js
         */
        const includeThinking = shouldRoundTripAssistantThinking(messages, index, { thinkingMode });
        const pushThinkingBlocks = (out: unknown[]) => {
          if (!includeThinking) return;
          const t = msg.thinking;
          if (!Array.isArray(t) || t.length === 0) return;
          const joined = t.filter(Boolean).join('\n\n').trim();
          if (!joined) return;
          out.push({
            type: 'thinking',
            thinking: joined,
            /** 与流式首包 `reasoning_content` / `reasoning` 等字段对齐；ODC 常见为前者 */
            thinkingSignature: 'reasoning_content',
          });
        };

        if (typeof msg.content === 'string') {
          const piContent: unknown[] = [];
          pushThinkingBlocks(piContent);
          piContent.push({ type: 'text', text: msg.content });
          result.push({
            role: 'assistant',
            content: piContent,
            api: this.model.api,
            provider: this.model.provider,
            model: this.model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
          });
        } else {
          const piContent: unknown[] = [];
          pushThinkingBlocks(piContent);
          for (const block of msg.content) {
            if (block.type === 'text') {
              piContent.push({ type: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              piContent.push({
                type: 'toolCall',
                id: block.id,
                name: block.name,
                arguments: block.input,
              });
            }
          }
          result.push({
            role: 'assistant',
            content: piContent,
            api: this.model.api,
            provider: this.model.provider,
            model: this.model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
          });
        }
      }
    }

    return result;
  }

  private processEvent(
    event: PiAiStreamEvent,
    content: LLMContentBlock[],
    thinkingChunks?: string[],
  ): {
    stopReason?: LLMResponse['stopReason'];
    usage?: { inputTokens: number; outputTokens: number };
  } {
    const t = event.type;

    if (t === 'text' || t === 'text_delta') {
      const delta = event.delta ?? event.text ?? '';
      if (!delta) return {};
      const last = content[content.length - 1];
      if (last && last.type === 'text') {
        (last as { text: string }).text += delta;
      } else {
        content.push({ type: 'text', text: delta });
      }
    } else if (t === 'text_end') {
      // text_end carries the full content; already accumulated via text_delta
    } else if (t === 'thinking' || t === 'thinking_delta') {
      const delta = event.delta ?? event.thinking ?? '';
      if (delta && thinkingChunks) {
        thinkingChunks.push(delta);
      }
      /**
       * Callers without a `thinkingChunks` array intentionally lose the
       * thinking content here — both `complete()` and `stream()` now always
       * pass a `thinkingChunks` array so reasoning is surfaced via
       * `LLMResponse.thinking`. The legacy `<think>` text-block fallback
       * (which would put planner-speak into the persisted assistant turn)
       * has been removed in favour of industry-standard separation
       * (Anthropic / GPT-5 / DeepSeek R1 all split reasoning from content).
       */
    } else if (t === 'thinking_end') {
      // thinking_end: accumulated via thinking_delta chunks
    } else if ((t === 'toolCall' || t === 'toolcall_end') && event.toolCall) {
      const tc = event.toolCall;
      appendToolUseBlock(content, {
        id: tc.id,
        name: tc.name,
        arguments: normalizeToolCallArgumentsFromAssistantBlock(
          {
            arguments: tc.arguments,
            partialArgs: tc.partialArgs,
          },
          this.repairToolCallUrl,
        ),
      });
    } else if (t === 'result' || t === 'done') {
      const sr = event.stopReason ?? event.reason;
      const mapped: LLMResponse['stopReason'] =
        sr === 'toolCall' || sr === 'toolUse'
          ? 'tool_use'
          : sr === 'stop'
            ? 'end_turn'
            : sr === 'length'
              ? 'max_tokens'
              : 'end_turn';
      const msg = event.message;
      const evtUsage = event.usage ?? msg?.usage;

      if (msg?.content && Array.isArray(msg.content)) {
        const hasTextInContent = content.some(
          (b) => b.type === 'text' && 'text' in b && (b as { text: string }).text?.trim(),
        );
        for (const block of msg.content) {
          const thinking = extractAssistantBlockThinking(block as PiErrAssistantBlock);
          if (thinking && thinkingChunks) thinkingChunks.push(thinking);
        }
        if (!hasTextInContent) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text?.trim()) {
              content.push({ type: 'text', text: block.text });
            } else if (isPiAssistantToolCallBlockType(block.type) && block.id && block.name) {
              appendToolUseBlock(content, {
                id: block.id,
                name: block.name,
                arguments: normalizeToolCallArgumentsFromAssistantBlock(
                  block as PiErrAssistantBlock,
                  this.repairToolCallUrl,
                ),
              });
            }
          }
        } else {
          for (const block of msg.content) {
            if (isPiAssistantToolCallBlockType(block.type) && block.id && block.name) {
              appendToolUseBlock(content, {
                id: block.id,
                name: block.name,
                arguments: normalizeToolCallArgumentsFromAssistantBlock(
                  block as PiErrAssistantBlock,
                  this.repairToolCallUrl,
                ),
              });
            }
          }
        }
      }

      const hasToolUse = content.some((b) => b.type === 'tool_use');
      const stopReasonOut: LLMResponse['stopReason'] = hasToolUse ? 'tool_use' : mapped;

      return {
        stopReason: stopReasonOut,
        usage: evtUsage
          ? { inputTokens: evtUsage.input ?? 0, outputTokens: evtUsage.output ?? 0 }
          : undefined,
      };
    } else if (
      t === 'start' ||
      t === 'text_start' ||
      t === 'thinking_start' ||
      t === 'toolcall_start' ||
      t === 'toolcall_delta'
    ) {
      // lifecycle events — no content to extract
    } else if (t === 'error') {
      const errPayload = resolvePiStreamErrorPayload(event);
      const reason = event.reason ?? 'unknown';
      log.warn('stream error event', {
        reason,
        errPayloadPreview: errPayload ? JSON.stringify(errPayload).slice(0, 500) : 'unknown',
      });
      const overflowProbe = [errPayload?.code, errPayload?.errorMessage].filter(Boolean).join(' ');
      if (overflowProbe && isContextOverflowError(overflowProbe)) {
        throw new Error(
          String(errPayload?.errorMessage || errPayload?.code || 'context_length_exceeded'),
        );
      }
      const runtimeErrorSignal = hasProviderRuntimeErrorSignal(errPayload);
      if (runtimeErrorSignal) {
        const rawErrorMessage = buildProviderRuntimeErrorMessage(errPayload);
        const surface = classifyProviderError({
          errorMessage: rawErrorMessage,
          status: typeof errPayload?.status === 'number' ? errPayload.status : undefined,
          code: typeof errPayload?.code === 'string' ? errPayload.code : undefined,
          abortReason:
            typeof errPayload?.abortReason === 'string'
              ? (errPayload.abortReason as 'user' | 'server' | 'timeout')
              : undefined,
        });
        throw new PiAiProviderRuntimeError({
          message: rawErrorMessage,
          surface,
        });
      }
      if (errPayload?.content && Array.isArray(errPayload.content)) {
        /**
         * 与 result/done 一致：流式 text_delta 已写入可见正文时，勿再把 error 载荷里的整段 text 追加一遍。
         * 部分 OpenAI 兼容网关（如 Qwen、Doubao 流）在收尾用 type=error 携带完整 assistant 副本 →
         * 否则 content 出现双份相同 text；但仍应合并 toolCall，否则 tool_calls 统计为 0。
         */
        const hasTextInContent = content.some(
          (b) => b.type === 'text' && 'text' in b && (b as { text: string }).text?.trim(),
        );
        const mergeErrBlock = (block: PiErrAssistantBlock) => {
          const bt = block.type ?? '';
          if (bt === 'text' && block.text?.trim()) {
            content.push({ type: 'text', text: block.text });
          } else if (bt === 'thinking' && block.thinking && thinkingChunks) {
            /**
             * Industry-standard separation: thinking from error-payload
             * assistant blocks goes into the thinking channel, not into
             * `content` (which would persist into next-turn context). The
             * legacy `<redacted_thinking>` text-block fallback was removed
             * for the same reason as the live `<think>` fallback above —
             * complete() and stream() always supply `thinkingChunks`.
             */
            thinkingChunks.push(block.thinking);
          } else if (isPiAssistantToolCallBlockType(bt) && block.id && block.name) {
            appendToolUseBlock(content, {
              id: block.id,
              name: block.name,
              arguments: normalizeToolCallArgumentsFromAssistantBlock(
                block,
                this.repairToolCallUrl,
              ),
            });
          }
        };

        if (!hasTextInContent) {
          for (const block of errPayload.content) {
            mergeErrBlock(block);
          }
        } else {
          for (const block of errPayload.content) {
            if (isPiAssistantToolCallBlockType(block.type) && block.id && block.name) {
              mergeErrBlock(block);
            }
          }
        }
      }

      /**
       * Pure provider/runtime errors are not assistant content.
       *
       * Older behavior rendered `classifyProviderError(...)` into a normal text
       * block here. That made post-tool failures look like successful assistant
       * answers and allowed the run to be archived as completed. Keep the raw
       * provider failure on the error path; host callers can map thrown
       * provider errors to their own structured UI payloads.
       */
      const errUsage = errPayload?.usage;
      const hasToolUseAfterErr = content.some((b) => b.type === 'tool_use');
      if (hasToolUseAfterErr) {
        return {
          stopReason: 'tool_use',
          usage: errUsage
            ? { inputTokens: errUsage.input ?? 0, outputTokens: errUsage.output ?? 0 }
            : undefined,
        };
      }
      if (errUsage) {
        return {
          stopReason:
            errPayload?.stopReason === 'toolCall' || errPayload?.stopReason === 'toolUse'
              ? 'tool_use'
              : 'end_turn',
          usage: { inputTokens: errUsage.input ?? 0, outputTokens: errUsage.output ?? 0 },
        };
      }
    }
    return {};
  }

  private convertStreamEvent(event: PiAiStreamEvent): LLMStreamEvent | null {
    const t = event.type;
    if (t === 'text' || t === 'text_delta') {
      const delta = event.delta ?? event.text;
      return delta ? { type: 'content_block_delta', text: delta, deltaRole: 'visible' } : null;
    }
    if (t === 'thinking' || t === 'thinking_delta') {
      const delta = event.delta ?? event.thinking;
      return delta ? { type: 'content_block_delta', text: delta, deltaRole: 'thinking' } : null;
    }
    if (t === 'toolCall' || t === 'toolcall_end') {
      return event.toolCall
        ? {
            type: 'content_block_start',
            toolUse: { id: event.toolCall.id, name: event.toolCall.name },
          }
        : null;
    }
    if (t === 'result' || t === 'done') {
      const sr = event.stopReason ?? event.reason;
      return {
        type: 'message_delta',
        stopReason: sr === 'toolCall' || sr === 'toolUse' ? 'tool_use' : 'end_turn',
      };
    }
    return null;
  }
}
