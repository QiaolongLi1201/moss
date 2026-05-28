// --- Agent ---
export { combineAbortSignals, wrapToolWithAbortSignal, abortable } from './agent/index.js';
export type {
  AgentHooks,
  ToolApprovalRequest,
  ToolApprovalDecision,
} from './agent/index.js';
export {
  CommandQueueRegistry,
  enqueueInLane,
  setLaneConcurrency,
  resolveSessionLane,
  resolveGlobalLane,
  deleteLane,
} from './agent/index.js';
export type { EnqueueOpts } from './agent/index.js';
export { DmossAgent } from './agent/index.js';
export type { DmossAgentConfig, ChatOptions, ChatResult, DmossAgentEvent } from './agent/index.js';
export {
  createDmossAgentLoopEventAdapter,
  createModelDefFromDmossConfig,
} from './agent/index.js';
export type {
  DmossAgentLoopEventAdapter,
  DmossAgentLoopEventAdapterOptions,
} from './agent/index.js';

// --- Goal ---
export {
  executeGoalCommand,
  formatGoalCommandResult,
  handleGoalCommand,
  isGoalCommand,
  parseGoalCommand,
} from './goal/index.js';
export type {
  GoalCommandAction,
  GoalCommandAgent,
  GoalCommandEvent,
  GoalCommandOptions,
  GoalCommandResult,
  HandleGoalCommandParams,
  ParsedGoalCommand,
} from './goal/index.js';
export {
  buildGoalModeContext,
  createGoalCheckpointMessage,
  createGoalState,
  isGoalCheckpointMessage,
  splitGoalCheckpointMessages,
  stripGoalCheckpointsFromLlmMessages,
  updateGoalState,
} from './goal/index.js';
export type { GoalState, GoalStatus } from './goal/index.js';
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
} from './goal/index.js';
export type {
  ContinuationIntent,
  TaskFrame,
  TaskFrameStatus,
  TaskFrameToolFinding,
} from './goal/index.js';

// --- LLM ---
export type {
  LLMProvider,
  LLMProviderCapabilities,
  LLMMessage,
  LLMContentBlock,
  LLMStreamEvent,
  LLMRequestOptions,
  LLMResponse,
  LLMToolDeclaration,
} from './llm/index.js';
export {
  createInlineThinkingRouter,
  splitThinkingTagsFromAssistantText,
} from './llm/index.js';
export type { InlineThinkingRouter } from './llm/index.js';
export {
  classifyLlmError,
  retryDelayForLlmError,
} from './llm/index.js';
export type {
  LlmErrorCategory,
  LlmErrorClassification,
} from './llm/index.js';
export {
  createStreamFunctionFromLlmProvider,
} from './llm/index.js';
export type { LlmProviderStreamAdapterOptions } from './llm/index.js';
export {
  createClientLlmSummarizationStrategy,
  createProviderServerCompactionStrategy,
  createSummarizeFnFromLlmProvider,
} from './llm/index.js';
export type {
  ProviderServerCompactionFn,
  ProviderServerCompactionPayload,
  SummarizationStrategy,
  SummarizationStrategyInput,
  SummarizationStrategyKind,
  SummarizationStrategyResult,
} from './llm/index.js';

// --- Loop ---
export {
  runAgentLoop,
  lastMessageNeedsToolFollowUpLlm,
  resolveEffectiveCaps,
} from './loop/index.js';
export type {
  AgentLoopDeps,
  AgentLoopExtensions,
  AgentLoopHardCaps,
  AgentLoopIdentity,
  AgentLoopParams,
  AgentLoopPlatformConfig,
  AgentLoopPolicy,
  AgentLoopPromptInput,
  AgentLoopProviderInput,
  AgentLoopToolInput,
} from './loop/index.js';
export {
  CompactHookRegistry,
  buildCompactionCheckpointOutline,
} from './loop/index.js';
export type {
  CompactReason,
  PreCompactContext,
  PostCompactContext,
  PreCompactHook,
  PostCompactHook,
} from './loop/index.js';
export {
  planContextBudgetActions,
} from './loop/index.js';
export type {
  ContextBudgetAction,
  ContextBudgetActionKind,
  ContextBudgetActionReason,
  ContextBudgetPlan,
  ContextBudgetPlannerInput,
} from './loop/index.js';
export {
  lastMessageNeedsToolFollowUp,
  hasToolResultAfterLastAssistant,
  shouldSuppressReasoningForToolFollowUpRound,
  detectUnexecutedToolIntents,
  extractThinkingTagBodies,
  DEFAULT_FOLLOW_UP_GUARD_CONFIG,
} from './loop/index.js';
export type {
  FollowUpGuardConfig,
  FollowUpPattern,
  TextActionFollowUp,
} from './loop/index.js';
export {
  SteeringEngine,
  DEFAULT_STEERING_RULES,
  BUILTIN_ERROR_RECOVERY_RULE,
  BUILTIN_TOOL_LOOP_RULE,
  BUILTIN_CONTEXT_PRESSURE_RULE,
} from './loop/index.js';
export type {
  SteeringRule,
  SteeringContext,
  SteeringResult,
} from './loop/index.js';

// --- Memory ---
export {
  MemoryManager,
  MEMORY_INDEX_CHAR_SOFT_LIMIT,
  LEARNING_TOPIC_SLUGS,
  buildMemorySearchQueryVariants,
  validateMemoryWriteContent,
} from './memory/index.js';
export type {
  LearningTopicSlug,
  MemoryEntry,
  MemoryScope,
  MemorySearchResult,
  MemorySource,
  MemoryWriteValidation,
} from './memory/index.js';
export { SkillLearner } from './memory/index.js';
export type { LearnedSkill, SkillLearnerConfig } from './memory/index.js';
export { WorkspaceMemory } from './memory/index.js';
export type { WorkspaceMemoryConfig, WorkspaceMemoryContext } from './memory/index.js';

// --- Session ---
export { InMemorySessionStore } from './session/index.js';
export type { SessionStore, SessionMeta } from './session/index.js';
export { JsonlSessionStore } from './session/index.js';
export type { JsonlSessionStoreConfig } from './session/index.js';
export {
  CURRENT_SESSION_VERSION,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  createCompactionSummaryMessage,
  SessionManager,
} from './session/index.js';
export type {
  Message,
  ContentBlock,
  SessionHeaderEntry,
  SessionEntryBase,
  MessageEntry,
  CompactionEntry,
  SessionEntry,
  SessionFileEntry,
} from './session/index.js';
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
} from './session/index.js';
export { acquireSessionWriteLock } from './session/index.js';

// --- Subagent ---
export {
  MINI_AGENT_EVENT_VERSION,
  createMiniAgentStream,
} from './subagent/index.js';
export type {
  MiniAgentEvent,
  MiniAgentResult,
  RunMetrics,
} from './subagent/index.js';
export type { SpawnToolScope } from './subagent/index.js';
export {
  SpawnProfileRegistry,
  SPAWN_TOOL_SCOPE_SETS,
  createSpawnProfileRegistryFromDefaults,
  getDefaultSpawnProfileRegistry,
  resolveSpawnToolSet,
  buildSubagentPromptAddon,
  registerSpawnToolExtensions,
} from './subagent/index.js';

// --- Tools ---
export type { ToolContext, Tool, ToolCall, ToolResult, ToolContentBlock, StructuredToolResult } from './tools/index.js';
export { canHostInjectToolWithEmptyInput } from './tools/index.js';
export { ToolRegistry } from './tools/index.js';
export type { ToolGroup, ToolRegistryOptions } from './tools/index.js';
export { convertMessagesToPi } from './tools/index.js';
export {
  validateToolInputObject,
  runPreToolHookChain,
  registerPreToolHook,
  clearPreToolHooksForTests,
} from './tools/index.js';
export type {
  PreToolHookContext,
  PreToolHookResult,
  PreToolHook,
} from './tools/index.js';
export {
  ToolHookRegistry,
  createSecretSanitizerHook,
  createTimingHook,
  createReadOnlyHook,
  createExecLikeFailureHintHook,
} from './tools/index.js';
export type {
  PreToolUseDecision,
  PreToolUseHook,
  PostToolUseHook,
  PostToolUseFailureHook,
} from './tools/index.js';
export {
  isToolAssumedMutating,
  findReplayableToolResultContent,
} from './tools/index.js';
export {
  setOpenUrlMarkers,
  parseUrlsFromOpenUrlToolResult,
  maybeSuppressRedundantWebFetchAfterOpenUrl,
} from './tools/index.js';
export {
  extractToolInvocationFromPlanText,
} from './tools/index.js';
export type { ExtractedToolInvocation } from './tools/index.js';
