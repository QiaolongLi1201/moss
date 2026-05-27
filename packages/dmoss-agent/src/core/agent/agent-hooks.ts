/**
 * Agent Hooks — extension points for host applications to customize agent behavior.
 *
 * Hooks let the host observe and control the agent's execution flow without
 * modifying D-Moss internals. All hooks are optional.
 */

import type { Tool, ToolContext, ToolCall, ToolResult } from '../tools/tool-types.js';
import type { LLMStreamEvent, LLMResponse } from '../llm/llm-provider.js';

export interface ToolApprovalRequest {
  tool: Tool;
  input: Record<string, unknown>;
  sessionKey: string;
}

export type ToolApprovalDecision = { approved: true } | { approved: false; reason: string };

/**
 * Agent lifecycle hooks — host implements these to customize behavior.
 *
 * Example:
 * ```ts
 * const agent = new DmossAgent({
 *   hooks: {
 *     onBeforeToolExec: async (req) => {
 *       if (isDangerousCommand(req.input)) {
 *         const userApproved = await showApprovalDialog(req);
 *         return userApproved ? { approved: true } : { approved: false, reason: 'User denied' };
 *       }
 *       return { approved: true };
 *     },
 *     onToolResult: (call, result) => {
 *       logToAudit(call, result);
 *     },
 *     onStream: (event) => {
 *       socketEmit('dmoss:stream', event);
 *     },
 *   }
 * });
 * ```
 */
export interface AgentHooks {
  /**
   * Called before a tool is executed. Return `{ approved: false }` to block execution.
   * Useful for dangerous command approval, policy enforcement, etc.
   */
  onBeforeToolExec?(request: ToolApprovalRequest): Promise<ToolApprovalDecision>;

  /**
   * Called after a tool returns a result. Useful for logging, audit, analytics.
   */
  onToolResult?(call: ToolCall, result: ToolResult): void;

  /**
   * Called when the agent starts a new LLM request.
   */
  onLLMRequestStart?(opts: { model: string; messageCount: number; toolCount: number }): void;

  /**
   * Called when an LLM response completes.
   */
  onLLMResponseEnd?(response: LLMResponse): void;

  /**
   * Called on each stream event. Hosts use this for real-time UI updates.
   */
  onStream?(event: LLMStreamEvent): void;

  /**
   * Called when context compaction is triggered.
   */
  onCompaction?(opts: { messagesBefore: number; messagesAfter: number }): void;

  /**
   * Called when an error occurs during chat. Return true to retry, false to abort.
   */
  onError?(error: unknown, context: { attempt: number; sessionKey: string }): Promise<boolean>;

  /**
   * Called when a turn completes (LLM response + all tool executions for that turn).
   */
  onTurnComplete?(opts: { turn: number; maxTurns: number; toolCallCount: number }): void;

  /**
   * Custom ToolContext enrichment — host can inject additional fields into ToolContext
   * before each tool execution (e.g. device bindings, user session data).
   */
  enrichToolContext?(baseCtx: ToolContext, sessionKey: string): ToolContext;
}
