// Command Queue
export {
  enqueueInLane,
  setLaneConcurrency,
  resolveSessionLane,
  resolveGlobalLane,
  deleteLane,
} from './command-queue.js';
export type { EnqueueOpts } from './command-queue.js';

// Tool Types
export type { ToolContext, Tool, ToolCall, ToolResult } from './tool-types.js';
export { canHostInjectToolWithEmptyInput } from './tool-types.js';

// Tool Registry
export { ToolRegistry } from './tool-registry.js';
export type { ToolGroup, ToolRegistryOptions } from './tool-registry.js';

// LLM Provider
export type {
  LLMProvider,
  LLMMessage,
  LLMContentBlock,
  LLMStreamEvent,
  LLMRequestOptions,
  LLMResponse,
  LLMToolDeclaration,
} from './llm-provider.js';

// Session
export { InMemorySessionStore } from './session.js';
export { JsonlSessionStore } from './jsonl-session-store.js';
export type { JsonlSessionStoreConfig } from './jsonl-session-store.js';
export type { SessionStore, SessionMeta } from './session.js';

// Abort
export { combineAbortSignals, wrapToolWithAbortSignal, abortable } from './abort.js';

// Agent Hooks
export type {
  AgentHooks,
  ToolApprovalRequest,
  ToolApprovalDecision,
} from './agent-hooks.js';

// Session JSONL
export {
  CURRENT_SESSION_VERSION,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  createCompactionSummaryMessage,
  SessionManager,
} from './session-jsonl.js';
export type {
  Message,
  ContentBlock,
  SessionHeaderEntry,
  SessionEntryBase,
  MessageEntry,
  CompactionEntry,
  SessionEntry,
  SessionFileEntry,
} from './session-jsonl.js';

// Session Key
export {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  normalizeMainKey,
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  isSubagentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
  resolveSessionKey,
} from './session-key.js';

// Session Write Lock
export { acquireSessionWriteLock } from './session-write-lock.js';

// Memory
export {
  MemoryManager,
  MEMORY_INDEX_CHAR_SOFT_LIMIT,
  LEARNING_TOPIC_SLUGS,
  buildMemorySearchQueryVariants,
  validateMemoryWriteContent,
  type LearningTopicSlug,
  type MemoryEntry,
  type MemoryScope,
  type MemorySearchResult,
  type MemorySource,
  type MemoryWriteValidation,
} from './memory.js';

// Agent Events
export {
  MINI_AGENT_EVENT_VERSION,
  createMiniAgentStream,
  type MiniAgentEvent,
  type MiniAgentResult,
  type RunMetrics,
} from './agent-events.js';

// Tool Pipeline
export {
  validateToolInputObject,
  runPreToolHookChain,
  registerPreToolHook,
  clearPreToolHooksForTests,
  type PreToolHookContext,
  type PreToolHookResult,
  type PreToolHook,
} from './tool-pipeline.js';

// Tool Hooks
export {
  ToolHookRegistry,
  createSecretSanitizerHook,
  createTimingHook,
  createReadOnlyHook,
  createExecLikeFailureHintHook,
  type PreToolUseDecision,
  type PreToolUseHook,
  type PostToolUseHook,
  type PostToolUseFailureHook,
} from './tool-hooks.js';

// Compact Hooks
export {
  CompactHookRegistry,
  buildCompactionCheckpointOutline,
  type CompactReason,
  type PreCompactContext,
  type PostCompactContext,
  type PreCompactHook,
  type PostCompactHook,
} from './compact-hooks.js';

// DmossAgent
export { DmossAgent } from './dmoss-agent.js';
export type { DmossAgentConfig, ChatOptions, ChatResult, DmossAgentEvent } from './dmoss-agent.js';

// Inline Thinking Stream
export {
  createInlineThinkingRouter,
  splitThinkingTagsFromAssistantText,
} from './inline-thinking-stream.js';
export type { InlineThinkingRouter } from './inline-thinking-stream.js';

// Steering
export {
  SteeringEngine,
  DEFAULT_STEERING_RULES,
  BUILTIN_ERROR_RECOVERY_RULE,
  BUILTIN_TOOL_LOOP_RULE,
  BUILTIN_CONTEXT_PRESSURE_RULE,
} from './steering.js';
export type {
  SteeringRule,
  SteeringContext,
  SteeringResult,
} from './steering.js';

// Follow-up Guard
export {
  lastMessageNeedsToolFollowUp,
  hasToolResultAfterLastAssistant,
  shouldSuppressReasoningForToolFollowUpRound,
  detectUnexecutedToolIntents,
  extractThinkingTagBodies,
  DEFAULT_FOLLOW_UP_GUARD_CONFIG,
} from './follow-up-guard.js';
export type {
  FollowUpGuardConfig,
  FollowUpPattern,
  TextActionFollowUp,
} from './follow-up-guard.js';

// Agent Loop (core)
export {
  runAgentLoop,
  lastMessageNeedsToolFollowUpLlm,
  type AgentLoopParams,
  type AgentLoopPlatformConfig,
} from './agent-loop.js';

// Context budget planning
export {
  planContextBudgetActions,
  type ContextBudgetAction,
  type ContextBudgetActionKind,
  type ContextBudgetActionReason,
  type ContextBudgetPlan,
  type ContextBudgetPlannerInput,
} from './context-budget-planner.js';

// LLM error classification
export {
  classifyLlmError,
  retryDelayForLlmError,
  type LlmErrorCategory,
  type LlmErrorClassification,
} from './llm-error-classifier.js';

// Summarization strategy
export {
  createClientLlmSummarizationStrategy,
  createProviderServerCompactionStrategy,
  createSummarizeFnFromLlmProvider,
  type ProviderServerCompactionFn,
  type ProviderServerCompactionPayload,
  type SummarizationStrategy,
  type SummarizationStrategyInput,
  type SummarizationStrategyKind,
  type SummarizationStrategyResult,
} from './summarization-strategy.js';

// LLMProvider → pi-ai stream adapter
export {
  createStreamFunctionFromLlmProvider,
  type LlmProviderStreamAdapterOptions,
} from './llm-provider-stream-adapter.js';

// DmossAgent streamChat ↔ runAgentLoop adapters
export {
  createDmossAgentLoopEventAdapter,
  createModelDefFromDmossConfig,
  type DmossAgentLoopEventAdapter,
  type DmossAgentLoopEventAdapterOptions,
} from './dmoss-agent-loop-adapter.js';

// Message Convert (internal → pi-ai)
export { convertMessagesToPi } from './message-convert.js';

// Spawn Profile (sub-agent tool scopes)
export type { SpawnToolScope } from './spawn-profile.js';
export {
  SPAWN_TOOL_SCOPE_SETS,
  resolveSpawnToolSet,
  buildSubagentPromptAddon,
  registerSpawnToolExtensions,
} from './spawn-profile.js';

// Tool Idempotent Replay
export {
  isToolAssumedMutating,
  registerMutatingToolHints,
  findReplayableToolResultContent,
} from './tool-idempotent-replay.js';

// Open URL / web_fetch guard (host-configurable markers)
export {
  setOpenUrlMarkers,
  parseUrlsFromOpenUrlToolResult,
  maybeSuppressRedundantWebFetchAfterOpenUrl,
} from './open-url-web-fetch-guard.js';

// Extract Tool Invocation from Plan Text (framework-level tool parameter extraction)
export {
  extractToolInvocationFromPlanText,
  type ExtractedToolInvocation,
} from './extract-tool-invocation.js';

// Working Context / Task Frame
export {
  buildTaskFrameContext,
  createOrUpdateTaskFrame,
  createTaskFrameCheckpointMessage,
  detectContinuationIntent,
  isTaskFrameCheckpointMessage,
  recordTaskFrameAssistant,
  recordTaskFrameCompaction,
  recordTaskFrameStop,
  recordTaskFrameToolEnd,
  recordTaskFrameToolStart,
  splitTaskFrameCheckpointMessages,
  stripTaskFrameCheckpointsFromLlmMessages,
  type ContinuationIntent,
  type TaskFrame,
  type TaskFrameStatus,
  type TaskFrameToolFinding,
} from './task-frame.js';

// Goal Mode
export {
  executeGoalCommand,
  formatGoalCommandResult,
  handleGoalCommand,
  isGoalCommand,
  parseGoalCommand,
  type GoalCommandAction,
  type GoalCommandAgent,
  type GoalCommandEvent,
  type GoalCommandOptions,
  type GoalCommandResult,
  type HandleGoalCommandParams,
  type ParsedGoalCommand,
} from './goal-command.js';
export {
  buildGoalModeContext,
  createGoalCheckpointMessage,
  createGoalState,
  isGoalCheckpointMessage,
  splitGoalCheckpointMessages,
  stripGoalCheckpointsFromLlmMessages,
  updateGoalState,
  type GoalState,
  type GoalStatus,
} from './goal-state.js';

// Skill Learner — auto-distill reusable skills from successful sessions.
export { SkillLearner, type LearnedSkill, type SkillLearnerConfig } from './skill-learner.js';
