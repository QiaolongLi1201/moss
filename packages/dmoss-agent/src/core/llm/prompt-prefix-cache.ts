/**
 * Prompt prefix stability checks for cache-friendly LLM requests.
 *
 * Prompt cache hits require exact prefix matching:
 * - New prompts must be exact prefix extensions of previous prompts
 * - Modifying earlier messages breaks the prefix match
 * - Tool ordering changes invalidate the entire cache
 *
 * This module detects prefix violations so they can be logged and debugged.
 */

import type { Message, ContentBlock } from '../session/session-jsonl.js';
import { readEnvFlag } from '../../utils/env-compat.js';

export interface PromptPrefixStabilityIssue {
  kind: 'shorter' | 'changed' | 'role_changed' | 'content_modified';
  previousLength: number;
  currentLength: number;
  firstChangedIndex?: number;
  /** Human-readable description of what changed */
  detail?: string;
}

export interface PromptCacheEligibility {
  eligible: boolean;
  reason: 'disabled' | 'missing_stable_prefix' | 'stable_prefix_too_short' | 'dynamic_suffix_too_large' | 'eligible';
  stableChars: number;
  dynamicChars: number;
  minStableChars: number;
  maxDynamicCharsRatio: number;
}

export interface PromptCacheEligibilityOptions {
  enabled?: boolean;
  minStableChars?: number;
  maxDynamicCharsRatio?: number;
}

export const DEFAULT_PROMPT_CACHE_MIN_STABLE_CHARS = 2_048;
export const DEFAULT_PROMPT_CACHE_MAX_DYNAMIC_CHARS_RATIO = 0.25;

export function isPromptPrefixDebugEnabled(): boolean {
  return readEnvFlag('DMOSS_PROMPT_PREFIX_DEBUG');
}

export function assessPromptCacheEligibility(
  parts: { stable?: string; dynamic?: string } | undefined,
  options: PromptCacheEligibilityOptions = {},
): PromptCacheEligibility {
  const minStableChars = options.minStableChars ?? DEFAULT_PROMPT_CACHE_MIN_STABLE_CHARS;
  const maxDynamicCharsRatio = options.maxDynamicCharsRatio ?? DEFAULT_PROMPT_CACHE_MAX_DYNAMIC_CHARS_RATIO;
  const stableChars = parts?.stable?.length ?? 0;
  const dynamicChars = parts?.dynamic?.length ?? 0;

  if (options.enabled === false) {
    return {
      eligible: false,
      reason: 'disabled',
      stableChars,
      dynamicChars,
      minStableChars,
      maxDynamicCharsRatio,
    };
  }
  if (stableChars === 0) {
    return {
      eligible: false,
      reason: 'missing_stable_prefix',
      stableChars,
      dynamicChars,
      minStableChars,
      maxDynamicCharsRatio,
    };
  }
  if (stableChars < minStableChars) {
    return {
      eligible: false,
      reason: 'stable_prefix_too_short',
      stableChars,
      dynamicChars,
      minStableChars,
      maxDynamicCharsRatio,
    };
  }
  if (stableChars > 0 && dynamicChars / stableChars > maxDynamicCharsRatio) {
    return {
      eligible: false,
      reason: 'dynamic_suffix_too_large',
      stableChars,
      dynamicChars,
      minStableChars,
      maxDynamicCharsRatio,
    };
  }
  return {
    eligible: true,
    reason: 'eligible',
    stableChars,
    dynamicChars,
    minStableChars,
    maxDynamicCharsRatio,
  };
}

export function snapshotMessagesForPrefixCheck(messages: readonly Message[]): Message[] {
  return JSON.parse(JSON.stringify(messages)) as Message[];
}

function describeMessageChange(prev: Message, curr: Message, index: number): string {
  if (prev.role !== curr.role) {
    return `msg[${index}] role changed: ${prev.role} → ${curr.role}`;
  }
  const prevContent = JSON.stringify(prev.content);
  const currContent = JSON.stringify(curr.content);
  if (prevContent.length !== currContent.length) {
    return `msg[${index}] (${prev.role}) content length changed: ${prevContent.length} → ${currContent.length}`;
  }
  const prevBlocks = Array.isArray(prev.content) ? prev.content : [];
  const currBlocks = Array.isArray(curr.content) ? curr.content : [];
  if (prevBlocks.length !== currBlocks.length) {
    return `msg[${index}] (${prev.role}) block count changed: ${prevBlocks.length} → ${currBlocks.length}`;
  }
  for (let b = 0; b < prevBlocks.length; b++) {
    const pb = prevBlocks[b] as ContentBlock;
    const cb = currBlocks[b] as ContentBlock;
    if (pb?.type !== cb?.type) {
      return `msg[${index}] (${prev.role}) block[${b}] type changed: ${pb?.type} → ${cb?.type}`;
    }
  }
  return `msg[${index}] (${prev.role}) content modified (details differ)`;
}

export function checkPromptPrefixStable(
  previous: readonly Message[] | null,
  current: readonly Message[],
): PromptPrefixStabilityIssue | null {
  if (!previous || previous.length === 0) return null;

  if (current.length < previous.length) {
    return {
      kind: 'shorter',
      previousLength: previous.length,
      currentLength: current.length,
      detail: `Messages shrunk from ${previous.length} to ${current.length} (compaction or pruning may have modified prefix)`,
    };
  }

  for (let i = 0; i < previous.length; i++) {
    const prevStr = JSON.stringify(previous[i]);
    const currStr = JSON.stringify(current[i]);
    if (prevStr !== currStr) {
      const detail = describeMessageChange(previous[i], current[i], i);
      const kind = previous[i].role !== current[i].role ? 'role_changed' : 'content_modified';
      return {
        kind,
        previousLength: previous.length,
        currentLength: current.length,
        firstChangedIndex: i,
        detail,
      };
    }
  }

  return null;
}

/**
 * Verify that tool declarations are in consistent sorted order across turns.
 * Inconsistent tool ordering causes cache misses even when the tool set itself
 * has not changed.
 */
export function checkToolOrderConsistency(
  previousToolNames: readonly string[] | null,
  currentToolNames: readonly string[],
): { consistent: boolean; detail?: string } {
  if (!previousToolNames) return { consistent: true };
  if (previousToolNames.length !== currentToolNames.length) {
    return {
      consistent: false,
      detail: `Tool count changed: ${previousToolNames.length} → ${currentToolNames.length}`,
    };
  }
  for (let i = 0; i < previousToolNames.length; i++) {
    if (previousToolNames[i] !== currentToolNames[i]) {
      return {
        consistent: false,
        detail: `Tool order diverged at index ${i}: "${previousToolNames[i]}" → "${currentToolNames[i]}"`,
      };
    }
  }
  return { consistent: true };
}
