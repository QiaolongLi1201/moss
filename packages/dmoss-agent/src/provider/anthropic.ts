/**
 * AnthropicLLMProvider — built-in LLM provider for Anthropic Claude API.
 *
 * Uses native `fetch` (no SDK dependency). Supports real SSE streaming.
 *
 * Usage:
 *   const provider = new AnthropicLLMProvider({ apiKey: process.env.ANTHROPIC_API_KEY });
 *   const agent = new DmossAgent({ llmProvider: provider, ... });
 */

import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMContentBlock,
} from '../core/llm/llm-provider.js';
import { DmossError, ErrorCode } from '../errors.js';

export interface AnthropicLLMProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

interface AnthropicSseEvent {
  type: string;
  index?: number;
  delta?: Record<string, unknown>;
  content_block?: Record<string, unknown>;
  message?: Record<string, unknown>;
  usage?: Record<string, number>;
}

export class AnthropicLLMProvider implements LLMProvider {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic Claude';
  readonly capabilities = { streaming: true };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(config: AnthropicLLMProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    this.defaultModel = config.defaultModel || 'claude-sonnet-4-20250514';
  }

  async complete(opts: LLMRequestOptions): Promise<LLMResponse> {
    return this.stream(opts, () => {});
  }

  async stream(
    opts: LLMRequestOptions,
    onEvent: (event: LLMStreamEvent) => void,
  ): Promise<LLMResponse> {
    const body = {
      model: opts.model || this.defaultModel,
      max_tokens: opts.maxTokens || 4096,
      system: opts.systemPrompt,
      messages: opts.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      tools: opts.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
      stream: true,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: opts.abortSignal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new DmossError({ code: ErrorCode.PROVIDER_UPSTREAM_ERROR, message: `Anthropic API error ${res.status}: ${text}` });
    }

    if (!res.body) {
      throw new DmossError({ code: ErrorCode.PROVIDER_UPSTREAM_ERROR, message: 'Anthropic API returned no body' });
    }

    const content: LLMContentBlock[] = [];
    const thinking: string[] = [];
    let stopReason: LLMResponse['stopReason'] = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;
    let currentTextBlock = -1;
    let currentToolBlock = -1;
    let toolInputJson = '';

    onEvent({ type: 'message_start' });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;

        let event: AnthropicSseEvent;
        try {
          event = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        switch (event.type) {
          case 'message_start': {
            const usage = event.message?.usage as Record<string, number> | undefined;
            if (usage) {
              inputTokens = usage.input_tokens ?? 0;
            }
            break;
          }

          case 'content_block_start': {
            const block = event.content_block;
            if (block?.type === 'text') {
              currentTextBlock = event.index ?? content.length;
              content.push({ type: 'text', text: '' });
              onEvent({ type: 'content_block_start', toolUse: undefined });
            } else if (block?.type === 'tool_use') {
              currentToolBlock = event.index ?? content.length;
              content.push({
                type: 'tool_use',
                id: String(block.id || ''),
                name: String(block.name || ''),
                input: {},
              });
              toolInputJson = '';
              onEvent({
                type: 'content_block_start',
                toolUse: { id: String(block.id || ''), name: String(block.name || '') },
              });
            }
            break;
          }

          case 'content_block_delta': {
            const delta = event.delta;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              const idx = event.index ?? currentTextBlock;
              if (idx >= 0 && idx < content.length && content[idx]?.type === 'text') {
                (content[idx] as { type: 'text'; text: string }).text += delta.text;
                onEvent({ type: 'content_block_delta', text: delta.text, deltaRole: 'visible' });
              }
            } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              toolInputJson += delta.partial_json;
              onEvent({ type: 'content_block_delta', partialJson: delta.partial_json });
            } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              onEvent({ type: 'content_block_delta', text: delta.thinking, deltaRole: 'thinking' });
              thinking.push(delta.thinking);
            }
            break;
          }

          case 'content_block_stop': {
            if (currentToolBlock >= 0 && currentToolBlock < content.length) {
              const block = content[currentToolBlock];
              if (block?.type === 'tool_use' && toolInputJson) {
                try {
                  (block as { type: 'tool_use'; input: Record<string, unknown> }).input = JSON.parse(toolInputJson);
                } catch {
                  /* keep empty */
                }
              }
            }
            onEvent({ type: 'content_block_stop' });
            currentTextBlock = -1;
            currentToolBlock = -1;
            toolInputJson = '';
            break;
          }

          case 'message_delta': {
            const delta = event.delta;
            if (delta?.stop_reason) {
              const sr = String(delta.stop_reason);
              if (sr === 'tool_use') stopReason = 'tool_use';
              else if (sr === 'max_tokens') stopReason = 'max_tokens';
              else if (sr === 'stop_sequence') stopReason = 'stop_sequence';
              else stopReason = 'end_turn';
            }
            const usage = event.usage;
            if (usage) {
              outputTokens = usage.output_tokens ?? 0;
            }
            onEvent({ type: 'message_delta', stopReason });
            break;
          }

          case 'message_stop':
            onEvent({ type: 'message_stop' });
            break;
        }
      }
    }

    return {
      content,
      stopReason,
      usage: { inputTokens, outputTokens },
      ...(thinking.length > 0 ? { thinking } : {}),
    };
  }
}
