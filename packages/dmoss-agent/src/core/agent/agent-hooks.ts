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

export interface InputGuardrailRequest {
  sessionKey: string;
  runId: string;
  userMessage: string;
  platform?: string;
}

export type InputGuardrailDecision =
  | { approved: true; userMessage?: string }
  | { approved: false; reason: string };

export interface OutputGuardrailRequest {
  sessionKey: string;
  runId: string;
  turn: number;
  response: string;
  stopReason?: string;
  platform?: string;
}

export type OutputGuardrailDecision =
  | { approved: true; response?: string }
  | { approved: false; reason: string; response?: string };

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
   * Called before a user message is appended to the session or sent to the LLM.
   * Return `{ approved: false }` to fail closed without persisting the message,
   * or return `{ approved: true, userMessage }` to normalize the input.
   */
  onInputGuardrail?(request: InputGuardrailRequest): Promise<InputGuardrailDecision>;

  /**
   * Called after a visible assistant answer is assembled, but before it is
   * streamed to product UI, appended to the session, or returned in ChatResult.
   * When this hook is configured, D-Moss buffers visible deltas until the
   * decision is available so rejected content is not leaked through streaming.
   */
  onOutputGuardrail?(request: OutputGuardrailRequest): Promise<OutputGuardrailDecision>;

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
   * Called on each raw provider stream event. Use this for diagnostics or
   * provider-level telemetry; product UIs should consume `streamChat()` events
   * so retry attempts and agent-level semantics are handled by the runtime.
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
