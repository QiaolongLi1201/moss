import { stableSerializeToolInput } from './tool-idempotent-replay.js';
import { readEnv } from '../../utils/env-compat.js';

// A tool that keeps ERRORING in one turn (e.g. web_fetch on a dead/SPA URL tried
// with many different URLs) trips far sooner than the by-name limit, so the agent
// stops the wasteful retry-different-variation loop and answers honestly with what
// it has instead of grinding to the timeout.
// Local workspace work often needs many distinct reads/edits in one turn. If a
// host/user opts into by-tool budgets, do not cap these by tool name alone.
const SINGLE_TOOL_LIMIT_EXEMPT_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'move_file',
  'apply_patch',
  'list_directory',
  'search_files',
  'search_code',
  'device_file_read',
  'device_file_list',
]);

export type ToolLoopGuardState = {
  bySignature: Map<string, number>;
  byTool: Map<string, number>;
  byToolFailure: Map<string, number>;
  total: number;
};

function resolveOptionalPositiveIntEnv(name: string): number | undefined {
  const raw = readEnv(name);
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function createToolLoopGuardState(): ToolLoopGuardState {
  return {
    bySignature: new Map(),
    byTool: new Map(),
    byToolFailure: new Map(),
    total: 0,
  };
}

/**
 * Some tools report failure "softly" — they return a normal (is_error=false)
 * result whose TEXT is an error marker rather than throwing (e.g. web_fetch on a
 * 404 returns `web_fetch_error: HTTP 404 ...`). Detect those by result prefix so
 * the failure guard still counts them. Prefix-anchored to avoid matching error
 * strings that merely appear inside a successfully fetched page body.
 */
export function isSoftToolFailureResult(resultText: string | undefined): boolean {
  if (!resultText) return false;
  return /^\s*(web_fetch_error|web_search_error)\b/i.test(resultText)
    || /^\s*\S+\s+blocked automated access/i.test(resultText);
}

/**
 * Record whether a tool call failed, so the guard can short-circuit a tool that
 * keeps failing in a turn before it grinds to the timeout. Call this after each
 * tool execution. Only failures accumulate (a working tool is never penalised).
 * `resultText` lets soft failures (error text in a non-error result) count too.
 */
export function recordToolLoopOutcome(
  state: ToolLoopGuardState,
  toolName: string,
  isError: boolean,
  resultText?: string,
): void {
  if (!isError && !isSoftToolFailureResult(resultText)) return;
  state.byToolFailure.set(toolName, (state.byToolFailure.get(toolName) ?? 0) + 1);
}

export function formatToolLoopGuardMessage(reason: string, toolName: string): string {
  if (/has failed \d+ time/.test(reason)) {
    // Repeated FAILURE of the same tool: the problem is the tool can't deliver, so
    // tell the model to STOP (not "pivot and retry", which causes the try-another-
    // URL/query loop) and answer honestly with what it already has.
    return [
      `[dmoss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
      `${toolName} is not returning usable results right now — STOP calling it.`,
      'Do NOT keep trying variations (different URLs, queries, or paths); that only wastes the turn.',
      'Answer the user with what you already have and state plainly that you could not retrieve the rest via this tool (and why). Never invent, assume, or describe the content you could not actually fetch.',
    ].join(' ');
  }
  return [
    `[dmoss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
    'Do not retry the same preset tool path immediately.',
    'If the preset tool is failing, pivot to an independent evidence source such as an available Web tool (for example web_fetch), local knowledge/files, lower-level device commands, or a simpler diagnostic tool.',
    'Then summarize what changed and continue only with a new approach, or ask the user for the missing decision.',
  ].join(' ');
}

export function shouldShortCircuitToolCall(
  state: ToolLoopGuardState,
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  const identicalLimit = resolveOptionalPositiveIntEnv('DMOSS_TOOL_LOOP_IDENTICAL_LIMIT');
  const singleToolLimit = resolveOptionalPositiveIntEnv('DMOSS_TOOL_LOOP_SINGLE_TOOL_LIMIT');
  const totalLimit = resolveOptionalPositiveIntEnv('DMOSS_TOOL_LOOP_TOTAL_LIMIT');
  const failureLimit = resolveOptionalPositiveIntEnv('DMOSS_TOOL_LOOP_FAILURE_LIMIT');
  const signature = `${toolName}:${stableSerializeToolInput(input)}`;
  const sameSignatureCount = state.bySignature.get(signature) ?? 0;
  const sameToolCount = state.byTool.get(toolName) ?? 0;
  const failureCount = state.byToolFailure.get(toolName) ?? 0;

  if (failureLimit !== undefined && failureCount >= failureLimit) {
    return `${toolName} has failed ${failureCount} time(s) in this user turn`;
  }
  if (identicalLimit !== undefined && sameSignatureCount >= identicalLimit) {
    return `identical input was already requested ${sameSignatureCount} time(s) in this user turn`;
  }
  if (
    singleToolLimit !== undefined
    && !SINGLE_TOOL_LIMIT_EXEMPT_TOOLS.has(toolName)
    && sameToolCount >= singleToolLimit
  ) {
    return `${toolName} has already been requested ${sameToolCount} time(s) in this user turn`;
  }
  if (totalLimit !== undefined && state.total >= totalLimit) {
    return `the user turn already requested ${state.total} tool call(s)`;
  }

  state.bySignature.set(signature, sameSignatureCount + 1);
  state.byTool.set(toolName, sameToolCount + 1);
  state.total += 1;
  return null;
}
