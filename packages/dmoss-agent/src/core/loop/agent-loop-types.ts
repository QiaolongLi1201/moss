import type { Model, StreamFunction, ThinkingLevel } from '../../provider/pi-ai-types.js';
import type { ContextPruningSettings } from '../../context/pruning.js';
import type { CompactHookRegistry } from './compact-hooks.js';
import type { Message } from '../session/session-jsonl.js';
import type { ToolHookRegistry } from '../tools/tool-hooks.js';
import type { Tool, ToolContext } from '../tools/tool-types.js';
import type { SteeringEngine } from './steering.js';

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
  /** M7: Override env-based LLM usage recording. When set, env vars are not read. */
  recordLlmUsage?: boolean;
  /** M7: Override env-based quiet mode. When set, env vars are not read. */
  quiet?: boolean;
}

export interface AgentLoopIdentity {
  runId: string;
  sessionKey: string;
  agentId: string;
}

export interface AgentLoopPromptInput {
  currentMessages: Message[];
  compactionSummary: Message | undefined;
  systemPrompt: string;
  systemPromptParts?: { stable: string; dynamic: string };
  systemPromptMeta?: { hashShort: string; layerCount: number };
}

export interface AgentLoopToolInput {
  toolsForRun: Tool[];
  getToolsForRun?: () => Tool[];
  toolCtx: ToolContext;
  checkToolApproval?: (call: {
    id: string;
    name: string;
    input: unknown;
  }) => Promise<{ approved: boolean; decision: string } | null>;
  toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;
  enrichToolContext?: (baseCtx: ToolContext, sessionKey: string) => ToolContext;
  toolHooks?: ToolHookRegistry;
}

export interface AgentLoopProviderInput {
  modelDef: Model<any>;
  streamFn: StreamFunction;
  apiKey?: string;
  temperature?: number;
  topP?: number;
  reasoning?: ThinkingLevel;
  maxOutputTokens?: number;
}

export interface AgentLoopHardCaps {
  maxMessageCount?: number;
  maxTotalTokens?: number;
  maxConsecutiveTurnErrors?: number;
  maxOutputContinuations?: number;
}

export interface AgentLoopPolicy {
  maxTurns: number;
  contextTokens: number;
  pruningSettings?: Partial<ContextPruningSettings>;
  platform?: AgentLoopPlatformConfig;
  hardCaps?: AgentLoopHardCaps;
}

export interface AgentLoopExtensions {
  getSteeringMessages?: () => Promise<Message[]>;
  getFollowUpMessages?: () => Promise<Message[]>;
  compactHooks?: CompactHookRegistry;
  steeringEngine?: SteeringEngine;
}

export interface AgentLoopDeps {
  appendMessage: (sessionKey: string, msg: Message) => Promise<void>;
  replaceMessages?: (sessionKey: string, messages: Message[]) => Promise<void>;
  prepareCompaction: (params: {
    messages: Message[];
    sessionKey: string;
    runId: string;
    forceCompaction?: boolean;
    abortSignal?: AbortSignal;
  }) => Promise<{
    summary?: string;
    summaryMessage?: Message;
    messages?: Message[];
    droppedMessages?: number;
    checkpointOutline?: string[];
  }>;
  abortSignal: AbortSignal;
}

export interface AgentLoopParams
  extends AgentLoopIdentity,
    AgentLoopPromptInput,
    AgentLoopToolInput,
    AgentLoopProviderInput,
    AgentLoopPolicy,
    AgentLoopExtensions,
    AgentLoopDeps {}
