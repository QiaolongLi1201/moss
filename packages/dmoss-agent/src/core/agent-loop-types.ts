import type { Model, StreamFunction, ThinkingLevel } from '../provider/pi-ai-types.js';
import type { ContextPruningSettings } from '../context/pruning.js';
import type { CompactHookRegistry } from './compact-hooks.js';
import type { Message } from './session-jsonl.js';
import type { ToolHookRegistry } from './tool-hooks.js';
import type { Tool, ToolContext } from './tool-types.js';

/**
 * Platform-specific loop configuration injected by the host wrapper.
 */
export interface AgentLoopPlatformConfig {
  /** Read-only tools that can run in parallel. Empty means serial execution. */
  parallelSafeTools?: Set<string>;
  /** Per-tool timeout in milliseconds. */
  toolTimeoutMs?: number;
  /** Agent-level heartbeat interval while a tool is running. */
  toolHeartbeatIntervalMs?: number;
  /** Tools that emit their own heartbeat and should skip the agent heartbeat. */
  skipHeartbeatToolNames?: Set<string>;
  /** Meta-tool name that should run before other same-turn tools. */
  loadToolsMetaName?: string;
}

export interface AgentLoopParams {
  runId: string;
  sessionKey: string;
  agentId: string;
  currentMessages: Message[];
  compactionSummary: Message | undefined;
  systemPrompt: string;
  systemPromptParts?: { stable: string; dynamic: string };
  toolsForRun: Tool[];
  getToolsForRun?: () => Tool[];
  toolCtx: ToolContext;
  modelDef: Model<any>;
  streamFn: StreamFunction;
  apiKey?: string;
  temperature?: number;
  topP?: number;
  reasoning?: ThinkingLevel;
  maxTurns: number;
  contextTokens: number;
  getSteeringMessages: () => Promise<Message[]>;
  getFollowUpMessages?: () => Promise<Message[]>;
  appendMessage: (sessionKey: string, msg: Message) => Promise<void>;
  replaceMessages?: (sessionKey: string, messages: Message[]) => Promise<void>;
  prepareCompaction: (params: {
    messages: Message[];
    sessionKey: string;
    runId: string;
    forceCompaction?: boolean;
  }) => Promise<{
    summary?: string;
    summaryMessage?: Message;
    messages?: Message[];
    droppedMessages?: number;
    checkpointOutline?: string[];
  }>;
  checkToolApproval?: (call: {
    id: string;
    name: string;
    input: unknown;
  }) => Promise<{ approved: boolean; decision: string } | null>;
  toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;
  enrichToolContext?: (baseCtx: ToolContext, sessionKey: string) => ToolContext;
  toolHooks?: ToolHookRegistry;
  abortSignal: AbortSignal;
  maxOutputTokens?: number;
  pruningSettings?: Partial<ContextPruningSettings>;
  compactHooks?: CompactHookRegistry;
  systemPromptMeta?: { hashShort: string; layerCount: number };
  platform?: AgentLoopPlatformConfig;
}
