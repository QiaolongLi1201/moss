/**
 * Tool Hooks — pre/post tool execution interceptor framework.
 *
 * Hooks form a pipeline around tool execution:
 * - PreToolUse: permission checks, input validation, audit logging
 * - PostToolUse: result sanitization, caching, statistics
 * - PostToolUseFailure: error recovery hints
 */

import type { Tool, ToolContext } from './tool-types.js';

export type PreToolUseDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: string }
  | { action: 'modify'; input: Record<string, unknown>; reason?: string };

export interface PreToolUseHook {
  name: string;
  priority: number;
  check(params: {
    tool: Tool;
    input: Record<string, unknown>;
    ctx: ToolContext;
    sessionId: string;
  }): Promise<PreToolUseDecision | null>;
}

export interface PostToolUseHook {
  name: string;
  priority: number;
  process(params: {
    tool: Tool;
    input: Record<string, unknown>;
    result: string;
    isError: boolean;
    durationMs: number;
    ctx: ToolContext;
    sessionId: string;
  }): Promise<{ result: string } | null>;
}

export interface PostToolUseFailureHook {
  name: string;
  priority: number;
  process(params: {
    tool: Tool;
    input: Record<string, unknown>;
    result: string;
    durationMs: number;
    ctx: ToolContext;
    sessionId: string;
  }): Promise<{ result: string } | null>;
}

export class ToolHookRegistry {
  private preHooks: PreToolUseHook[] = [];
  private postHooks: PostToolUseHook[] = [];
  private postFailureHooks: PostToolUseFailureHook[] = [];

  registerPre(hook: PreToolUseHook): void {
    this.preHooks.push(hook);
    this.preHooks.sort((a, b) => a.priority - b.priority);
  }

  registerPost(hook: PostToolUseHook): void {
    this.postHooks.push(hook);
    this.postHooks.sort((a, b) => a.priority - b.priority);
  }

  registerPostFailure(hook: PostToolUseFailureHook): void {
    this.postFailureHooks.push(hook);
    this.postFailureHooks.sort((a, b) => a.priority - b.priority);
  }

  async runPreHooks(params: {
    tool: Tool;
    input: Record<string, unknown>;
    ctx: ToolContext;
    sessionId: string;
  }): Promise<{ decision: PreToolUseDecision; hookName?: string }> {
    let currentInput = params.input;

    for (const hook of this.preHooks) {
      try {
        const decision = await hook.check({ ...params, input: currentInput });
        if (!decision) continue;
        if (decision.action === 'block') return { decision, hookName: hook.name };
        if (decision.action === 'modify') currentInput = decision.input;
      } catch (err) {
        process.stderr.write(
          `[tool-hooks] PreToolUse hook "${hook.name}" error: ${err instanceof Error ? err.message : err}\n`,
        );
      }
    }

    return { decision: { action: 'allow' } };
  }

  async runPostHooks(params: {
    tool: Tool;
    input: Record<string, unknown>;
    result: string;
    isError: boolean;
    durationMs: number;
    ctx: ToolContext;
    sessionId: string;
  }): Promise<string> {
    let currentResult = params.result;
    for (const hook of this.postHooks) {
      try {
        const modification = await hook.process({ ...params, result: currentResult });
        if (modification) currentResult = modification.result;
      } catch (err) {
        process.stderr.write(
          `[tool-hooks] PostToolUse hook "${hook.name}" error: ${err instanceof Error ? err.message : err}\n`,
        );
      }
    }
    return currentResult;
  }

  async runPostFailureHooks(params: {
    tool: Tool;
    input: Record<string, unknown>;
    result: string;
    durationMs: number;
    ctx: ToolContext;
    sessionId: string;
  }): Promise<string> {
    let currentResult = params.result;
    for (const hook of this.postFailureHooks) {
      try {
        const modification = await hook.process({ ...params, result: currentResult });
        if (modification) currentResult = modification.result;
      } catch (err) {
        process.stderr.write(
          `[tool-hooks] PostToolUseFailure hook "${hook.name}" error: ${err instanceof Error ? err.message : err}\n`,
        );
      }
    }
    return currentResult;
  }
}

export function createPreToolSecretScanHook(
  containsSecretsFn: (text: string) => boolean,
): PreToolUseHook {
  return {
    name: 'pre-tool-secret-scan',
    priority: 0,
    async check({ tool, input }) {
      const inputStr = JSON.stringify(input);
      if (containsSecretsFn(inputStr)) {
        return {
          action: 'block',
          reason: `Blocked: tool "${tool.name}" input contains what appears to be a secret or credential. ` +
                  `Remove sensitive values from tool arguments before retrying.`,
        };
      }
      return null;
    },
  };
}

/** Tool names that make outbound network requests. */
const NETWORK_TOOLS = new Set(['web_fetch', 'web_search', 'device_ssh', 'docker_exec']);

export function createEgressDomainGuardHook(
  allowedDomains?: ReadonlySet<string>,
): PreToolUseHook {
  return {
    name: 'egress-domain-guard',
    priority: 1,
    async check({ tool, input }) {
      if (!NETWORK_TOOLS.has(tool.name)) return null;
      if (!allowedDomains || allowedDomains.size === 0) return null;
      const url = typeof input.url === 'string' ? input.url
        : typeof input.host === 'string' ? input.host
        : '';
      if (!url) return null;
      try {
        const hostname = new URL(url.startsWith('http') ? url : `http://${url}`).hostname;
        if (!allowedDomains.has(hostname)) {
          return {
            action: 'block',
            reason: `Blocked: tool "${tool.name}" targets domain "${hostname}" which is not in the egress allowlist.`,
          };
        }
      } catch {
        // Malformed URL — let the tool itself handle the error
      }
      return null;
    },
  };
}

export function createSecretSanitizerHook(
  sanitize: (text: string) => string,
): PostToolUseHook {
  return {
    name: 'secret-sanitizer',
    priority: 10,
    async process({ result }) {
      const sanitized = sanitize(result);
      return sanitized !== result ? { result: sanitized } : null;
    },
  };
}

export function createTimingHook(
  onTiming: (toolName: string, durationMs: number, isError: boolean) => void,
): PostToolUseHook {
  return {
    name: 'timing',
    priority: 100,
    async process({ tool, durationMs, isError }) {
      onTiming(tool.name, durationMs, isError);
      return null;
    },
  };
}

export function createReadOnlyHook(
  isWriteTool: (toolName: string) => boolean,
): PreToolUseHook {
  return {
    name: 'read-only',
    priority: 1,
    async check({ tool }) {
      if (isWriteTool(tool.name)) {
        return { action: 'block', reason: 'Read-only mode — write operations are not allowed' };
      }
      return null;
    },
  };
}

export function createExecLikeFailureHintHook(
  isExecLike: (toolName: string) => boolean = (name) => name === 'exec' || name === 'device_exec',
): PostToolUseFailureHook {
  const hint =
    '\n\n[Recovery hint] Verify: correct environment (local vs SSH device), working directory, absolute paths, permissions, dependencies, and network; try simplifying to a single command.';
  return {
    name: 'exec-like-failure-hint',
    priority: 50,
    async process({ tool, result }) {
      if (!isExecLike(tool.name)) return null;
      if (result.includes('[Recovery hint]')) return null;
      return { result: result + hint };
    },
  };
}
