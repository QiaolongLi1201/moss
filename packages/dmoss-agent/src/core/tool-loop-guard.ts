import { stableSerializeToolInput } from './tool-idempotent-replay.js';

const DEFAULT_TOOL_LOOP_IDENTICAL_LIMIT = 2;
const DEFAULT_TOOL_LOOP_SINGLE_TOOL_LIMIT = 24;
const DEFAULT_TOOL_LOOP_TOTAL_LIMIT = 64;

export type ToolLoopGuardState = {
  bySignature: Map<string, number>;
  byTool: Map<string, number>;
  total: number;
};

function resolvePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function createToolLoopGuardState(): ToolLoopGuardState {
  return {
    bySignature: new Map(),
    byTool: new Map(),
    total: 0,
  };
}

export function formatToolLoopGuardMessage(reason: string, toolName: string): string {
  return [
    `[dmoss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
    'Do not retry the same preset tool path immediately.',
    'If the preset tool is failing, pivot to an independent evidence source such as web_search/web_fetch, local knowledge/files, lower-level device commands, or a simpler diagnostic tool.',
    'Then summarize what changed and continue only with a new approach, or ask the user for the missing decision.',
  ].join(' ');
}

export function shouldShortCircuitToolCall(
  state: ToolLoopGuardState,
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  const identicalLimit = resolvePositiveIntEnv(
    'DMOSS_TOOL_LOOP_IDENTICAL_LIMIT',
    DEFAULT_TOOL_LOOP_IDENTICAL_LIMIT,
  );
  const singleToolLimit = resolvePositiveIntEnv(
    'DMOSS_TOOL_LOOP_SINGLE_TOOL_LIMIT',
    DEFAULT_TOOL_LOOP_SINGLE_TOOL_LIMIT,
  );
  const totalLimit = resolvePositiveIntEnv(
    'DMOSS_TOOL_LOOP_TOTAL_LIMIT',
    DEFAULT_TOOL_LOOP_TOTAL_LIMIT,
  );
  const signature = `${toolName}:${stableSerializeToolInput(input)}`;
  const sameSignatureCount = state.bySignature.get(signature) ?? 0;
  const sameToolCount = state.byTool.get(toolName) ?? 0;

  if (sameSignatureCount >= identicalLimit) {
    return `identical input was already requested ${sameSignatureCount} time(s) in this user turn`;
  }
  if (sameToolCount >= singleToolLimit) {
    return `${toolName} has already been requested ${sameToolCount} time(s) in this user turn`;
  }
  if (state.total >= totalLimit) {
    return `the user turn already requested ${state.total} tool call(s)`;
  }

  state.bySignature.set(signature, sameSignatureCount + 1);
  state.byTool.set(toolName, sameToolCount + 1);
  state.total += 1;
  return null;
}
