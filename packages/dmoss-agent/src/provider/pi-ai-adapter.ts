/**
 * pi-ai LLM Provider adapter — bridges pi-ai-compatible stream functions to
 * the D-Moss LLMProvider interface.
 *
 * This is the slim orchestrator that composes:
 * - `pi-ai-wire-format.ts` — message conversion, model normalisation, helpers
 * - `pi-ai-stream-parser.ts` — stream event processing and error classification
 * - `pi-ai-watchdog.ts` — first-event timeout management
 *
 * Usage:
 * ```ts
 * import { streamSimple, registerBuiltInApiProviders } from 'your-pi-ai-compatible-package';
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
  LLMContentBlock,
  LLMSystemPromptParts,
} from '../core/llm/llm-provider.js';
import { envPreferDmoss } from '../utils/env-compat.js';
import { getRootLogger } from '../logger.js';
import {
  convertMessages,
  defaultRepairToolCallUrl,
  hasAssistantThinkingHistory,
  hasProviderNativeThinkingHistory,
  hasThinkingModeConfigured,
  normalizePiAiModelInfo,
  rejectAnthropicOAuthToken,
  resolveToolFollowReasoningSuppress,
  type PiAiModelInfo,
  type PiAiStreamEvent,
} from './pi-ai-wire-format.js';
import { processEvent, convertStreamEvent } from './pi-ai-stream-parser.js';
import {
  PiAiFirstEventTimeoutError,
  startFirstEventWatchdog,
} from './pi-ai-watchdog.js';

const log = getRootLogger().child('provider:pi-ai');

const DEFAULT_ANTHROPIC_CACHE_CONTROL = { type: 'ephemeral' } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function buildAnthropicSplitSystemBlocks(
  parts: LLMSystemPromptParts,
  cacheControl: unknown,
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [
    {
      type: 'text',
      text: parts.stable,
      cache_control: cacheControl,
    },
  ];
  if (parts.dynamic) {
    blocks.push({ type: 'text', text: parts.dynamic });
  }
  return blocks;
}

function applyAnthropicSystemPromptPartsToPayload(
  payload: unknown,
  systemPrompt: string,
  parts?: LLMSystemPromptParts,
): void {
  if (!parts?.stable || !isRecord(payload)) return;
  const system = payload.system;

  if (typeof system === 'string') {
    if (system !== systemPrompt) return;
    payload.system = buildAnthropicSplitSystemBlocks(
      parts,
      DEFAULT_ANTHROPIC_CACHE_CONTROL,
    );
    return;
  }

  if (!Array.isArray(system)) return;
  const targetIndex = system.findIndex(
    (block) => isRecord(block) && block.type === 'text' && block.text === systemPrompt,
  );
  if (targetIndex < 0) return;

  const targetBlock = system[targetIndex];
  const cacheControl =
    isRecord(targetBlock) && targetBlock.cache_control !== undefined
      ? targetBlock.cache_control
      : DEFAULT_ANTHROPIC_CACHE_CONTROL;
  system.splice(
    targetIndex,
    1,
    ...buildAnthropicSplitSystemBlocks(parts, cacheControl),
  );
}

// Re-export types that were previously defined in this file
export { PiAiFirstEventTimeoutError } from './pi-ai-watchdog.js';
export type { PiAiModelInfo, PiAiStreamEvent } from './pi-ai-wire-format.js';

/**
 * Minimal pi-ai StreamFunction signature — avoids hard dependency on pi-ai
 * types so the adapter can work with any compatible stream function.
 */
export type PiAiStreamFunction = (
  model: PiAiModelInfo,
  context: unknown,
  options?: Record<string, unknown>,
) => AsyncIterable<PiAiStreamEvent>;

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
   * Tool-follow-up rounds only suppress new `reasoning_effort`; the model's
   * reasoning marker must stay so OpenAI-compat gateways can serialise
   * the previous assistant's `reasoning_content` — without it, some
   * gateways reject the turn as "must be passed back".
   *
   * `toolFollowSuppress` comes from {@link resolveToolFollowReasoningSuppress}
   * (wire-format + structural heuristic double-check).
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
     * Always pass a `thinkingChunks` array — `processEvent` routes
     * `thinking` / `thinking_delta` events into it instead of synthesising
     * a `<think>...</think>` text block in `content`. The accumulated
     * thinking is surfaced via `LLMResponse.thinking`.
     */
    const thinkingChunks: string[] = [];
    let stopReason: LLMResponse['stopReason'] = 'end_turn';
    let usage: NonNullable<LLMResponse['usage']> = { inputTokens: 0, outputTokens: 0 };

    const requestThinkingMode = hasThinkingModeConfigured(
      this.model,
      this.reasoning,
      options.reasoning,
    );
    let convertedMessages = convertMessages(options.messages, this.model, requestThinkingMode);
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
      convertedMessages = convertMessages(options.messages, this.model, true);
    }
    const piContext = this.buildPiContext(options, convertedMessages);
    const watchdog = startFirstEventWatchdog(options.abortSignal, this.model);
    const piOptions = this.buildPiOptions(options, watchdog.signal, toolFollowSuppress);
    const piModel = this.buildPiModelForCall(options, toolFollowSuppress);

    try {
      for await (const event of this.streamFn(piModel, piContext, piOptions)) {
        watchdog.onActivity();
        const parsed = processEvent(event, content, this.repairToolCallUrl, thinkingChunks);
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
    let usage: NonNullable<LLMResponse['usage']> = { inputTokens: 0, outputTokens: 0 };
    let incomplete: LLMResponse['incomplete'] | undefined;

    const requestThinkingMode = hasThinkingModeConfigured(
      this.model,
      this.reasoning,
      options.reasoning,
    );
    let convertedMessages = convertMessages(options.messages, this.model, requestThinkingMode);
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
      convertedMessages = convertMessages(options.messages, this.model, true);
    }
    const piContext = this.buildPiContext(options, convertedMessages);
    const watchdog = startFirstEventWatchdog(options.abortSignal, this.model);
    const piOptions = this.buildPiOptions(options, watchdog.signal, toolFollowSuppress);
    const piModel = this.buildPiModelForCall(options, toolFollowSuppress);

    /** Set to `1` / `true` to log a JSON summary after stream completion (debug: "only prose, no tool") */
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
        const llmEvent = convertStreamEvent(event);
        if (llmEvent) onEvent(llmEvent);

        const parsed = processEvent(event, content, this.repairToolCallUrl, thinkingChunks);
        if (parsed.stopReason) stopReason = parsed.stopReason;
        if (parsed.usage) usage = parsed.usage;
      }
    } catch (err) {
      const translated = watchdog.translateError(err);
      /**
       * First-event timeout / user abort must be re-thrown —
       * they aren't "model produced incomplete output" but "we stopped
       * the upstream", and the outer retry / run flow needs the raw error.
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
     *   2) makes upstream behaviour drift from other tool-capable reasoning models, where
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
      // Only throw when no useful content was produced; otherwise return partial result
      const hasVisibleContent = content.length > 0;
      if (!hasVisibleContent) {
        throw streamError;
      }
      log.warn('returning partial content after mid-stream error', {
        error: streamError.message,
        model: this.model.id,
        contentBlocks: content.length,
      });
      incomplete = { reason: streamError.message };
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
      ...(incomplete ? { incomplete } : {}),
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
      ...(options.systemPromptParts ? { systemPromptParts: options.systemPromptParts } : {}),
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
     * OpenAI compat: `tool_choice` can force at least one function call
     * (`required`). Only used to debug "model writes plans, protocol never
     * sees tool_calls"; enabling globally breaks pure-chat turns, so default
     * is unset.
     * @see https://platform.openai.com/docs/api-reference/chat/create#chat-create-tool_choice
     */
    const tcRaw = envPreferDmoss('DMOSS_PI_AI_TOOL_CHOICE', 'PI_AI_TOOL_CHOICE');
    const toolChoice =
      tcRaw === 'required' || tcRaw === 'auto' || tcRaw === 'none' ? tcRaw : undefined;

    /**
     * The watchdog merges the caller's abortSignal with its internal timeout
     * signal; if no watchdog is active, fall back to options.abortSignal.
     * pi-ai versions/providers use different abort field names
     * (signal / abortSignal), so both keys are set for compatibility.
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
    const onPayload = options.systemPromptParts
      ? (payload: unknown) => {
          applyAnthropicSystemPromptPartsToPayload(
            payload,
            options.systemPrompt,
            options.systemPromptParts,
          );
        }
      : undefined;

    return {
      apiKey: this.apiKey,
      ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
      ...(reasoningForPi ? { reasoning: reasoningForPi } : {}),
      maxTokens: options.maxTokens ?? 4096,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(effectiveSignal ? { abortSignal: effectiveSignal, signal: effectiveSignal } : {}),
      ...(toolChoice ? { toolChoice } : {}),
      ...(onPayload ? { onPayload } : {}),
    };
  }
}
