/**
 * Steering Engine — injects guidance messages into the conversation
 * based on configurable heuristics.
 *
 * Inspired by the publicly observable steering behaviour in agent products
 * such as Claude Code: the engine evaluates rules
 * each turn and, when triggered, prepends a steering system message so the
 * LLM can self-correct without user intervention.
 *
 * Built-in rules handle:
 *  - Consecutive tool errors → nudge alternative approaches
 *  - Stuck tool loops → nudge summarization
 *  - Context pressure → nudge conciseness
 */

import type { LLMMessage, LLMContentBlock } from './llm-provider.js';

export interface SteeringContext {
  messages: LLMMessage[];
  turn: number;
  consecutiveToolErrors: number;
  totalToolCalls: number;
  /** Estimated token usage ratio (0–1) relative to context window */
  contextUsageRatio: number;
  sessionKey: string;
}

export interface SteeringRule {
  id: string;
  priority: number;
  cooldownTurns: number;
  check(ctx: SteeringContext): string | null;
}

export interface SteeringResult {
  triggered: boolean;
  /** Guidance messages to inject (empty when not triggered) */
  guidances: string[];
  /** IDs of rules that fired */
  firedRules: string[];
}

// ─── Built-in rules ─────────────────────────────────────────────

const CONSECUTIVE_ERROR_THRESHOLD = 3;
const TOOL_LOOP_THRESHOLD = 8;
const CONTEXT_PRESSURE_RATIO = 0.75;

export const BUILTIN_ERROR_RECOVERY_RULE: SteeringRule = {
  id: 'error-recovery',
  priority: 10,
  cooldownTurns: 4,
  check(ctx) {
    if (ctx.consecutiveToolErrors < CONSECUTIVE_ERROR_THRESHOLD) return null;
    return [
      '[Steering] Multiple consecutive tool errors detected.',
      'Stop retrying the same preset tool path. First verify the command/path/arguments, then pivot to an independent evidence source:',
      'web_search/web_fetch for public facts, local files/knowledge for product context, lower-level device commands for board state,',
      'or a simpler diagnostic tool. Ask the user only when the missing decision cannot be inferred.',
    ].join(' ');
  },
};

export const BUILTIN_TOOL_LOOP_RULE: SteeringRule = {
  id: 'tool-loop',
  priority: 20,
  cooldownTurns: 6,
  check(ctx) {
    if (ctx.turn < TOOL_LOOP_THRESHOLD) return null;
    const recentAssistant = ctx.messages
      .slice(-12)
      .filter((m) => m.role === 'assistant');
    const allToolUse = recentAssistant.every((m) => {
      if (typeof m.content === 'string') return false;
      return (m.content as LLMContentBlock[]).some((b) => b.type === 'tool_use');
    });
    if (!allToolUse || recentAssistant.length < 4) return null;
    return [
      '[Steering] Extended tool loop detected — you have been executing tools for many turns.',
      'Pause the current tool chain and summarize what evidence is already known.',
      'If the preset tool path is not working, switch to a different source of evidence before asking the user how to proceed.',
    ].join(' ');
  },
};

export const BUILTIN_CONTEXT_PRESSURE_RULE: SteeringRule = {
  id: 'context-pressure',
  priority: 30,
  cooldownTurns: 10,
  check(ctx) {
    if (ctx.contextUsageRatio < CONTEXT_PRESSURE_RATIO) return null;
    const pct = Math.round(ctx.contextUsageRatio * 100);
    return [
      `[Steering] Context window is ${pct}% full.`,
      'Be concise in your responses. Summarize tool outputs instead of echoing them.',
      'Consider completing the current task and providing a summary.',
    ].join(' ');
  },
};

export const DEFAULT_STEERING_RULES: SteeringRule[] = [
  BUILTIN_ERROR_RECOVERY_RULE,
  BUILTIN_TOOL_LOOP_RULE,
  BUILTIN_CONTEXT_PRESSURE_RULE,
];

// ─── Engine ─────────────────────────────────────────────────────

export class SteeringEngine {
  private rules: SteeringRule[];
  private lastFiredTurn = new Map<string, number>();

  constructor(rules?: SteeringRule[]) {
    this.rules = [...(rules ?? DEFAULT_STEERING_RULES)].sort(
      (a, b) => a.priority - b.priority,
    );
  }

  addRule(rule: SteeringRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => a.priority - b.priority);
  }

  evaluate(ctx: SteeringContext): SteeringResult {
    const guidances: string[] = [];
    const firedRules: string[] = [];

    for (const rule of this.rules) {
      const lastFired = this.lastFiredTurn.get(rule.id) ?? -Infinity;
      if (ctx.turn - lastFired < rule.cooldownTurns) continue;

      const guidance = rule.check(ctx);
      if (guidance) {
        guidances.push(guidance);
        firedRules.push(rule.id);
        this.lastFiredTurn.set(rule.id, ctx.turn);
      }
    }

    return {
      triggered: guidances.length > 0,
      guidances,
      firedRules,
    };
  }

  reset(): void {
    this.lastFiredTurn.clear();
  }
}
