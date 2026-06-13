import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context as PiContext,
  Message as PiMessage,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  ToolCall as PiToolCall,
  Usage,
} from '../../provider/pi-ai-types.js';
import type {
  LLMContentBlock,
  LLMMessage,
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMSystemPromptParts,
  LLMToolDeclaration,
} from './llm-provider.js';
import { describeError } from '../../provider/errors.js';
import { createAssistantMessageEventStream } from '../../provider/event-stream.js';
import {
  createInlineThinkingRouter,
  splitThinkingTagsFromAssistantText,
  type InlineThinkingRouter,
} from './inline-thinking-stream.js';

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function mapPiMessagesToLlm(messages: PiMessage[]): LLMMessage[] {
  const result: LLMMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else {
        result.push({
          role: 'user',
          content: msg.content
            .filter((block) => block.type === 'text' || block.type === 'image')
            .map((block): LLMContentBlock => (
              block.type === 'image'
                ? { type: 'image', data: block.data, mimeType: block.mimeType }
                : { type: 'text', text: block.text }
            )),
        });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const thinking = msg.content
        .filter((block) => block.type === 'thinking')
        .map((block) => block.thinking)
        .filter(Boolean);
      const content: LLMContentBlock[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text });
        } else if (block.type === 'toolCall') {
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.arguments ?? {},
          });
        }
      }
      result.push({
        role: 'assistant',
        content,
        ...(thinking.length > 0 ? { thinking } : {}),
      });
      continue;
    }

    result.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: msg.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join(''),
          is_error: msg.isError,
        },
      ],
    });
  }

  return result;
}

function mapPiToolsToLlm(tools: PiContext['tools'] | undefined): LLMToolDeclaration[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: (tool.parameters && typeof tool.parameters === 'object'
      ? tool.parameters
      : {}) as unknown as LLMToolDeclaration['input_schema'],
  }));
}

function mapStopReason(reason: LLMResponse['stopReason']): AssistantMessage['stopReason'] {
  if (reason === 'tool_use') return 'toolUse';
  if (reason === 'max_tokens') return 'length';
  return 'stop';
}

function mapDoneReason(
  reason: AssistantMessage['stopReason'],
): 'stop' | 'length' | 'toolUse' {
  if (reason === 'toolUse' || reason === 'length') return reason;
  return 'stop';
}

function mapUsage(usage: LLMResponse['usage'] | undefined): Usage {
  if (!usage) return EMPTY_USAGE;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheCreationTokens ?? 0;
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead,
    cacheWrite,
    totalTokens: usage.inputTokens + usage.outputTokens + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function readSystemPromptParts(context: PiContext): LLMSystemPromptParts | undefined {
  const raw = (context as PiContext & { systemPromptParts?: unknown }).systemPromptParts;
  if (!raw || typeof raw !== 'object') return undefined;
  const parts = raw as { stable?: unknown; dynamic?: unknown };
  if (typeof parts.stable !== 'string' || typeof parts.dynamic !== 'string') {
    return undefined;
  }
  return { stable: parts.stable, dynamic: parts.dynamic };
}

interface ForwardState {
  inlineThinking: InlineThinkingRouter;
  sawVisibleDelta: boolean;
  sawThinkingDelta: boolean;
}

function createForwardState(): ForwardState {
  return {
    inlineThinking: createInlineThinkingRouter(),
    sawVisibleDelta: false,
    sawThinkingDelta: false,
  };
}

function normalizeInlineThinkingInResponse(response: LLMResponse): LLMResponse {
  const thinking = [...(response.thinking ?? [])];
  const content: LLMContentBlock[] = [];

  for (const block of response.content) {
    if (block.type !== 'text') {
      content.push(block);
      continue;
    }
    const split = splitThinkingTagsFromAssistantText(block.text);
    thinking.push(...split.thinkingBodies);
    if (split.visible) content.push({ type: 'text', text: split.visible });
  }

  return {
    ...response,
    content,
    ...(thinking.length > 0 ? { thinking } : { thinking: undefined }),
  };
}

function createAssistantMessage(
  model: Model<any>,
  response: LLMResponse,
): AssistantMessage {
  const content: AssistantMessage['content'] = [];
  for (const chunk of response.thinking ?? []) {
    if (chunk) content.push({ type: 'thinking', thinking: chunk });
  }
  for (const block of response.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      content.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: block.input,
      });
    }
  }
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: mapUsage(response.usage),
    stopReason: mapStopReason(response.stopReason),
    timestamp: Date.now(),
  };
}

function emitFinalResponseEvents(
  stream: AssistantMessageEventStream,
  response: LLMResponse,
  state: ForwardState,
): void {
  let contentIndex = 0;
  if (!state.sawThinkingDelta) {
    for (const thinking of response.thinking ?? []) {
      if (!thinking) continue;
      stream.push({ type: 'thinking_delta', contentIndex, delta: thinking, partial: {} as AssistantMessage });
      stream.push({ type: 'thinking_end', contentIndex, content: thinking, partial: {} as AssistantMessage });
      contentIndex++;
    }
  } else {
    contentIndex += (response.thinking ?? []).filter(Boolean).length;
  }
  for (const block of response.content) {
    if (block.type === 'text') {
      stream.push({ type: 'text_end', contentIndex, content: block.text, partial: {} as AssistantMessage });
      contentIndex++;
    } else if (block.type === 'tool_use') {
      const toolCall: PiToolCall = {
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: block.input,
      };
      stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: {} as AssistantMessage });
      contentIndex++;
    }
  }
}

function forwardProviderEvent(
  stream: AssistantMessageEventStream,
  event: LLMStreamEvent,
  state: ForwardState,
): void {
  if (event.type === 'content_block_delta' && event.text) {
    if (event.deltaRole === 'thinking') {
      state.sawThinkingDelta = true;
      stream.push({
        type: 'thinking_delta',
        contentIndex: 0,
        delta: event.text,
        partial: {} as AssistantMessage,
      });
      return;
    }

    const routed = state.inlineThinking.push(event.text);
    for (const delta of routed.thinking) {
      state.sawThinkingDelta = true;
      stream.push({
        type: 'thinking_delta',
        contentIndex: 0,
        delta,
        partial: {} as AssistantMessage,
      });
    }
    for (const delta of routed.message) {
      state.sawVisibleDelta = true;
      stream.push({
        type: 'text_delta',
        contentIndex: 0,
        delta,
        partial: {} as AssistantMessage,
      });
    }
  }
}

function flushForwardState(stream: AssistantMessageEventStream, state: ForwardState): void {
  const tail = state.inlineThinking.end();
  for (const delta of tail.thinking) {
    state.sawThinkingDelta = true;
    stream.push({
      type: 'thinking_delta',
      contentIndex: 0,
      delta,
      partial: {} as AssistantMessage,
    });
  }
  for (const delta of tail.message) {
    state.sawVisibleDelta = true;
    stream.push({
      type: 'text_delta',
      contentIndex: 0,
      delta,
      partial: {} as AssistantMessage,
    });
  }
}

export interface LlmProviderStreamAdapterOptions {
  provider: LLMProvider;
  onProviderEvent?: (event: LLMStreamEvent) => void;
  onRequest?: (request: LLMRequestOptions) => void | Promise<void>;
  onResponse?: (response: LLMResponse) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

export function createStreamFunctionFromLlmProvider(
  options: LlmProviderStreamAdapterOptions,
): StreamFunction {
  return (model, context, streamOptions?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        const forwardState = createForwardState();
        const piContext = context as PiContext;
        const request: LLMRequestOptions = {
          model: model.id,
          systemPrompt: String(piContext.systemPrompt ?? ''),
          systemPromptParts: readSystemPromptParts(piContext),
          messages: mapPiMessagesToLlm(piContext.messages ?? []),
          tools: mapPiToolsToLlm(piContext.tools),
          maxTokens: streamOptions?.maxTokens,
          temperature: streamOptions?.temperature,
          abortSignal: streamOptions?.signal,
          reasoning: streamOptions?.reasoning ?? undefined,
        };
        await options.onRequest?.(request);
        const supportsStreaming = options.provider.capabilities?.streaming !== false;
        const response = supportsStreaming
          ? await options.provider.stream(request, (event) => {
              options.onProviderEvent?.(event);
              forwardProviderEvent(stream, event, forwardState);
            })
          : await options.provider.complete(request);
        if (response.incomplete) {
          throw new Error(`LLM stream incomplete: ${response.incomplete.reason}`);
        }
        await options.onResponse?.(response);
        flushForwardState(stream, forwardState);
        const normalizedResponse = normalizeInlineThinkingInResponse(response);
        const assistant = createAssistantMessage(model, normalizedResponse);
        emitFinalResponseEvents(stream, normalizedResponse, forwardState);
        stream.push({
          type: 'done',
          reason: mapDoneReason(assistant.stopReason),
          message: assistant,
        });
        stream.end(assistant);
      } catch (err) {
        try {
          await options.onError?.(err);
        } catch (hookErr) {
          // If the onError hook itself throws, log it but don't let it prevent
          // the stream from reporting the original error and ending properly.
          console.warn(
            `[llm-provider-stream-adapter] onError hook threw: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        }
        const assistant: AssistantMessage = {
          role: 'assistant',
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: EMPTY_USAGE,
          stopReason: 'error',
          errorMessage: describeError(err),
          timestamp: Date.now(),
        };
        stream.push({ type: 'error', reason: 'error', error: assistant });
        stream.end(assistant);
      }
    })();
    return stream;
  };
}
