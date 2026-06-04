import type { ChatResult, DmossAgentEvent } from '../core/index.js';

export type HeadlessOutputFormat = 'text' | 'json' | 'stream-json';

export type HeadlessSystemInitEvent = {
  type: 'system';
  subtype: 'init';
  cwd: string;
  tools: string[];
  session_id: string;
  model?: string;
};

export type HeadlessAssistantEvent = {
  type: 'assistant';
  message: {
    role: 'assistant';
    content: Array<{ type: 'text'; text: string }>;
  };
  session_id: string;
};

export type HeadlessToolUseEvent = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  session_id: string;
};

export type HeadlessToolResultEvent = {
  type: 'tool_result';
  tool_use_id: string;
  is_error: boolean;
  content: string;
  session_id: string;
  structured_content?: unknown;
};

export type HeadlessResultEvent = {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  result: string;
  num_turns: number;
  session_id: string;
  usage?: ChatResult['usage'];
  error?: string;
};

export type HeadlessStreamEvent =
  | HeadlessSystemInitEvent
  | HeadlessAssistantEvent
  | HeadlessToolUseEvent
  | HeadlessToolResultEvent
  | HeadlessResultEvent;

export interface HeadlessInitInput {
  cwd: string;
  model?: string;
  tools: string[];
  sessionId: string;
}

export interface HeadlessPrintState {
  readonly sessionId: string;
  pendingAssistantText: string;
  finalText: string;
  numTurns: number;
  lastError?: string;
  resultEmitted: boolean;
}

export interface HeadlessPrintStateInput {
  sessionId: string;
}

export interface HeadlessJsonWriter {
  write(chunk: string): unknown;
}

export function createHeadlessPrintState(input: HeadlessPrintStateInput): HeadlessPrintState {
  return {
    sessionId: input.sessionId,
    pendingAssistantText: '',
    finalText: '',
    numTurns: 0,
    resultEmitted: false,
  };
}

export function formatHeadlessInitEvent(input: HeadlessInitInput): HeadlessSystemInitEvent {
  const event: HeadlessSystemInitEvent = {
    type: 'system',
    subtype: 'init',
    cwd: input.cwd,
    tools: input.tools,
    session_id: input.sessionId,
  };
  if (input.model) event.model = input.model;
  return event;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; errorMessage?: unknown };
    if (typeof record.errorMessage === 'string') return record.errorMessage;
    if (typeof record.message === 'string') return record.message;
  }
  return String(error);
}

function isErrorStopReason(stopReason: string | undefined): boolean {
  return stopReason === 'error' ||
    stopReason === 'max_turns_reached' ||
    stopReason === 'tool_followup_cap_reached' ||
    stopReason === 'aborted_by_user';
}

function flushAssistant(state: HeadlessPrintState): HeadlessAssistantEvent[] {
  if (!state.pendingAssistantText) return [];
  const text = state.pendingAssistantText;
  state.pendingAssistantText = '';
  return [{
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    session_id: state.sessionId,
  }];
}

function formatResult(
  state: HeadlessPrintState,
  result: ChatResult | undefined,
  error?: string,
): HeadlessResultEvent {
  const resultText = result?.response ?? state.finalText;
  const errorMessage = error ?? state.lastError;
  const isError = Boolean(errorMessage) || isErrorStopReason(result?.stopReason);
  const event: HeadlessResultEvent = {
    type: 'result',
    subtype: isError ? 'error' : 'success',
    is_error: isError,
    result: resultText,
    num_turns: state.numTurns,
    session_id: state.sessionId,
  };
  if (result?.usage) event.usage = result.usage;
  if (errorMessage) event.error = errorMessage;
  state.resultEmitted = true;
  return event;
}

export function formatHeadlessStreamEvent(
  state: HeadlessPrintState,
  event: DmossAgentEvent,
): HeadlessStreamEvent[] {
  switch (event.type) {
    case 'text_delta':
      state.pendingAssistantText += event.delta;
      state.finalText += event.delta;
      return [];
    case 'tool_start':
      return [
        ...flushAssistant(state),
        {
          type: 'tool_use',
          id: event.toolCallId,
          name: event.toolName,
          input: event.input,
          session_id: state.sessionId,
        },
      ];
    case 'tool_end': {
      const toolResult: HeadlessToolResultEvent = {
        type: 'tool_result',
        tool_use_id: event.toolCallId,
        is_error: event.isError,
        content: event.result,
        session_id: state.sessionId,
      };
      if (event.structuredContent) toolResult.structured_content = event.structuredContent;
      return [toolResult];
    }
    case 'turn_start':
      state.numTurns = Math.max(state.numTurns, event.turn);
      return [];
    case 'turn_end':
      state.numTurns = Math.max(state.numTurns, event.turn);
      return flushAssistant(state);
    case 'error':
      state.lastError = event.error;
      return [];
    case 'done':
      return [...flushAssistant(state), formatResult(state, event.result)];
    case 'thinking_delta':
    case 'compaction':
    case 'working_context_checkpoint':
    case 'microcompact':
    case 'cache_metrics':
      return [];
  }
}

export function formatHeadlessThrownError(
  state: HeadlessPrintState,
  error: unknown,
): HeadlessStreamEvent[] {
  if (state.resultEmitted) return [];
  return [...flushAssistant(state), formatResult(state, undefined, normalizeError(error))];
}

export function isHeadlessResultError(event: HeadlessResultEvent): boolean {
  return event.is_error;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: '', num_turns: 0, session_id: '', error: 'unserializable output' });
  }
}

export function writeHeadlessJson(writer: HeadlessJsonWriter, event: HeadlessStreamEvent): void {
  writer.write(`${safeJson(event)}\n`);
}
