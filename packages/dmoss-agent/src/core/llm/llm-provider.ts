/**
 * LLM Provider — abstract interface for language model interaction.
 *
 * D-Moss uses this abstraction to decouple from specific LLM SDKs (Anthropic, OpenAI, etc.).
 * Host applications implement this interface to wire in their preferred LLM provider.
 */

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | LLMContentBlock[];
  /**
   * assistant 专用：本拍 stream 的 reasoning/thinking 原文。OpenAI 兼容 + thinking
   * 模式（如 DeepSeek、部分 ODC）会要求下一请求把历史 assistant 的
   * `reasoning_content` 原样带回。非 thinking 模型默认不回灌，仅用于 UI 回放。
   */
  thinking?: string[];
}

export type LLMContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface LLMToolDeclaration {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface LLMStreamEvent {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop';
  /** For text deltas */
  text?: string;
  /**
   * `content_block_delta` only: provider-native reasoning channel (e.g. pi-ai Qwen `thinking_delta`).
   * Hosts must surface as thinking/reasoning, not run through inline `<thinking>` tag parsing.
   */
  deltaRole?: 'thinking' | 'visible';
  /** For tool_use start */
  toolUse?: { id: string; name: string };
  /** For tool_use input delta (partial JSON) */
  partialJson?: string;
  /** For message_delta: stop reason */
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}

export interface LLMRequestOptions {
  model: string;
  systemPrompt: string;
  messages: LLMMessage[];
  tools?: LLMToolDeclaration[];
  maxTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  /**
   * 覆盖本请求是否启用 pi-ai `reasoning`（thinking 网关参数）。
   * - 未设置：使用 `PiAiLLMProvider` 构造时的默认 reasoning。
   * - `null`：本请求**不**传 reasoning（工具回调轮次兼容部分 OpenAI 兼容网关）。
   */
  reasoning?: string | null;
}

export interface LLMResponse {
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  content: LLMContentBlock[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /**
   * Provider-native reasoning channel — concatenable chunks that mirror the
   * live `LLMStreamEvent.deltaRole === 'thinking'` events.
   *
   * Industry-standard separation (Anthropic `thinking` blocks, OpenAI
   * Responses `reasoning` items, DeepSeek/Qwen `reasoning_content`):
   * thinking is **never** folded into `content` as a synthetic
   * `<think>...</think>` text block. Hosts that want to surface the
   * reasoning UI consume `thinking` directly; hosts that don't care can
   * ignore it. Either way it does not pollute persisted assistant turns
   * (which would otherwise be sent back to the upstream model on the next
   * round and cause runaway reasoning).
   *
   * Optional: providers that don't expose a separate reasoning channel
   * (e.g. classic chat completions without a thinking mode) leave this
   * undefined.
   */
  thinking?: string[];
}

/**
 * Abstract LLM provider interface.
 *
 * Implementations:
 * - AnthropicProvider (Anthropic Claude API)
 * - OpenAIProvider (OpenAI GPT API)
 * - etc.
 */
export interface LLMProvider {
  readonly id: string;
  readonly displayName: string;

  /** Non-streaming completion */
  complete(options: LLMRequestOptions): Promise<LLMResponse>;

  /** Streaming completion — yields events for real-time UI updates */
  stream(
    options: LLMRequestOptions,
    onEvent: (event: LLMStreamEvent) => void,
  ): Promise<LLMResponse>;

  /** Count tokens in text (for context window management) */
  countTokens?(text: string): Promise<number>;
}
