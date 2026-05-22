export { sanitizeSecrets, containsSecrets } from './secret-sanitizer.js';
export {
  isCommandDangerous,
  isPathProtected,
  registerProtectedPaths,
  matchTextApproval,
  classifyFileKind,
  stripShellPrefixBeforeHeredoc,
} from './channel-safety.js';
export type {
  ChannelSource,
  ChannelSafetyResult,
  TextApprovalResult,
} from './channel-safety.js';

// Sandbox path resolution
export { resolveSandboxPath, assertSandboxPath } from './sandbox-paths.js';

// Shell soft failure hints
export {
  SHELL_SOFT_FAILURE_TOOL_NAMES,
  shouldAppendShellContinueHint,
  appendShellContinueHint,
} from './shell-soft-failure-hint.js';
