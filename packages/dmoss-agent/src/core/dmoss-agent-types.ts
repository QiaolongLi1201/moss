import type {
  LLMProvider,
  LLMMessage,
  LLMContentBlock,
  LLMResponse,
  LLMStreamEvent,
} from './llm-provider.js';
import type { Message } from './session-jsonl.js';
import type { SessionStore } from './session.js';
import type { Tool, ToolContext, ToolCall, ToolResult } from './tool-types.js';
import type { SteeringRule } from './steering.js';
import type {
  ContextPruningSettings,
} from '../context/pruning.js';
import type { CompactionSettings } from '../context/compaction.js';
import type { MicroCompactConfig } from '../context/microcompact.js';
import type { TailToolSnipConfig } from '../context/tail-tool-snip.js';
import type { FollowUpGuardConfig } from './follow-up-guard.js';
import type { CompactHookRegistry } from './compact-hooks.js';
import type { SkillLearner } from './skill-learner.js';
import type { AgentHooks } from './agent-hooks.js';
import type { ThinkingLevel } from '@mariozechner/pi-ai';

export interface DmossAgentConfig {
  llmProvider: LLMProvider;
  sessionStore: SessionStore;
  model?: string;
  maxTokens?: number;
  maxAgentTurns?: number;
  /** Tool execution timeout in milliseconds (default: 30 minutes) */
  toolTimeoutMs?: number;
  /** Enable tool output truncation for oversized results */
  enableToolOutputTruncation?: boolean;
  /** Max retries for transient LLM errors */
  maxLLMRetries?: number;
  /** Base system prompt (prepended before domain prompt) */
  baseSystemPrompt?: string;
  /**
   * Custom domain prompt builder — replaces the default robotics engineering prompt.
   * Set to `false` to skip the built-in domain prompt entirely.
   * Omit (or `undefined`) to use the default `buildRoboticsEngineeringPrompt()`.
   */
  domainPrompt?: (() => string) | false;
  /** Additional prompt layers from the host */
  extraPromptLayers?: string[];
  /** Lifecycle hooks for host customization */
  hooks?: AgentHooks;
  /** Context window size in tokens (default: 1M). Used for pruning/compaction decisions. */
  contextTokens?: number;
  /** Sampling temperature for LLM requests */
  temperature?: number;
  /**
   * Provider-native thinking/reasoning mode. When set, the unified agent loop
   * passes the reasoning option through except on tool-result follow-up
   * compatibility calls.
   */
  reasoning?: ThinkingLevel | null;
  /**
   * Preserve assistant `thinking` as provider-native reasoning history when
   * building the pi-ai bridge context. This is separate from enabling a new
   * upstream reasoning effort for the next request.
   */
  roundTripAssistantThinking?: boolean;

  // ── Context management ──
  /** Enable context pruning when messages approach the context window limit */
  enableContextPruning?: boolean;
  /** Fine-tune pruning behavior */
  pruningSettings?: Partial<ContextPruningSettings>;
  /** Enable LLM-based context compaction (summarization) */
  enableCompaction?: boolean;
  /** Fine-tune compaction behavior */
  compactionSettings?: Partial<CompactionSettings>;
  /** Enable zero-cost microcompact of old tool results (default: true) */
  enableMicrocompact?: boolean;
  /** Fine-tune microcompact */
  microcompactConfig?: Partial<MicroCompactConfig>;
  /** Enable tail-tool-snip for near-tail oversized results (default: true) */
  enableTailToolSnip?: boolean;
  /** Fine-tune tail-tool-snip */
  tailToolSnipConfig?: Partial<TailToolSnipConfig>;
  /** Enable stale-read invalidation (default: true) */
  enableStaleReadInvalidation?: boolean;

  // ── Thinking stream ──
  /** Enable inline thinking tag routing (<thinking>…</thinking>) (default: true) */
  enableThinkingStream?: boolean;

  // ── Steering ──
  /** Enable rule-based conversation steering (default: true) */
  enableSteering?: boolean;
  /** Custom steering rules (merged with or replacing built-in rules) */
  steeringRules?: SteeringRule[];
  /** If true, only use custom rules; otherwise merge with built-in rules */
  replaceDefaultSteeringRules?: boolean;

  // ── Follow-up guard ──
  /** Enable follow-up tool detection (default: true) */
  enableFollowUpGuard?: boolean;
  /** Fine-tune follow-up guard */
  followUpGuardConfig?: Partial<FollowUpGuardConfig>;
  /**
   * 当上游未返回 `tool_calls`、但 `detectUnexecutedToolIntents` 命中某工具名时，由宿主**注入**一次 `tool_use`
   * 并照常执行（仅当该工具 JSON Schema **无必填字段**，可用 `{}` 安全调用；默认开启）。
   * @see canHostInjectToolWithEmptyInput
   */
  enableHostToolIntentFallback?: boolean;

  // ── Compact hooks ──
  /** Registry for pre/post compaction lifecycle hooks */
  compactHooks?: CompactHookRegistry;
  /**
   * When false, omit registered knowledge prompt fragments from `buildSystemPrompt` (D-Moss may inject its own).
   * Default: true (merge `getAllPromptFragments`).
   */
  includeRegisteredKnowledgePrompts?: boolean;
  /**
   * Optional SkillLearner: when set, the agent will run `maybeLearnFromSession`
   * after each successful multi-step run, auto-distilling reusable patterns
   * into the configured skills directory.
   */
  skillLearner?: SkillLearner;
}

export interface ChatOptions {
  platform?: string;
  abortSignal?: AbortSignal;
  /**
   * Host integration: provide a per-tool AbortSignal so one tool can be cancelled
   * without aborting the whole run.
   */
  toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;
  onStream?: (event: LLMStreamEvent) => void;
  /** Additional tools available only for this chat turn */
  ephemeralTools?: Tool[];
  /** Extra context to inject into the system prompt */
  extraContext?: string;
  /** Override temperature for this chat turn */
  temperature?: number;
  /** Run ID for tracing (auto-generated if omitted) */
  runId?: string;
}

export interface ChatResult {
  response: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  usage?: { inputTokens: number; outputTokens: number };
  /** Thinking content extracted from inline tags (if thinking stream enabled) */
  thinking?: string[];
  /** Number of compactions performed during this run */
  compactions?: number;
  /** Steering guidances injected during this run */
  steeringEvents?: string[];
  /** Last LLM / agent termination reason (when applicable) */
  stopReason?: string;
}

export type DmossAgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; toolName: string; toolCallId: string; input: Record<string, unknown> }
  | {
      type: 'tool_end';
      toolName: string;
      toolCallId: string;
      result: string;
      isError: boolean;
      aborted?: { by: 'user' | 'timeout' };
    }
  | { type: 'turn_start'; turn: number }
  | { type: 'turn_end'; turn: number; stopReason: string }
  | { type: 'error'; error: string; retriable: boolean }
  | {
      type: 'compaction';
      summaryChars: number;
      droppedMessages: number;
      checkpointOutline?: string[];
    }
  | {
      type: 'working_context_checkpoint';
      status: string;
      reason: string;
      goal: string;
      nextAction: string;
    }
  | { type: 'steering'; pendingCount: number; firedRules: string[] }
  | { type: 'follow_up'; guidance: string }
  | { type: 'microcompact'; compressedCount: number; savedChars: number; savedTokens: number }
  | { type: 'done'; result: ChatResult };

export type InternalMessage = {
  role: 'user' | 'assistant';
  content: string | InternalContentBlock[];
  timestamp: number;
  /** 与 session-jsonl Message.thinking 对齐；供开思考链的网关回传 reasoning_content */
  thinking?: string[];
};

export type InternalContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
};

export function toSessionMessages(msgs: InternalMessage[]): Message[] {
  return msgs as unknown as Message[];
}

export function fromSessionMessages(msgs: Message[]): InternalMessage[] {
  return msgs as unknown as InternalMessage[];
}

export function toLLMMessages(msgs: InternalMessage[]): LLMMessage[] {
  return msgs as unknown as LLMMessage[];
}

export function resolveHostToolIntentFallback(cfg: DmossAgentConfig): boolean {
  if (cfg.enableHostToolIntentFallback === false) return false;
  if (cfg.enableHostToolIntentFallback === true) return true;
  const primary = process.env.DMOSS_HOST_TOOL_INTENT_FALLBACK?.trim();
  if (primary === '0' || primary === 'false') return false;
  if (primary === '1' || primary === 'true') return true;
  const raw = process.env.DMOSS_HOST_DEVICE_LIST_FALLBACK?.trim() ?? '';
  if (raw === '0' || raw === 'false') return false;
  return true;
}
