/**
 * Tool execution pre-pipeline — schema validation + pre-hooks.
 */

import type { Tool } from './tool-types.js';

export type PreToolHookContext = {
  toolName: string;
  input: Record<string, unknown>;
  sessionKey: string;
};

export type PreToolHookResult =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; message: string };

export type PreToolHook = (ctx: PreToolHookContext) => Promise<PreToolHookResult>;

const preToolHooks: PreToolHook[] = [];

export function registerPreToolHook(hook: PreToolHook): () => void {
  preToolHooks.push(hook);
  return () => {
    const i = preToolHooks.indexOf(hook);
    if (i !== -1) preToolHooks.splice(i, 1);
  };
}

export function clearPreToolHooksForTests(): void {
  preToolHooks.length = 0;
}

type JsonSchemaProperty = {
  type?: string;
  enum?: unknown[];
};

function formatZodToolError(toolName: string, err: { issues: Array<{ path: Array<string | number>; message: string }> }): string {
  const detail = err.issues
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : 'root'}: ${i.message}`)
    .join('; ');
  return `${toolName}: input validation failed — ${detail}`;
}

export function validateToolInputObject(
  tool: Tool,
  input: unknown,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: `${tool.name}: tool input must be a JSON object` };
  }
  const obj = input as Record<string, unknown>;
  const schema = tool.inputSchema as {
    type?: string;
    required?: string[];
    properties?: Record<string, JsonSchemaProperty>;
  } | undefined;
  if (!schema || schema.type !== 'object') {
    return { ok: true, value: obj };
  }
  const required = schema.required ?? [];
  for (const key of required) {
    if (!(key in obj) || obj[key] === undefined) {
      return { ok: false, message: `${tool.name}: missing required parameter "${key}"` };
    }
  }
  const props = schema.properties;
  if (props) {
    for (const key of Object.keys(obj)) {
      const spec = props[key];
      if (!spec) continue;
      const v = obj[key];
      if (v === undefined) continue;
      if (spec.enum !== undefined && spec.enum.length > 0) {
        if (!spec.enum.some((e) => Object.is(e, v))) {
          return { ok: false, message: `${tool.name}: parameter "${key}" must be one of the enum values` };
        }
        continue;
      }
      if ((tool as unknown as Record<string, unknown>).inputZodSchema) continue;
      if (!spec.type) continue;
      const t = spec.type;
      if (t === 'string' && typeof v !== 'string') return { ok: false, message: `${tool.name}: parameter "${key}" should be string` };
      if (t === 'number' && (typeof v !== 'number' || Number.isNaN(v))) return { ok: false, message: `${tool.name}: parameter "${key}" should be number` };
      if (t === 'integer' && (typeof v !== 'number' || !Number.isInteger(v))) return { ok: false, message: `${tool.name}: parameter "${key}" should be integer` };
      if (t === 'boolean' && typeof v !== 'boolean') return { ok: false, message: `${tool.name}: parameter "${key}" should be boolean` };
      if (t === 'array' && !Array.isArray(v)) return { ok: false, message: `${tool.name}: parameter "${key}" should be array` };
      if (t === 'object' && (v === null || typeof v !== 'object' || Array.isArray(v))) return { ok: false, message: `${tool.name}: parameter "${key}" should be object` };
    }
  }
  const zodSchema = (tool as unknown as Record<string, unknown>).inputZodSchema as { safeParse: (data: unknown) => { success: boolean; data?: unknown; error?: { issues: Array<{ path: Array<string | number>; message: string }> } } } | undefined;
  if (zodSchema) {
    const zr = zodSchema.safeParse(obj);
    if (!zr.success) {
      return { ok: false, message: formatZodToolError(tool.name, zr.error!) };
    }
    return { ok: true, value: zr.data as Record<string, unknown> };
  }
  return { ok: true, value: obj };
}

export async function runPreToolHookChain(
  toolName: string,
  input: Record<string, unknown>,
  sessionKey: string,
): Promise<PreToolHookResult> {
  let current: Record<string, unknown> = { ...input };
  for (const hook of preToolHooks) {
    const r = await hook({ toolName, input: current, sessionKey });
    if (!r.ok) return r;
    current = { ...r.input };
  }
  return { ok: true, input: current };
}
