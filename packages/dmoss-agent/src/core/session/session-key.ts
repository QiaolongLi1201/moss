/**
 * Session Key specification.
 *
 * D-Moss sessionKey is the core routing and isolation key.
 * Structure: agent:<agentId>:<mainKey>
 *
 * Design goals:
 * 1. Unified session naming to prevent state confusion across agents
 * 2. Support both explicit sessionKey and automatic sessionId completion
 * 3. Provide the minimal session-scope shape for the mini project
 */

import { DmossError, ErrorCode } from "../../errors.js";

export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_MAIN_KEY = "main";

const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const VALID_MAIN_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

/** Maximum total length for a session key to prevent abuse. */
const MAX_SESSION_KEY_LENGTH = 512;

function normalizeToken(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

export function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_AGENT_ID;
  }
  if (VALID_ID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_CHARS_RE, "-")
      .replace(LEADING_DASH_RE, "")
      .replace(TRAILING_DASH_RE, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

export function normalizeMainKey(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return DEFAULT_MAIN_KEY;
  const lowered = trimmed.toLowerCase();
  if (VALID_MAIN_KEY_RE.test(lowered)) {
    return lowered;
  }
  // Sanitize: replace invalid chars with dash, collapse dashes
  const sanitized = lowered
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
  return sanitized || DEFAULT_MAIN_KEY;
}

export function buildAgentMainSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeMainKey(params.mainKey);
  const key = `agent:${agentId}:${mainKey}`;
  if (key.length > MAX_SESSION_KEY_LENGTH) {
    throw new DmossError({ code: ErrorCode.USER_INPUT_INVALID, message: `Session key exceeds maximum length (${MAX_SESSION_KEY_LENGTH}): got ${key.length}` });
  }
  return key;
}

export function parseAgentSessionKey(
  sessionKey: string | undefined | null,
): { agentId: string; rest: string } | null {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return null;
  }
  if (raw.length > MAX_SESSION_KEY_LENGTH) return null;
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0].toLowerCase() !== "agent") {
    return null;
  }
  const agentId = normalizeAgentId(parts[1]);
  const rest = parts.slice(2).join(":").trim();
  if (!rest) {
    return null;
  }
  return { agentId, rest };
}

export function isSubagentSessionKey(sessionKey: string | undefined | null): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return false;
  }
  return parsed.rest.trim().toLowerCase().startsWith("subagent:");
}

export function resolveAgentIdFromSessionKey(sessionKey: string | undefined | null): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeAgentId(parsed?.agentId ?? DEFAULT_AGENT_ID);
}

export function toAgentStoreSessionKey(params: {
  agentId: string;
  requestKey: string | undefined | null;
  mainKey?: string | undefined;
}): string {
  const raw = (params.requestKey ?? "").trim();
  if (!raw || normalizeToken(raw) === DEFAULT_MAIN_KEY) {
    return buildAgentMainSessionKey({ agentId: params.agentId, mainKey: params.mainKey });
  }
  const lowered = raw.toLowerCase();
  if (lowered.startsWith("agent:")) {
    return lowered;
  }
  return `agent:${normalizeAgentId(params.agentId)}:${lowered}`;
}

/** Unified entry point: normalize sessionId / sessionKey into a canonical sessionKey. */
export function resolveSessionKey(params: {
  agentId?: string | undefined;
  sessionId?: string | undefined;
  sessionKey?: string | undefined;
}): string {
  const agentId = normalizeAgentId(params.agentId ?? DEFAULT_AGENT_ID);
  const explicit = params.sessionKey?.trim();
  if (explicit) {
    return toAgentStoreSessionKey({ agentId, requestKey: explicit });
  }
  const sessionId = params.sessionId?.trim();
  if (sessionId) {
    return toAgentStoreSessionKey({ agentId, requestKey: sessionId });
  }
  return buildAgentMainSessionKey({ agentId, mainKey: DEFAULT_MAIN_KEY });
}

/**
 * Validate that a full session key contains only filesystem-safe characters
 * and does not attempt path traversal.
 */
export function validateSessionKeyChars(key: string): { valid: boolean; reason?: string } {
  if (key.length > MAX_SESSION_KEY_LENGTH) {
    return { valid: false, reason: `exceeds max length ${MAX_SESSION_KEY_LENGTH}` };
  }
  // Session key format: agent:<agentId>:<mainKey>
  // All parts should be safe filesystem characters
  if (/[/\\]/.test(key)) {
    return { valid: false, reason: 'contains path separator' };
  }
  if (key.includes('..')) {
    return { valid: false, reason: 'contains path traversal' };
  }
  return { valid: true };
}
