/**
 * OpenAILLMProvider — built-in LLM provider for OpenAI-compatible APIs.
 *
 * Uses native `fetch` (no SDK dependency). Supports real SSE streaming.
 * Works with OpenAI, Azure OpenAI, and any OpenAI-compatible endpoint
 * (e.g. DeepSeek, Together AI, Groq, local Ollama with OpenAI compat).
 *
 * Usage:
 *   const provider = new OpenAILLMProvider({
 *     apiKey: process.env.OPENAI_API_KEY,
 *     // baseUrl: 'https://api.deepseek.com',  // for DeepSeek
 *   });
 *   const agent = new DmossAgent({ llmProvider: provider, ... });
 */

import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMContentBlock,
  LLMMessage,
} from '../core/llm/llm-provider.js';
import { DmossError, ErrorCode } from '../errors.js';

export interface OpenAILLMProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: { message?: string; type?: string; code?: string };
}

export class OpenAILLMProvider implements LLMProvider {
  readonly id = 'openai';
  readonly displayName = 'OpenAI';
  readonly capabilities = { streaming: true };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(config: OpenAILLMProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || 'https://api.openai.com').replace(/\/$/, '');
    this.defaultModel = config.defaultModel || 'gpt-4o';
  }

  async complete(opts: LLMRequestOptions): Promise<LLMResponse> {
    return this.stream(opts, () => {});
  }

  async stream(
    opts: LLMRequestOptions,
    onEvent: (event: LLMStreamEvent) => void,
  ): Promise<LLMResponse> {
    const messages = this.convertMessages(opts);

    const body: Record<string, unknown> = {
      model: opts.model || this.defaultModel,
      max_tokens: opts.maxTokens || 4096,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };

    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    }

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts.abortSignal,
    });

    if (!res.ok) {
      const text = await res.text();
      const retryAfter = res.headers.get('retry-after');
      const retryHint = retryAfter ? ` (Retry-After: ${retryAfter})` : '';
      throw new DmossError({ code: ErrorCode.PROVIDER_UPSTREAM_ERROR, message: `OpenAI API error ${res.status}${retryHint}: ${text}` });
    }

    if (!res.body) {
      throw new DmossError({ code: ErrorCode.PROVIDER_UPSTREAM_ERROR, message: 'OpenAI API returned no body' });
    }

    const content: LLMContentBlock[] = [];
    let textBuffer = '';
    const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let stopReason: LLMResponse['stopReason'] = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;
    let sawDone = false;
    let sawFinishReason = false;

    onEvent({ type: 'message_start' });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) return;
      const payload = trimmed.slice(6).trim();
      if (!payload) return;
      if (payload === '[DONE]') {
        sawDone = true;
        return;
      }

      let chunk: OpenAIChunk;
      try {
        chunk = JSON.parse(payload);
      } catch (err) {
        throw new DmossError({
          code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
          message: 'OpenAI provider: malformed SSE JSON frame',
          hint: 'The upstream API or gateway returned an invalid streaming payload.',
          recoverable: true,
          cause: err,
          context: { payload: payload.slice(0, 200) },
        });
      }

      if (chunk.error) {
        const errorType = chunk.error.type ?? 'unknown_error';
        const errorCode = chunk.error.code;
        const errorMessage = chunk.error.message ?? 'OpenAI stream error';
        const label = errorCode ? `${errorType}/${errorCode}` : errorType;
        throw new DmossError({
          code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
          message: `OpenAI stream error ${label}: ${errorMessage}`,
          hint: 'The upstream OpenAI-compatible API returned an error event during streaming.',
          recoverable: true,
          context: { type: errorType, ...(errorCode ? { code: errorCode } : {}) },
        });
      }

      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
      }

      const choice = chunk.choices?.[0];
      if (!choice) return;

      const delta = choice.delta;
      if (delta?.content) {
        textBuffer += delta.content;
        onEvent({ type: 'content_block_delta', text: delta.content, deltaRole: 'visible' });
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCalls.has(idx)) {
            toolCalls.set(idx, {
              id: tc.id || '',
              name: tc.function?.name || '',
              arguments: '',
            });
            if (tc.id) {
              onEvent({
                type: 'content_block_start',
                toolUse: { id: tc.id, name: tc.function?.name || '' },
              });
            }
          }
          const existing = toolCalls.get(idx)!;
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) {
            existing.arguments += tc.function.arguments;
            onEvent({ type: 'content_block_delta', partialJson: tc.function.arguments });
          }
        }
      }

      if (choice.finish_reason) {
        sawFinishReason = true;
        if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use';
        else if (choice.finish_reason === 'length') stopReason = 'max_tokens';
        else if (choice.finish_reason === 'stop') stopReason = 'end_turn';
        onEvent({ type: 'message_delta', stopReason });
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        processLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      processLine(buffer);
    }

    if (!sawDone && !sawFinishReason) {
      throw new DmossError({
        code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
        message: 'OpenAI provider: stream terminated without [DONE] or finish_reason',
        hint: 'The upstream API or gateway closed the SSE stream before a terminal marker.',
        recoverable: true,
      });
    }

    if (textBuffer) {
      content.push({ type: 'text', text: textBuffer });
    }
    for (const [, tc] of toolCalls) {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(tc.arguments);
      } catch (err) {
        throw new DmossError({
          code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
          message: `OpenAI provider: malformed tool call arguments for ${tc.name}`,
          hint: 'The LLM returned invalid JSON for tool parameters. This usually indicates a model or gateway issue.',
          recoverable: true,
          cause: err,
          context: { toolName: tc.name, arguments: tc.arguments.slice(0, 200) },
        });
      }
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
    }

    onEvent({ type: 'message_stop' });

    return {
      content,
      stopReason,
      usage: { inputTokens, outputTokens },
    };
  }

  private convertMessages(opts: LLMRequestOptions): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];

    if (opts.systemPrompt) {
      result.push({ role: 'system', content: opts.systemPrompt });
    }

    for (const m of opts.messages) {
      if (typeof m.content === 'string') {
        result.push({ role: m.role, content: m.content });
      } else if (Array.isArray(m.content)) {
        this.convertContentBlocks(result, m);
      }
    }

    return result;
  }

  private convertContentBlocks(
    result: Array<Record<string, unknown>>,
    m: LLMMessage,
  ): void {
    const blocks = m.content as LLMContentBlock[];
    const textParts: string[] = [];
    const toolCalls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }> = [];

    for (const block of blocks) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      } else if (block.type === 'tool_result') {
        result.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: block.content,
        });
      }
    }

    if (textParts.length > 0 || toolCalls.length > 0) {
      const msg: Record<string, unknown> = {
        role: m.role,
        content: textParts.join('\n') || '',
      };
      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
      }
      result.push(msg);
    }
  }
}
