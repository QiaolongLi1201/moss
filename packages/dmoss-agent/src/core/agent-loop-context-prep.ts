import type { Tool } from './tool-types.js';
import type { Message } from './session-jsonl.js';
import {
  estimateMessageChars,
  estimateMessageTokens,
} from '../context/tokens.js';

export interface ProviderToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function buildProviderToolDeclarations(toolsForRun: Tool[]): ProviderToolDeclaration[] {
  return [...toolsForRun].sort(compareToolName).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as unknown as Record<string, unknown>,
  }));
}

export function selectMessagesForModel(params: {
  pendingToolResultFollowUp: boolean;
  currentMessages: Message[];
  prunedMessages: Message[];
  droppedMessages: Message[];
  compactionSummary?: Message;
  promptPruneCompactionSucceeded: boolean;
}): Message[] {
  const shouldAvoidUnsummarizedDrop =
    !params.pendingToolResultFollowUp &&
    params.droppedMessages.length > 0 &&
    !params.compactionSummary &&
    !params.promptPruneCompactionSucceeded;
  const selected = shouldAvoidUnsummarizedDrop
    ? params.currentMessages
    : params.prunedMessages;
  return params.compactionSummary ? [params.compactionSummary, ...selected] : selected;
}

export function summarizeDroppedMessages(messages: Message[]): {
  savedChars: number;
  savedTokens: number;
} {
  return {
    savedChars: Math.max(0, messages.reduce(
      (sum, message) => sum + estimateMessageChars(message),
      0,
    )),
    savedTokens: Math.max(0, messages.reduce(
      (sum, message) => sum + estimateMessageTokens(message),
      0,
    )),
  };
}

function compareToolName(a: Tool, b: Tool): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}
