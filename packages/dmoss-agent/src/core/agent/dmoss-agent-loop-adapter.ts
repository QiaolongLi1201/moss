import type { Model } from '../../provider/pi-ai-types.js';
import type { MiniAgentEvent, MiniAgentResult } from '../subagent/agent-events.js';
import type { ChatResult, DmossAgentConfig, DmossAgentEvent } from './dmoss-agent-types.js';
import type { ToolCall, ToolResult } from '../tools/tool-types.js';

type ModelBridgeConfig = Pick<
  DmossAgentConfig,
  | 'contextTokens'
  | 'llmProvider'
  | 'maxTokens'
  | 'model'
  | 'reasoning'
  | 'roundTripAssistantThinking'
  | 'api'
>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createModelDefFromDmossConfig(config: ModelBridgeConfig): Model<any> {
  const modelId = String(config.model || 'dmoss-default-model');
  const roundTripsThinkingHistory =
    config.roundTripAssistantThinking === true || Boolean(config.reasoning);
  return {
    id: modelId,
    name: modelId,
    api: config.api ?? 'openai-completions',
    provider: config.llmProvider.id,
    baseUrl: '',
    reasoning: roundTripsThinkingHistory,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextTokens ?? 200_000,
    maxTokens: config.maxTokens ?? 4096,
  };
}

export interface DmossAgentLoopEventAdapter {
  onMiniEvent(event: MiniAgentEvent): DmossAgentEvent[];
  getResult(result: MiniAgentResult): ChatResult;
  getDoneEvent(result: MiniAgentResult): Extract<DmossAgentEvent, { type: 'done' }>;
}

export interface DmossAgentLoopEventAdapterOptions {
  isAbortError?: (error: string) => boolean;
}

export function createDmossAgentLoopEventAdapter(
  options?: DmossAgentLoopEventAdapterOptions,
): DmossAgentLoopEventAdapter {
  let response = '';
  const thinking: string[] = [];
  const toolCalls: ToolCall[] = [];
  const toolResults: ToolResult[] = [];
  let compactions = 0;
  let stopReason = 'unknown';

  const getResult = (result: MiniAgentResult): ChatResult => ({
    response: response || result.finalText,
    toolCalls,
    toolResults,
    ...(thinking.length > 0 ? { thinking } : {}),
    ...(compactions > 0 ? { compactions } : {}),
    stopReason:
      stopReason === 'unknown' && (response || result.finalText) ? 'end_turn' : stopReason,
  });

  return {
    onMiniEvent(event) {
      switch (event.type) {
        case 'message_delta':
          response += event.delta;
          return [{ type: 'text_delta', delta: event.delta }];
        case 'message_end':
          response = event.text;
          return [];
        case 'thinking_delta':
          thinking.push(event.delta);
          return [{ type: 'thinking_delta', delta: event.delta }];
        case 'tool_execution_start': {
          const input = asRecord(event.args);
          toolCalls.push({ id: event.toolCallId, name: event.toolName, input });
          return [
            {
              type: 'tool_start',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input,
            },
          ];
        }
        case 'tool_execution_end': {
          const content = event.content ?? event.result;
          toolResults.push({
            toolUseId: event.toolCallId,
            content,
            isError: event.isError,
            ...(event.aborted ? { aborted: event.aborted } : {}),
            ...(event.structuredContent ? { structuredContent: event.structuredContent } : {}),
          });
          return [
            {
              type: 'tool_end',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              result: event.result,
              isError: event.isError,
              ...(event.aborted ? { aborted: event.aborted } : {}),
              ...(event.structuredContent ? { structuredContent: event.structuredContent } : {}),
            },
          ];
        }
        case 'turn_start':
          return [{ type: 'turn_start', turn: event.turn }];
        case 'turn_end':
          return [{
            type: 'turn_end',
            turn: event.turn,
            stopReason,
            ...(event.totalToolCalls !== undefined ? { totalToolCalls: event.totalToolCalls } : {}),
          }];
        case 'turn_transition':
          stopReason = event.reason;
          return [];
        case 'compaction':
          compactions += 1;
          return [
            {
              type: 'compaction',
              summaryChars: event.summaryChars,
              droppedMessages: event.droppedMessages,
              ...(event.checkpointOutline ? { checkpointOutline: event.checkpointOutline } : {}),
            },
          ];
        case 'context_action': {
          const microcompact = event.actions.find((action) => action.kind === 'microcompact');
          if (!microcompact) return [];
          return [
            {
              type: 'microcompact',
              compressedCount: microcompact.count,
              savedChars: microcompact.savedChars,
              savedTokens: microcompact.savedTokens,
            },
          ];
        }
        case 'working_context_checkpoint':
          return [
            {
              type: 'working_context_checkpoint',
              status: event.status,
              reason: event.reason,
              goal: event.goal,
              nextAction: event.nextAction,
            },
          ];
        case 'run_metrics':
          compactions = Math.max(compactions, event.metrics.contextCompactions);
          return [];
        case 'retry':
          // Intentionally not surfaced to DmossAgentEvent — retry is internal observability.
          return [];
        case 'context_overflow_compact':
          // Intentionally not surfaced — compaction is reported via 'compaction' event.
          return [];
        case 'agent_error':
          stopReason = options?.isAbortError?.(event.error) ? 'aborted_by_user' : 'error';
          return [{ type: 'error', error: event.error, retriable: false }];
        default:
          return [];
      }
    },
    getResult,
    getDoneEvent(result) {
      return { type: 'done', result: getResult(result) };
    },
  };
}
