export {
  runAgentLoop,
  lastMessageNeedsToolFollowUpLlm,
  resolveEffectiveCaps,
} from './agent-loop.js';
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
} from './agent-loop.js';
export {
  CompactHookRegistry,
  buildCompactionCheckpointOutline,
} from './compact-hooks.js';
export type {
  CompactReason,
  PreCompactContext,
  PostCompactContext,
  PreCompactHook,
  PostCompactHook,
} from './compact-hooks.js';
export {
  planContextBudgetActions,
} from './context-budget-planner.js';
export type {
  ContextBudgetAction,
  ContextBudgetActionKind,
  ContextBudgetActionReason,
  ContextBudgetPlan,
  ContextBudgetPlannerInput,
} from './context-budget-planner.js';
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
