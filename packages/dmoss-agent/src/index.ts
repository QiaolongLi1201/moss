/**
 * @rdk-moss/agent — D-Moss robotics agent runtime.
 *
 * This package provides the core runtime for building AI-powered robotics agents:
 *  - Knowledge module system: register and query domain knowledge for any hardware
 *  - Platform extension system: plug in new device ecosystems
 *  - Safety: secret sanitization, command safety, approval matching
 *  - Skills: SKILL.md scanning and matching
 *  - Prompts: robotics engineering prompts and telemetry
 *  - Utils: streaming text smoothing, trace logging, @-ref parsing
 *
 * For contracts/interfaces, see @rdk-moss/core.
 */

// --- Knowledge Module System ---
export {
  KnowledgeRegistry,
} from './knowledge/index.js';
/**
 * @deprecated since 0.4.0, removal target 1.0. Use KnowledgeRegistry instance methods instead.
 * Re-exported for backward compatibility — will be removed in next major version.
 */
export {
  registerKnowledgeModule,
  unregisterKnowledgeModule,
  getKnowledgeModule,
  getAllKnowledgeModules,
  findModuleForPlatform,
  findModuleForFamily,
  getAllDeviceProfiles,
  getAllDocEntries,
  getAllPromptFragments,
  getAllCommandPatterns,
  getAllFailureHints,
  getAggregatedEcosystemPrompt,
} from './knowledge/index.js';

// --- Platform Extension System ---
export {
  PlatformExtensionRegistry,
  getDefaultExtensionsRegistry,
  syncPlatformExtensionsAtStartup,
  setVendorPluginCallbacks,
  setKnowledgeRegistryForExtensions,
  applyPlatformExtension,
  applyPlatformExtensionForce,
  getRegisteredPlatformExtensions,
  setRegisteredPlatformExtensionsSnapshot,
  resetPlatformExtensionRegistryForTests,
  listAppliedPlatformExtensionState,
} from './extensions/index.js';
export type { VendorPluginCallbacks } from './extensions/index.js';

// --- Safety ---
export {
  sanitizeSecrets,
  containsSecrets,
  isCommandDangerous,
  isPathProtected,
  registerProtectedPaths,
  matchTextApproval,
  classifyFileKind,
  stripShellPrefixBeforeHeredoc,
} from './safety/index.js';
export type { ChannelSource, ChannelSafetyResult, TextApprovalResult } from './safety/index.js';

// --- Skills ---
export { SkillRegistry, type SkillRegistryOptions } from './skills/index.js';
export type { SkillMeta, SkillPermission, SkillRuntimePolicy } from './skills/types.js';

// --- Prompts ---
export {
  buildRoboticsEngineeringPrompt,
  buildRoboticsEngineeringPromptQuick,
  hashSystemPromptForTelemetry,
  hashSystemPromptLayers,
  hashStableDynamicSystemPrompt,
} from './prompts/index.js';

// --- Core: Agent, Tools, LLM, Session ---
export { DmossAgent } from './core/index.js';
export type { DmossAgentConfig, ChatOptions, ChatResult, DmossAgentEvent } from './core/index.js';
export type {
  AgentHooks,
  InputGuardrailRequest,
  InputGuardrailDecision,
  OutputGuardrailRequest,
  OutputGuardrailDecision,
  ToolApprovalRequest,
  ToolApprovalDecision,
} from './core/index.js';
export type { AgentLoopHardCaps } from './core/index.js';
/** @internal Agent loop hard-cap resolution. */
export { resolveEffectiveCaps } from './core/index.js';
export {
  executeGoalCommand,
  formatGoalCommandResult,
  handleGoalCommand,
  isGoalCommand,
  parseGoalCommand,
} from './goal.js';
export type {
  GoalCommandAction,
  GoalCommandAgent,
  GoalCommandEvent,
  GoalCommandOptions,
  GoalCommandResult,
  GoalState,
  GoalStatus,
  HandleGoalCommandParams,
  ParsedGoalCommand,
} from './goal.js';
/** @internal Thinking-stream parsing internals. */
export { createInlineThinkingRouter, splitThinkingTagsFromAssistantText } from './core/index.js';
export type { InlineThinkingRouter } from './core/index.js';
export { ToolRegistry } from './core/index.js';
export type { ToolGroup, ToolRegistryOptions } from './core/index.js';
export type { ToolContext, Tool, ToolCall, ToolResult, ToolResultOutcome, ToolContentBlock, StructuredToolResult } from './core/index.js';
/** @internal Tool pipeline implementation detail. */
export { canHostInjectToolWithEmptyInput } from './core/index.js';
export type {
  LLMProvider,
  LLMProviderCapabilities,
  LLMMessage,
  LLMContentBlock,
  LLMStreamEvent,
  LLMRequestOptions,
  LLMResponse,
  LLMToolDeclaration,
} from './core/index.js';
export { InMemorySessionStore, JsonlSessionStore } from './core/index.js';
export type { JsonlSessionStoreConfig } from './core/index.js';
export type { SessionStore, SessionMeta } from './core/index.js';
/**
 * Task-frame helpers that downstream needs when **counting** real prior messages
 * (excluding internal `<dmoss_working_context_checkpoint>` entries that ride the
 * `user` role). Without these, callers double-count checkpoint messages as
 * "prior user", which contradicts what the model actually sees in `messages`.
 */
/**
 * @internal Task-frame checkpoint helpers are implementation details.
 * Hosts counting real prior messages should use these, but they are not
 * part of the stable public contract.
 */
export {
  isTaskFrameCheckpointMessage,
  stripTaskFrameCheckpointsFromLlmMessages,
} from './core/index.js';
/**
 * @internal Lane management is an internal concurrency primitive.
 * Hosts should not depend on these — use DmossAgent's public API instead.
 * Re-exported via subpath `@rdk-moss/agent/core` for advanced use cases.
 */
export {
  CommandQueueRegistry,
  enqueueInLane,
  setLaneConcurrency,
  resolveSessionLane,
  resolveGlobalLane,
  deleteLane,
} from './core/index.js';
export type { EnqueueOpts } from './core/index.js';

// --- Utils ---
export { TextDeltaSmoother } from './utils/index.js';
export { parseAtRefs, hasAtRefs } from './utils/index.js';
export {
  DMOSS_DEFAULT_MAX_AGENT_TURNS,
  resolveDmossMaxAgentTurns,
  resolveToolFollowupBypassCap,
} from './utils/index.js';
export { envPreferDmoss, parseEnvNumberPreferDmoss, envTruthyUnlessZeroPreferDmoss } from './utils/index.js';

// --- Context ---
export { compactSubagentSummaryForParent } from './context/index.js';
export { truncateToolOutput, registerToolOutputLimits } from './context/index.js';
export {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  resolveContextWindowInfo,
  evaluateContextWindowGuard,
} from './context/index.js';
export type {
  ContextWindowSource,
  ContextWindowInfo,
  ContextWindowGuardResult,
} from './context/index.js';

// --- Channels ---
export { bridgeAgentToChannel } from './channels/index.js';
export type {
  BridgeAgentToChannelOptions,
  ChannelMessage,
  ChannelResponse,
  MessageChannel,
} from './channels/index.js';

// --- Provider: pi-ai adapter ---
export { PiAiLLMProvider } from './provider/index.js';
export type { PiAiModelInfo, PiAiStreamFunction, PiAiLLMProviderConfig } from './provider/index.js';

// --- Provider: built-in Anthropic + OpenAI (native fetch, no SDK) ---
export { AnthropicLLMProvider } from './provider/anthropic.js';
export type { AnthropicLLMProviderConfig } from './provider/anthropic.js';
export { OpenAILLMProvider } from './provider/openai.js';
export type { OpenAILLMProviderConfig } from './provider/openai.js';

// --- MCP (Model Context Protocol client) ---
export { loadMcpConfig, connectMcpServers } from './mcp/index.js';
export type { McpServerConfig, McpConfig, McpTool, McpConnection } from './mcp/index.js';

// --- Provider ---
export {
  FailoverError,
  isFailoverError,
  isContextOverflowError,
  isRateLimitError,
  isTimeoutError,
  isServerError,
  isTransientError,
  isAuthError,
  classifyFailoverReason,
  isFailoverErrorMessage,
  retryAsync,
  describeError,
} from './provider/index.js';
export type { FailoverReason, RetryOptions } from './provider/index.js';

/** @internal Pi-AI adapter message conversion. */
export { convertMessagesToPi } from './core/index.js';

// --- Spawn Profile ---
export type { SpawnToolScope } from './core/index.js';
export {
  SpawnProfileRegistry,
  SPAWN_TOOL_SCOPE_SETS,
  createSpawnProfileRegistryFromDefaults,
  getDefaultSpawnProfileRegistry,
  resolveSpawnToolSet,
  buildSubagentPromptAddon,
  registerSpawnToolExtensions,
} from './core/index.js';

// --- Built-in Tools ---
export {
  builtinTools,
  registerBuiltinTools,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  execTool,
  searchFilesTool,
  searchCodeTool,
  webFetchTool,
  applyPatchTool,
} from './tools/builtin.js';

// --- Web Tools (generic http fetch, SSRF-safe, no external deps) ---
export { createWebFetchTool, type WebFetchOptions } from './tools/web-fetch.js';

// --- Logger (unified logging, aligned with docs/logging.md) ---
export {
  createLogger,
  configureRootLogger,
  getRootLogger,
  redactSensitive,
  type LogLevel,
  type LogEntry,
  type Logger,
  type LoggerOptions,
} from './logger.js';

// --- Errors (actionable error classification, aligned with docs/logging.md) ---
export {
  ErrorCode,
  DmossError,
  isDmossError,
  throwDmoss,
  wrapAsDmoss,
  formatDmossError,
  isDmossErrorRecoverable,
  type DmossErrorDetails,
} from './errors.js';

// --- Observability (tracing, redaction, LLM usage logging) ---
export {
  redactSensitiveData,
  parseTelemetryAllow,
  TraceRegistry,
  setTracer,
  getTracer,
  withSpan,
  turnAttributes,
  toolAttributes,
  llmRequestAttributes,
  logLLMUsage,
  readUsageLog,
  summarizeUsage,
  formatUsageSummary,
  estimateLLMCost,
  registerModelPricing,
} from './observability/index.js';
export type {
  RedactOptions,
  Tracer,
  TraceSpan,
  LLMUsageRecord,
  LLMUsageSummary,
} from './observability/index.js';

// --- Tool Hooks (pre/post execution pipeline) ---
export { ToolHookRegistry } from './core/index.js';
export type {
  PreToolUseHook,
  PostToolUseHook,
  PostToolUseFailureHook,
  PreToolUseDecision,
} from './core/index.js';
