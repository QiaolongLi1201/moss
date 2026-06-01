import { API_KEY, MODEL, BASE_URL, PROVIDER, type CliProviderPreset } from './config.js';
import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMContentBlock,
} from '../core/llm/llm-provider.js';

export interface CliProviderRuntimeConfig {
  provider: CliProviderPreset;
  apiKey: string;
  model: string;
  baseUrl: string;
}

interface AnthropicResponse {
  content: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export function createCliProvider(config: CliProviderRuntimeConfig): LLMProvider {
  return {
    id: 'cli-provider',
    displayName: 'CLI LLM Provider',
    capabilities: { streaming: false },

    async complete(opts: LLMRequestOptions): Promise<LLMResponse> {
      return this.stream(opts, () => {});
    },

    async stream(
      opts: LLMRequestOptions,
      onEvent: (e: LLMStreamEvent) => void,
    ): Promise<LLMResponse> {
      if (config.provider === 'anthropic') {
        return callAnthropic(config, opts, onEvent);
      }
      return callOpenAI(config, opts, onEvent);
    },
  };
}

export const cliProvider: LLMProvider = createCliProvider({
  provider: PROVIDER,
  apiKey: API_KEY,
  model: MODEL,
  baseUrl: BASE_URL,
});

function providerError(provider: string, status: number, text: string): Error {
  const compact = text.replace(/\s+/g, ' ').trim();
  const preview = compact.length > 800 ? `${compact.slice(0, 800)}...` : compact;
  return new Error(`${provider} provider returned HTTP ${status}: ${preview || '(empty response body)'}`);
}

async function callAnthropic(
  config: CliProviderRuntimeConfig,
  opts: LLMRequestOptions,
  _onEvent: (e: LLMStreamEvent) => void,
): Promise<LLMResponse> {
  const body = {
    model: opts.model || config.model,
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
    stream: false,
  };

  const res = await fetch(`${config.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: opts.abortSignal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw providerError('Anthropic', res.status, text);
  }

  const data: AnthropicResponse = (await res.json()) as AnthropicResponse;
  const content: LLMContentBlock[] = (data.content || []).map((b) => {
    if (b.type === 'text') return { type: 'text' as const, text: b.text ?? '' };
    if (b.type === 'tool_use')
      return {
        type: 'tool_use' as const,
        id: b.id ?? '',
        name: b.name ?? '',
        input: b.input ?? {},
      };
    return { type: 'text' as const, text: '' };
  });

  return {
    content,
    stopReason: data.stop_reason as LLMResponse['stopReason'],
    usage: data.usage
      ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens }
      : undefined,
  };
}

async function callOpenAI(
  config: CliProviderRuntimeConfig,
  opts: LLMRequestOptions,
  _onEvent: (e: LLMStreamEvent) => void,
): Promise<LLMResponse> {
  const openaiMessages: Array<Record<string, unknown>> = [];

  if (opts.systemPrompt) {
    openaiMessages.push({ role: 'system', content: opts.systemPrompt });
  }

  for (const m of opts.messages) {
    if (typeof m.content === 'string') {
      openaiMessages.push({ role: m.role, content: m.content });
    } else if (Array.isArray(m.content)) {
      const textParts: string[] = [];
      const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];

      for (const block of m.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        } else if (block.type === 'tool_result') {
          openaiMessages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: block.content,
          });
        }
      }

      if (textParts.length > 0 || toolCalls.length > 0) {
        const msg: Record<string, unknown> = { role: m.role };
        if (textParts.length > 0) {
          msg.content = textParts.join('\n');
        } else {
          msg.content = '';
        }
        if (toolCalls.length > 0) {
          msg.tool_calls = toolCalls;
        }
        openaiMessages.push(msg);
      }
    }
  }

  const body: Record<string, unknown> = {
    model: opts.model || config.model,
    max_tokens: opts.maxTokens || 4096,
    messages: openaiMessages,
  };

  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }

  const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.abortSignal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw providerError('OpenAI-compatible', res.status, text);
  }

  const data: OpenAIResponse = (await res.json()) as OpenAIResponse;
  const choice = data.choices?.[0];
  const content: LLMContentBlock[] = [];

  if (choice?.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch (err) {
        console.warn(
          `[cli-provider] Failed to parse tool call arguments for ${tc.function.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        input = {};
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  return {
    content,
    stopReason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    usage: data.usage
      ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
      : undefined,
  };
}
