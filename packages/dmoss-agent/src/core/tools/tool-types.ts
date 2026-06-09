/**
 * D-Moss Agent tool system types — generic tool definition, context, and result types.
 *
 * Host applications extend ToolContext with product-specific fields.
 */

/**
 * Tool execution context — the base context available to every tool.
 * Host applications can extend this via intersection types
 * to add product-specific fields (device bindings, etc.).
 */
import type { MossAsyncTaskRegistry } from '@rdk-moss/core/contracts/async-task';

export interface SubagentRunProgress {
  runId: string;
  scope: string;
  task: string;
  status: 'started' | 'running' | 'completed' | 'failed';
  phase?: 'starting' | 'turn' | 'tool' | 'completed' | 'failed';
  turn?: number;
  maxTurns?: number;
  toolResults?: number;
  lastTool?: string;
  error?: string;
  summaryPreview?: string;
  elapsedMs?: number;
}

export interface ToolContext {
  workspaceDir: string;
  bootstrapDir?: string;
  extraAllowedRoots?: string[];
  runId?: string;
  sessionKey: string;
  sessionId?: string;
  agentId?: string;
  abortSignal?: AbortSignal;
  asyncTaskRegistry?: MossAsyncTaskRegistry;
  toolCallId?: string;
  spawnSubagent?: (params: {
    task: string;
    label?: string;
    cleanup?: 'keep' | 'delete';
    scope?: string;
    maxTurns?: number;
    timeoutMs?: number;
    mode?: 'single' | 'fan-out' | 'pipeline';
    tasks?: Array<{ task: string; scope?: string }>;
    abortSignal?: AbortSignal;
    onProgress?: (progress: SubagentRunProgress) => void;
  }) => Promise<{
    runId: string;
    sessionKey: string;
    summary: string;
    success: boolean;
    turns?: number;
    toolResults?: number;
    durationMs?: number;
    error?: string;
  }>;
  maxSpawnDepth?: number;
  currentSpawnDepth?: number;
}

/**
 * Tool interface — defines a tool that the LLM can invoke.
 *
 * Generic TInput allows type-safe parameter definitions during development.
 */

export type ToolSideEffectClass =
  | 'readonly'
  | 'local_write'
  | 'device_mutation'
  | 'credential'
  | 'external_message'
  | 'memory_write'
  | 'runtime_state'
  | 'subagent';

export type ToolPlanMode = 'allow' | 'audit' | 'requires_user_confirmation';

export interface ToolMetadata {
  permissionBoundary?: string;
  sideEffectClass?: ToolSideEffectClass;
  planMode?: ToolPlanMode;
  /**
   * Explicit approval override for tools whose side-effect class is not enough
   * to decide whether an interactive prompt is useful.
   */
  requiresApproval?: boolean;
  ui?: {
    surface?: 'timeline' | 'block' | 'silent';
  };
  /** Per-tool execution timeout in ms. Falls back to platform default when unset. */
  timeoutMs?: number;
  /** Whether this tool is eligible for internal transient-failure retry. */
  transientRetry?: boolean;
}

export interface Tool<TInput = any> {
  name: string;
  description: string;
  metadata?: ToolMetadata;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /**
   * Optional deterministic input normalizer run before tool_start/tool_execute.
   * Use this for tool-specific guardrails where the safe value can be derived
   * locally from the model's arguments, so UI events and persisted tool_use
   * blocks reflect the actual call.
   */
  normalizeInput?: (input: TInput, ctx?: Pick<ToolContext, 'sessionKey' | 'sessionId'>) => TInput;
  execute: (input: TInput, ctx: ToolContext) => Promise<string>;
  executeStructured?: (input: TInput, ctx: ToolContext) => Promise<StructuredToolResult>;
}

/**
 * 宿主侧「意图注入」：仅当工具 JSON Schema **无必填字段** 时，可用 `{}` 安全代调；
 * 若 `required` 非空，必须由模型在协议中产出 `tool_calls`（或用户补充参数），不可盲注。
 */
export function canHostInjectToolWithEmptyInput(tool: Tool): boolean {
  const req = tool.inputSchema?.required;
  return !req || req.length === 0;
}

/** Parsed tool_use block from the LLM response */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ToolResultOutcome = 'ok' | 'error' | 'denied' | 'blocked' | 'replayed' | 'suppressed';

/** Result of tool execution, returned to the LLM */
export interface ToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
  /** Terminal execution classification for audit/UI consumers. */
  outcome?: ToolResultOutcome;
  /** Wall-clock execution time in milliseconds when known. */
  durationMs?: number;
  /** Host-provided metadata for user/timeout cancellation; consumers may ignore it. */
  aborted?: { by: 'user' | 'timeout' };
  structuredContent?: ToolContentBlock[];
}

export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; alt?: string }
  | { type: 'resource'; uri: string; name?: string; mimeType?: string; text?: string };

export interface StructuredToolResult {
  content: ToolContentBlock[];
  isError?: boolean;
}
