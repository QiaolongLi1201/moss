/**
 * Pure decision function for the post-LLM section of the agent loop.
 *
 * Given a snapshot of the current state after an LLM turn completes,
 * returns the next action the loop should take — without performing
 * any side effects.  The main loop is responsible for executing the
 * action (pushing events, mutating state, fetching steering messages).
 */

export type PostLlmAction =
  | { kind: 'thinking_retry'; systemText: string }
  | { kind: 'thinking_only_hint'; hintText: string }
  | { kind: 'continuation'; systemText: string }
  | { kind: 'nudge'; systemText: string; deltaText: string }
  | { kind: 'empty_retry' }
  | { kind: 'steering_or_complete' }
  | { kind: 'tool_execute' };

export interface PostLlmContext {
  hasThinkingOnly: boolean;
  toolCallCount: number;
  postToolThinkingOnlyRetryAttempts: number;
  totalToolCalls: number;
  streamStopReason: string | undefined;
  outputContinuationCount: number;
  maxOutputContinuations: number;
  planToolNudgeAttempts: number;
  finalText: string;
  maxTurns: number;
  turns: number;
  shouldNudge: boolean;
  hasSteeringMessages: boolean;
  abortAborted: boolean;
}

export function decidePostLlmAction(ctx: PostLlmContext): PostLlmAction {
  // --- Thinking-only: retry once when tools already ran ---
  if (
    ctx.hasThinkingOnly &&
    ctx.totalToolCalls > 0 &&
    ctx.postToolThinkingOnlyRetryAttempts < 1 &&
    ctx.turns < ctx.maxTurns &&
    !ctx.abortAborted
  ) {
    return {
      kind: 'thinking_retry',
      systemText:
        '[System] The tools already ran, but your previous assistant turn had no visible answer. ' +
        'Read the latest tool results and produce a concise visible user-facing summary now. ' +
        'Do not call more tools unless absolutely necessary.',
    };
  }

  // --- Thinking-only without prior tools: show user hint ---
  if (ctx.hasThinkingOnly) {
    // Caller builds the hint text via buildThinkingOnlyUserHint(totalToolCalls).
    return { kind: 'thinking_only_hint', hintText: '' };
  }

  // --- Output truncated by max_tokens: continue up to N times ---
  if (
    ctx.streamStopReason === 'length' &&
    ctx.toolCallCount === 0 &&
    ctx.outputContinuationCount < ctx.maxOutputContinuations &&
    !ctx.abortAborted &&
    !ctx.hasSteeringMessages
  ) {
    return {
      kind: 'continuation',
      systemText:
        '[System] Your previous response was truncated due to max_tokens. ' +
        'Continue from where you left off without repeating already-output content.',
    };
  }

  // --- Tool calls present: execute them ---
  if (ctx.toolCallCount > 0) {
    return { kind: 'tool_execute' };
  }

  // --- No tool calls: plan-tool nudge ---
  if (
    ctx.planToolNudgeAttempts < 1 &&
    ctx.turns < ctx.maxTurns &&
    ctx.shouldNudge
  ) {
    return {
      kind: 'nudge',
      systemText:
        '[System] You described using tools or opening a URL in plain text but did not emit any function/tool calls. ' +
        'You MUST invoke the appropriate tool now with valid JSON arguments for that URL/intent. ' +
        'Do not repeat the plan—call the tool immediately.',
      deltaText:
        '\n\n> （系统）检测到仅说明了工具与链接但未发起实际工具调用，已自动追加一轮对话以执行操作。\n',
    };
  }

  // --- Empty response: retry once with steering or synthetic ---
  if (!ctx.finalText.trim() && ctx.turns < ctx.maxTurns - 1) {
    return { kind: 'empty_retry' };
  }

  // --- Turn complete: fetch steering or end ---
  return { kind: 'steering_or_complete' };
}
