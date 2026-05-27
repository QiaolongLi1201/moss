/**
 * pi-ai stream event parser — converts pi-ai stream events into the
 * D-Moss LLM content model, handles error classification, and maps
 * events to LLMStreamEvent for live streaming.
 *
 * Extracted from the monolithic pi-ai-adapter.ts.
 */

import type {
  LLMResponse,
  LLMStreamEvent,
  LLMContentBlock,
} from '../core/llm/llm-provider.js';
import { getRootLogger } from '../logger.js';
import { classifyProviderError } from './error-classify.js';
import { isContextOverflowError } from './errors.js';
import {
  appendToolUseBlock,
  buildProviderRuntimeErrorMessage,
  extractAssistantBlockThinking,
  hasProviderRuntimeErrorSignal,
  isPiAssistantToolCallBlockType,
  normalizeToolCallArgumentsFromAssistantBlock,
  resolvePiStreamErrorPayload,
  type PiAiStreamEvent,
  type PiErrAssistantBlock,
} from './pi-ai-wire-format.js';

const log = getRootLogger().child('provider:pi-ai');

class PiAiProviderRuntimeError extends Error {
  readonly surface: import('./error-classify.js').ProviderErrorSurface;

  constructor(params: { message: string; surface: import('./error-classify.js').ProviderErrorSurface }) {
    super(params.message || params.surface.userMessage || 'Provider runtime error');
    this.name = 'PiAiProviderRuntimeError';
    this.surface = params.surface;
  }
}

/**
 * Process a single pi-ai stream event, mutating `content` and
 * `thinkingChunks` in place and returning any stop-reason / usage
 * extracted from terminal events.
 */
export function processEvent(
  event: PiAiStreamEvent,
  content: LLMContentBlock[],
  repairToolCallUrl: (url: string) => string,
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
        repairToolCallUrl,
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
                repairToolCallUrl,
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
                repairToolCallUrl,
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
       * Align with result/done: if streaming text_delta already wrote
       * visible text, don't duplicate the error-payload text. Some
       * OpenAI-compat gateways (Qwen, Doubao) send a final type=error
       * with a full assistant copy — still merge toolCalls though,
       * otherwise tool_calls count stays at 0.
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
           * `content` (which would persist into next-turn context).
           */
          thinkingChunks.push(block.thinking);
        } else if (isPiAssistantToolCallBlockType(bt) && block.id && block.name) {
          appendToolUseBlock(content, {
            id: block.id,
            name: block.name,
            arguments: normalizeToolCallArgumentsFromAssistantBlock(
              block,
              repairToolCallUrl,
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

/**
 * Map a pi-ai stream event to an LLMStreamEvent for live streaming.
 * Returns null for events that don't produce a stream-level signal.
 */
export function convertStreamEvent(event: PiAiStreamEvent): LLMStreamEvent | null {
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
