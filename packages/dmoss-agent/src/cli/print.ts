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

/** Content blocks inside an `assistant` message, mirroring the Anthropic Message object. */
export type HeadlessTextBlock = { type: 'text'; text: string };
export type HeadlessToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type HeadlessAssistantContentBlock = HeadlessTextBlock | HeadlessToolUseBlock;

export type HeadlessAssistantEvent = {
  type: 'assistant';
  message: {
    type: 'message';
    id: string;
    role: 'assistant';
    model?: string;
    stop_reason: string | null;
    content: HeadlessAssistantContentBlock[];
    usage?: ChatResult['usage'];
  };
  session_id: string;
};

/** Content block carried back inside a `user` message, mirroring Claude Code's tool result. */
export type HeadlessToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  structured_content?: unknown;
};

export type HeadlessUserEvent = {
  type: 'user';
  message: {
    role: 'user';
    content: HeadlessToolResultBlock[];
  };
  session_id: string;
};

export type HeadlessResultSubtype = 'success' | 'error_max_turns' | 'error_during_execution';

export type HeadlessResultEvent = {
  type: 'result';
  subtype: HeadlessResultSubtype;
  is_error: boolean;
  result: string;
  duration_ms: number;
  num_turns: number;
  session_id: string;
  total_cost_usd: number;
  usage?: ChatResult['usage'];
  error?: string;
};

export type HeadlessStreamEvent =
  | HeadlessSystemInitEvent
  | HeadlessAssistantEvent
  | HeadlessUserEvent
  | HeadlessResultEvent;

export interface HeadlessInitInput {
  cwd: string;
  model?: string;
  tools: string[];
  sessionId: string;
}

export interface HeadlessPrintState {
  readonly sessionId: string;
  readonly model?: string;
  readonly startTime: number;
  pendingAssistantText: string;
  pendingToolUses: HeadlessToolUseBlock[];
  assistantSeq: number;
  finalText: string;
  numTurns: number;
  lastError?: string;
  resultEmitted: boolean;
}

export interface HeadlessPrintStateInput {
  sessionId: string;
  model?: string;
  startTime?: number;
}

export interface HeadlessJsonWriter {
  write(chunk: string): unknown;
}

export function createHeadlessPrintState(input: HeadlessPrintStateInput): HeadlessPrintState {
  return {
    sessionId: input.sessionId,
    model: input.model,
    startTime: input.startTime ?? Date.now(),
    pendingAssistantText: '',
    pendingToolUses: [],
    assistantSeq: 0,
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

function isMaxTurnsStopReason(stopReason: string | undefined): boolean {
  return stopReason === 'max_turns_reached' || stopReason === 'tool_followup_cap_reached';
}

function isErrorStopReason(stopReason: string | undefined): boolean {
  return stopReason === 'error' || stopReason === 'aborted_by_user' || isMaxTurnsStopReason(stopReason);
}

/**
 * Flush any accumulated assistant text and/or tool_use blocks as a single
 * `assistant` message event, mirroring Claude Code (one message may carry both
 * text and tool_use content blocks). Returns [] when there is nothing pending.
 */
function flushAssistant(
  state: HeadlessPrintState,
  stopReason: string | null = null,
): HeadlessAssistantEvent[] {
  const content: HeadlessAssistantContentBlock[] = [];
  if (state.pendingAssistantText) content.push({ type: 'text', text: state.pendingAssistantText });
  content.push(...state.pendingToolUses);
  if (content.length === 0) return [];
  state.pendingAssistantText = '';
  state.pendingToolUses = [];
  state.assistantSeq += 1;
  const message: HeadlessAssistantEvent['message'] = {
    type: 'message',
    id: `msg_${state.sessionId}_${state.assistantSeq}`,
    role: 'assistant',
    stop_reason: stopReason,
    content,
  };
  if (state.model) message.model = state.model;
  return [{ type: 'assistant', message, session_id: state.sessionId }];
}

function formatResult(
  state: HeadlessPrintState,
  result: ChatResult | undefined,
  error?: string,
): HeadlessResultEvent {
  const resultText = result?.response ?? state.finalText;
  const errorMessage = error ?? state.lastError;
  const maxTurns = isMaxTurnsStopReason(result?.stopReason);
  const isError = Boolean(errorMessage) || isErrorStopReason(result?.stopReason);
  const subtype: HeadlessResultSubtype = !isError
    ? 'success'
    : maxTurns
      ? 'error_max_turns'
      : 'error_during_execution';
  const event: HeadlessResultEvent = {
    type: 'result',
    subtype,
    is_error: isError,
    result: resultText,
    duration_ms: Math.max(0, Date.now() - state.startTime),
    num_turns: state.numTurns,
    session_id: state.sessionId,
    total_cost_usd: 0,
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
      // Accumulate as a tool_use content block; it is emitted inside an
      // `assistant` message (flushed at tool_end), never as a bare event.
      state.pendingToolUses.push({
        type: 'tool_use',
        id: event.toolCallId,
        name: event.toolName,
        input: event.input,
      });
      return [];
    case 'tool_end': {
      // Emit the assistant message that issued the pending tool_use block(s)
      // before the matching user tool_result, preserving Claude Code ordering.
      const assistant = flushAssistant(state);
      const toolResult: HeadlessToolResultBlock = {
        type: 'tool_result',
        tool_use_id: event.toolCallId,
        content: event.result,
      };
      if (event.isError) toolResult.is_error = true;
      if (event.structuredContent) toolResult.structured_content = event.structuredContent;
      const userEvent: HeadlessUserEvent = {
        type: 'user',
        message: { role: 'user', content: [toolResult] },
        session_id: state.sessionId,
      };
      return [...assistant, userEvent];
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
    return JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: '',
      duration_ms: 0,
      num_turns: 0,
      session_id: '',
      total_cost_usd: 0,
      error: 'unserializable output',
    });
  }
}

export function writeHeadlessJson(writer: HeadlessJsonWriter, event: HeadlessStreamEvent): void {
  writer.write(`${safeJson(event)}\n`);
}
