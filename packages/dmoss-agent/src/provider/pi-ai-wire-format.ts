/**
 * pi-ai wire-format conversion — model normalisation, message conversion,
 * error-payload helpers, and tool-call argument repair.
 *
 * Extracted from the monolithic pi-ai-adapter.ts so that adding a new
 * provider only requires importing the pieces it needs.
 */

import type {
  LLMMessage,
  LLMContentBlock,
} from '../core/llm/llm-provider.js';
import { shouldSuppressReasoningForToolFollowUpRound } from '../core/loop/follow-up-guard.js';
import { shouldRoundTripAssistantThinking } from '../core/tools/message-convert.js';

// ============== Types ==============

export interface PiAiModelInfo {
  api: string;
  provider: string;
  id: string;
  baseUrl?: string;
  [key: string]: unknown;
}

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
    /** Some gateways embed full assistant blocks (thinking / text / toolCall) in error events */
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

export type PiErrAssistantBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  /** Doubao streaming tool may end with unclosed JSON; args arrive as string fragments */
  partial?: boolean;
  partialArgs?: string;
};

// ============== Model normalisation ==============

/** pi-ai streaming reads `model.cost.*`; convertMessages reads `model.input.includes(...)`. */
export type PiAiModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number };

const DEFAULT_PI_AI_COST: PiAiModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function mergePiAiModelCost(incoming: unknown): PiAiModelCost {
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
 * Merge caller-supplied model fields with pi-ai runtime requirements
 * so the stream first-event doesn't fail on missing cost / input.
 * Preserves caller values when already present (e.g. buildModelDef).
 */
export function normalizePiAiModelInfo(model: PiAiModelInfo, baseUrl?: string): PiAiModelInfo {
  const merged: PiAiModelInfo = {
    ...model,
    ...(baseUrl ? { baseUrl } : {}),
    cost: mergePiAiModelCost(model.cost),
    input: Array.isArray(model.input) && model.input.length > 0 ? model.input : ['text'],
  };
  return merged;
}

// ============== OAuth guard ==============

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
 * We only guard the `anthropic` API shape; OpenAI-compatible gateways and
 * other providers never see pi-ai's OAuth branch regardless of the token
 * format, so no guard is needed there.
 */
export function rejectAnthropicOAuthToken(apiKey: string, api: string | undefined): void {
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

// ============== Tool-call helpers ==============

export function appendToolUseBlock(
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

/** OpenAI / Doubao: `toolCall` and `tool_call` are equivalent */
export function isPiAssistantToolCallBlockType(type: string | undefined): boolean {
  const n = String(type ?? '')
    .toLowerCase()
    .replace(/_/g, '');
  return n === 'toolcall';
}

export function defaultRepairToolCallUrl(url: string): string {
  return url.trim();
}

/**
 * When the gateway truncates JSON, `arguments` may be empty or incomplete;
 * `partialArgs` contains the unclosed JSON string. Attempt to recover
 * common "open URL" tool calls so the tool_use can still execute.
 */
export function tryParsePartialArgsString(s: string): Record<string, unknown> | null {
  const t = s.trim();
  if (!t) return null;
  try {
    const j = JSON.parse(t) as unknown;
    if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>;
  } catch {
    /* unclosed JSON */
  }
  const m = t.match(/"url"\s*:\s*"([^"]*)/);
  if (m?.[1]) {
    return { url: m[1] };
  }
  return null;
}

export function normalizeToolCallArgumentsFromAssistantBlock(
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

// ============== Error-payload helpers ==============

function isHttpErrorStatus(value: unknown): boolean {
  return typeof value === 'number' && value >= 400;
}

export function extractAssistantBlockThinking(block: PiErrAssistantBlock): string {
  if (typeof block.thinking === 'string' && block.thinking) return block.thinking;
  if ((block.type === 'thinking' || block.type === 'reasoning') && typeof block.text === 'string') {
    return block.text;
  }
  return '';
}

export function extractErrorPayloadText(
  payload: NonNullable<PiAiStreamEvent['error']> | undefined,
): string {
  if (!payload?.content || !Array.isArray(payload.content)) return '';
  return payload.content
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function buildProviderRuntimeErrorMessage(
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

export function hasProviderRuntimeErrorSignal(
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
 * Some pi-ai gateways put the full assistant in `event.error` on
 * `type: error`; others place `role` + `content[]` directly on the
 * event (no `error` key). Normalise so tool-call merging works either way.
 */
export function resolvePiStreamErrorPayload(
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

// ============== Thinking / reasoning helpers ==============

/**
 * Mirrors {@link convertMessages} output: each `tool_result` inside a
 * `user` message becomes a separate `role: 'toolResult'` entry. Checking
 * only "is the last LLMMessage a tool_result" misses cases with multiple
 * sequential tool results or interleaved steering messages. This helper
 * uses the **pi-ai wire format** (matching the upstream gateway) to
 * determine whether we're in the "feeding tool results, awaiting next
 * assistant turn" phase.
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

export function resolveToolFollowReasoningSuppress(
  internalMessages: LLMMessage[] | undefined,
  converted: readonly unknown[],
): boolean {
  if (Array.isArray(internalMessages) && internalMessages.length > 0) {
    if (shouldSuppressReasoningForToolFollowUpRound(internalMessages)) return true;
  }
  return wireConvertedHasToolResultAfterLastAssistant(converted);
}

export function hasThinkingModeConfigured(
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

export function hasProviderNativeThinkingHistory(
  model: PiAiModelInfo,
  providerReasoning: string | null | undefined,
): boolean {
  return hasThinkingModeConfigured(model, providerReasoning, undefined);
}

export function hasAssistantThinkingHistory(messages: LLMMessage[] | undefined): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((msg) =>
    msg.role === 'assistant' &&
    Array.isArray((msg as { thinking?: unknown }).thinking) &&
    (msg as { thinking: unknown[] }).thinking.some((item) => String(item ?? '').trim()),
  );
}

function appendStructuredTextContent(block: { structuredContent?: unknown }, textContent: string): string {
  const structured = block.structuredContent;
  if (!Array.isArray(structured) || structured.length === 0) return textContent;
  const extraText = structured
    .filter((item): item is { type: 'text'; text: string } =>
      item !== null &&
      typeof item === 'object' &&
      (item as { type?: unknown }).type === 'text' &&
      typeof (item as { text?: unknown }).text === 'string',
    )
    .map((item) => item.text)
    .join('\n');
  if (!extraText) return textContent;
  return textContent ? `${textContent}\n${extraText}` : extraText;
}

// ============== Message conversion ==============

/**
 * Convert LLMMessage[] into the pi-ai wire format.
 *
 * - `user` messages with `tool_result` blocks are split into separate
 *   `role: 'toolResult'` entries.
 * - `assistant` messages include thinking blocks when `thinkingMode` is
 *   active (or when round-trip is needed for "must be passed back" gateways).
 */
export function convertMessages(
  messages: LLMMessage[],
  model: PiAiModelInfo,
  thinkingMode: boolean,
): unknown[] {
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
            const textContent = appendStructuredTextContent(block, block.content);
            result.push({
              role: 'toolResult',
              toolCallId: block.tool_use_id,
              toolName: '',
              content: [{ type: 'text', text: textContent }],
              isError: block.is_error ?? false,
            });
          }
        }
      }
    } else if (msg.role === 'assistant') {
      /**
       * OpenAI-compat + thinking (DeepSeek etc.): thinking mode requires
       * the previous assistant's `reasoning_content` to be passed back
       * verbatim or the next turn is 400-rejected. Non-thinking models
       * only round-trip on tool-follow-up turns to avoid feeding UI-playback
       * thinking into normal history.
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
          /** Align with streaming `reasoning_content` / `reasoning` fields; ODC commonly uses the former */
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
          api: model.api,
          provider: model.provider,
          model: model.id,
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
          api: model.api,
          provider: model.provider,
          model: model.id,
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
