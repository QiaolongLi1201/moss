/**
 * Per-turn context management — runs at the start of each inner loop iteration
 * (before the LLM call) to keep the prompt size under control without invoking
 * the model's compaction.
 *
 * Order of operations is planned by ContextBudgetPlanner:
 *   1. invalidateStaleReadToolResults — drop superseded read-file/list outputs
 *   2. snipTailOversizedToolResults   — only when promptTokens >= warnLine
 *   3. microcompact                   — adaptive based on promptTokens vs lines
 *
 * All three operate **in place** on `currentMessages` and emit one aggregated
 * `context_action` MiniAgentEvent back through the supplied stream.push
 * callback. This module does NOT cover the LLM-based proactive compaction
 * (which lives one layer above) nor the prune/repair/pi-context-build that
 * follows.
 */

import { invalidateStaleReadToolResults } from '../../context/stale-read-invalidate.js';
import { snipTailOversizedToolResults } from '../../context/tail-tool-snip.js';
import { microcompact } from '../../context/microcompact.js';
import type { Message } from '../session/session-jsonl.js';
import type { ContextActionSummary, MiniAgentEvent } from '../subagent/agent-events.js';
import { planContextBudgetActions } from './context-budget-planner.js';

export interface PerTurnContextMgmtParams {
  currentMessages: Message[];
  estPromptTokens: number;
  effectiveContextWindowTokens: number;
  pendingToolResultFollowUp: boolean;
  turns: number;
  push: (event: MiniAgentEvent) => void;
}

/**
 * Result reports total savedChars so the caller can update its run-wide
 * `microcompactTotalSavedChars` metric without exposing internal state.
 */
export interface PerTurnContextMgmtResult {
  savedChars: number;
  savedTokens?: number;
}

/**
 * Run cheap, in-place context size reductions for the current turn.
 *
 * Skips entirely on first turn (`turns <= 1`) or when the last message is a
 * tool_result (because mutating that fragment of the conversation can break
 * the upcoming follow-up LLM call's tool_use ↔ tool_result pairing).
 */
export function runPerTurnContextManagement(
  params: PerTurnContextMgmtParams,
): PerTurnContextMgmtResult {
  const { currentMessages, estPromptTokens, pendingToolResultFollowUp, turns, push } = params;

  // Skip context management on first turn or when the last message is a
  // tool_result (must preserve tool_use ↔ tool_result pairing).
  if (turns <= 1) {
    return { savedChars: 0, savedTokens: 0 };
  }
  const lastMsg = currentMessages[currentMessages.length - 1];
  if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
    const hasToolResult = lastMsg.content.some(
      (b: { type?: string }) => b && typeof b === 'object' && b.type === 'tool_result',
    );
    if (hasToolResult && pendingToolResultFollowUp) {
      return { savedChars: 0, savedTokens: 0 };
    }
  }

  const plan = planContextBudgetActions({
    estimatedPromptTokens: estPromptTokens,
    effectiveContextWindowTokens: params.effectiveContextWindowTokens,
    isToolFollowUpRound: pendingToolResultFollowUp,
    turn: turns,
  });

  if (plan.actions.length === 0) {
    return { savedChars: 0 };
  }

  let savedChars = 0;
  let savedTokens = 0;
  const contextActions: ContextActionSummary[] = [];

  for (const action of plan.actions) {
    if (action.kind === 'invalidate_stale_reads') {
      const staleInv = invalidateStaleReadToolResults(currentMessages);
      if (staleInv.savedChars > 0) {
        currentMessages.splice(0, currentMessages.length, ...staleInv.messages);
        savedChars += staleInv.savedChars;
        savedTokens += staleInv.savedTokens;
        contextActions.push({
          kind: action.kind,
          reason: action.reason,
          count: staleInv.invalidatedCount,
          savedChars: staleInv.savedChars,
          savedTokens: staleInv.savedTokens,
        });
      }
      continue;
    }

    if (action.kind !== 'snip_tail_tool_results') continue;
    const tailSnip = snipTailOversizedToolResults(currentMessages);
    if (tailSnip.savedChars > 0) {
      currentMessages.splice(0, currentMessages.length, ...tailSnip.messages);
      savedChars += tailSnip.savedChars;
      savedTokens += tailSnip.savedTokens;
      contextActions.push({
        kind: action.kind,
        reason: action.reason,
        count: tailSnip.snippedCount,
        savedChars: tailSnip.savedChars,
        savedTokens: tailSnip.savedTokens,
      });
    }
  }

  for (const action of plan.actions) {
    if (action.kind !== 'microcompact') continue;
    const mcResult = microcompact(currentMessages, action.microcompactConfig);
    if (mcResult.compressedCount > 0) {
      currentMessages.splice(0, currentMessages.length, ...mcResult.messages);
      savedChars += mcResult.savedChars;
      savedTokens += mcResult.savedTokens;
      contextActions.push({
        kind: action.kind,
        reason: action.reason,
        count: mcResult.compressedCount,
        savedChars: mcResult.savedChars,
        savedTokens: mcResult.savedTokens,
      });
    }
  }

  if (contextActions.length > 0) {
    push({
      type: 'context_action',
      reason: plan.reason,
      actions: contextActions,
      savedChars,
      savedTokens,
    });
  }

  return { savedChars };
}
