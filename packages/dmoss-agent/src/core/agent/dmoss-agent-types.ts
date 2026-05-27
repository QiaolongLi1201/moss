import type {
  LLMProvider,
  LLMMessage,
  LLMContentBlock,
  LLMStreamEvent,
} from '../llm/llm-provider.js';
import type { Message, ContentBlock } from '../session/session-jsonl.js';
import type { SessionStore } from '../session/session.js';
import type { Tool, ToolCall, ToolResult, ToolContentBlock } from '../tools/tool-types.js';
import type {
  ContextPruningSettings,
} from '../../context/pruning.js';
import type { CompactionSettings } from '../../context/compaction.js';
import type { MicroCompactConfig } from '../../context/microcompact.js';
import type { TailToolSnipConfig } from '../../context/tail-tool-snip.js';
import type { FollowUpGuardConfig } from '../loop/follow-up-guard.js';
import type { CompactHookRegistry } from '../loop/compact-hooks.js';
import type { SkillLearner } from '../memory/skill-learner.js';
import type { SkillPipeline } from '@dmoss/skills';
import type { AgentHooks } from './agent-hooks.js';
import type { ThinkingLevel } from '../../provider/pi-ai-types.js';
import type { SteeringRule } from '../loop/steering.js';

export interface ProviderConfig {
  llmProvider: LLMProvider;
  model?: string;
  maxTokens?: number;
  /** Max retries for transient LLM errors */
  maxLLMRetries?: number;
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
  /** Provider API type identifier (e.g., 'openai-completions', 'anthropic-messages'). */
  api?: string;
}

export interface ContextManagementConfig {
  /** Context window size in tokens (default: 200K). Used for pruning/compaction decisions. */
  contextTokens?: number;
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
}

export interface ToolExecutionConfig {
  /** Tool execution timeout in milliseconds (default: 30 minutes) */
  toolTimeoutMs?: number;
  /** Enable tool output truncation for oversized results */
  enableToolOutputTruncation?: boolean;
}

export interface PromptConfig {
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
  /**
   * When false, omit registered knowledge prompt fragments from `buildSystemPrompt` (D-Moss may inject its own).
   * Default: true (merge `getAllPromptFragments`).
   */
  includeRegisteredKnowledgePrompts?: boolean;
}

export interface DmossAgentConfig
  extends ProviderConfig,
    ContextManagementConfig,
    ToolExecutionConfig,
    PromptConfig {
  sessionStore: SessionStore;
  maxAgentTurns?: number;
  /** Lifecycle hooks for host customization */
  hooks?: AgentHooks;

  // ── Thinking stream ──
  /** Enable inline thinking tag routing (<thinking>…</thinking>) (default: true) */
  enableThinkingStream?: boolean;

  // ── Follow-up guard ──
  /** Enable follow-up tool detection (default: true) */
  enableFollowUpGuard?: boolean;
  /** Fine-tune follow-up guard */
  followUpGuardConfig?: Partial<FollowUpGuardConfig>;

  // ── Compact hooks ──
  /** Registry for pre/post compaction lifecycle hooks */
  compactHooks?: CompactHookRegistry;
  /**
   * Optional SkillLearner: when set, the agent will run `maybeLearnFromSession`
   * after each successful multi-step run, auto-distilling reusable patterns
   * into the configured skills directory.
   */
  skillLearner?: SkillLearner;
  /**
   * Optional SkillPipeline: when set, the agent will run the full
   * write→distill→promote pipeline after each successful multi-step run,
   * producing validated SKILL.md drafts and auto-promoting high-confidence skills.
   */
  skillPipeline?: SkillPipeline;

  /**
   * Optional self-learning hook: called after each completed agent run with the
   * last user message so the host can extract correction/feedback signals
   * (e.g. via `buildSelfLearningMemoryDraft`) and persist them as memory.
   *
   * Default: undefined (disabled). Gate with `DMOSS_SELF_LEARNING=true` in CLI.
   */
  onSelfLearningExtract?: (params: { sessionKey: string; lastUserMessage: string }) => Promise<void>;

  // ── Steering engine ──
  /** Enable rule-based steering injection (default: true) */
  enableSteering?: boolean;
  /** When true, replace default steering rules instead of extending them */
  replaceDefaultSteeringRules?: boolean;
  /** Custom steering rules to apply */
  steeringRules?: SteeringRule[];
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
      structuredContent?: ToolContentBlock[];
    }
  | { type: 'turn_start'; turn: number }
  | { type: 'turn_end'; turn: number; stopReason: string; totalToolCalls?: number }
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
  | { type: 'microcompact'; compressedCount: number; savedChars: number; savedTokens: number }
  | { type: 'done'; result: ChatResult };

export type InternalContentBlock = Pick<
  ContentBlock,
  | 'type'
  | 'text'
  | 'id'
  | 'name'
  | 'input'
  | 'tool_use_id'
  | 'content'
  | 'is_error'
  | '_synthetic'
  | 'structuredContent'
>;

export type InternalMessage = {
  role: 'user' | 'assistant';
  content: string | InternalContentBlock[];
  timestamp: number;
  thinking?: string[];
};

export function toSessionMessages(msgs: InternalMessage[]): Message[] {
  return msgs.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map((b) => ({ ...b })),
    timestamp: m.timestamp,
    ...(m.thinking ? { thinking: m.thinking } : {}),
  }));
}

export function fromSessionMessages(msgs: Message[]): InternalMessage[] {
  return msgs.map((m) => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => ({
            type: b.type,
            ...(b.text !== undefined ? { text: b.text } : {}),
            ...(b.id !== undefined ? { id: b.id } : {}),
            ...(b.name !== undefined ? { name: b.name } : {}),
            ...(b.input !== undefined ? { input: b.input } : {}),
            ...(b.tool_use_id !== undefined ? { tool_use_id: b.tool_use_id } : {}),
            ...(b.content !== undefined ? { content: b.content } : {}),
            ...(b.is_error !== undefined ? { is_error: b.is_error } : {}),
            ...(b._synthetic !== undefined ? { _synthetic: b._synthetic } : {}),
            ...(b.structuredContent !== undefined ? { structuredContent: b.structuredContent } : {}),
          })),
    timestamp: m.timestamp,
    ...(m.thinking ? { thinking: m.thinking } : {}),
  }));
}

export function toLLMMessages(msgs: InternalMessage[]): LLMMessage[] {
  return msgs.map((m) => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b): LLMContentBlock => {
            if (b.type === 'text') return { type: 'text', text: b.text ?? '' };
            if (b.type === 'tool_use')
              return { type: 'tool_use', id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} };
            return {
              type: 'tool_result',
              tool_use_id: b.tool_use_id ?? '',
              content: b.content ?? '',
              ...(b.is_error !== undefined ? { is_error: b.is_error } : {}),
              ...(b.structuredContent !== undefined ? { structuredContent: b.structuredContent } : {}),
            };
          }),
    ...(m.thinking ? { thinking: m.thinking } : {}),
  }));
}
