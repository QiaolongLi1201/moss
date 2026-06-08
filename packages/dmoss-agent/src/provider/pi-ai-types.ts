export {
  EventStream,
} from './event-stream.js';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';

export interface TextContent {
  type: 'text';
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
  filename?: string;
}

export interface ToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface UserMessage {
  role: 'user';
  content: string | Array<TextContent | ImageContent>;
  timestamp: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: Array<TextContent | ThinkingContent | ToolCall>;
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName?: string;
  content: Array<TextContent | ImageContent>;
  isError: boolean;
  timestamp: number;
  details?: unknown;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface Model<TApi extends string = string> {
  api: TApi;
  provider: string;
  id: string;
  name?: string;
  maxTokens?: number;
  baseUrl?: string;
  input?: string[];
  cost?: Partial<Usage['cost']>;
  reasoning?: unknown;
  [key: string]: unknown;
}

export interface Context {
  systemPrompt?: string;
  systemPromptParts?: { stable?: string; dynamic?: string };
  messages: Message[];
  tools?: Array<{
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  }>;
  [key: string]: unknown;
}

export interface SimpleStreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  reasoning?: ThinkingLevel | null;
  onPayload?: (payload: unknown) => void;
  [key: string]: unknown;
}

export interface AssistantMessageEventBase {
  type: string;
  partial?: Partial<AssistantMessage>;
  contentIndex?: number;
  [key: string]: unknown;
}

export type AssistantMessageEvent =
  | (AssistantMessageEventBase & { type: 'text_delta'; delta: string })
  | (AssistantMessageEventBase & { type: 'text_end'; content: string })
  | (AssistantMessageEventBase & { type: 'thinking_delta'; delta: string })
  | (AssistantMessageEventBase & { type: 'thinking_end'; content: string })
  | (AssistantMessageEventBase & { type: 'toolcall_start'; toolCall?: ToolCall })
  | (AssistantMessageEventBase & { type: 'toolcall_delta'; toolCall: ToolCall })
  | (AssistantMessageEventBase & { type: 'toolcall_end'; toolCall: ToolCall })
  | (AssistantMessageEventBase & { type: 'done'; message: AssistantMessage })
  | (AssistantMessageEventBase & { type: 'error'; error: AssistantMessage });

export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
  result(): Promise<AssistantMessage>;
  push(event: AssistantMessageEvent): void;
  end(result?: AssistantMessage): void;
}

export type StreamFunction<
  TApi extends string = string,
  TOptions extends SimpleStreamOptions = SimpleStreamOptions,
> = (
  model: Model<TApi>,
  context: Context,
  options?: TOptions,
) => AssistantMessageEventStream;

// Adapter-specific types (convenience re-exports)
export type { PiAiModelInfo, PiAiStreamEvent } from './pi-ai-wire-format.js';
export type { PiAiStreamFunction, PiAiLLMProviderConfig } from './pi-ai-adapter.js';
