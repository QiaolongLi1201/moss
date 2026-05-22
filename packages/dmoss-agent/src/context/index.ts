export { ContextLoader, type ContextFile } from "./loader.js";
export {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_BOOTSTRAP_MAX_CHARS,
  buildBootstrapContextFiles,
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  resolveBootstrapMaxChars,
  registerNonMainChannelPrefixes,
  type BootstrapFile,
  type BootstrapFileName,
  type MemoryPolicy,
} from "./bootstrap.js";
export {
  DEFAULT_CONTEXT_PRUNING_SETTINGS,
  pruneContextMessages,
  resolvePruningSettings,
  type ContextPruningSettings,
  type ContextPruningToolMatch,
  type PruneResult,
} from "./pruning.js";
export {
  buildCompactionSummary,
  compactHistoryIfNeeded,
  computeAdaptiveChunkRatio,
  shouldTriggerCompaction,
  shouldProactiveCompact,
  type CompactionSettings,
  type SummarizeFn,
  DEFAULT_COMPACTION_SETTINGS,
  DEFAULT_SUMMARY_MAX_TOKENS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
} from "./compaction.js";
export {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateMessageChars,
  estimateMessageTokens,
  estimateMessagesChars,
  estimateMessagesTokens,
  estimateTokensForText,
  estimatePromptUnitsForContextWindow,
  resolveContextCharsPerTokenUnit,
} from "./tokens.js";
export {
  microcompact,
  DEFAULT_MICRO_COMPACT_CONFIG,
  type MicroCompactConfig,
  type MicroCompactResult,
} from "./microcompact.js";
export {
  invalidateStaleReadToolResults,
  STALE_READ_PLACEHOLDER,
  toolPathKey,
  type StaleReadInvalidateResult,
} from "./stale-read-invalidate.js";
export {
  snipTailOversizedToolResults,
  DEFAULT_TAIL_SNIP_CONFIG,
  type TailToolSnipConfig,
  type TailToolSnipResult,
} from "./tail-tool-snip.js";
export {
  getEffectiveContextWindowTokens,
  getProactiveCompactThreshold,
  getContextWarningThreshold,
  shouldProactiveCompactByWindowEconomics,
  AUTOCOMPACT_BUFFER_TOKENS,
  SUMMARY_OUTPUT_CAP_TOKENS,
} from "./window-economics.js";
export { compactSubagentSummaryForParent } from "./subagent-summary-compact.js";
export { truncateToolOutput, registerToolOutputLimits } from "./tool-output-truncate.js";
export {
  hybridCompact,
  createRemoteCompactProviderFromEnv,
  HttpRemoteCompactProvider,
  resolveRemoteCompactUrls,
  type RemoteCompactProvider,
  type RemoteCompactRequest,
  type RemoteCompactResponse,
  type HybridCompactionConfig,
} from "./remote-compaction.js";

// Context window guard
export {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  resolveContextWindowInfo,
  evaluateContextWindowGuard,
} from "./context-window-guard.js";
export type {
  ContextWindowSource,
  ContextWindowInfo,
  ContextWindowGuardResult,
} from "./context-window-guard.js";
