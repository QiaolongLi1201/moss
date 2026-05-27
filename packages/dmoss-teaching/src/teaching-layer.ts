/**
 * Teach-while-solve: RDK Studio SSE teaching meta + hook glue (task 2026-05-01-moss-teach-while-solve).
 * Correlates pre-teach patches with tool_start via stable argsDigest (onBeforeToolExec has no toolCallId).
 */

import * as crypto from "node:crypto";
import type { LLMProvider, LLMResponse, ToolApprovalRequest, ToolApprovalDecision } from "@dmoss/agent/core";
import type { ToolCall, ToolResult } from "@dmoss/agent/core";
import { sanitizeSecrets } from "@dmoss/agent/safety";
import { digestStudioToolCall } from "./teaching-tool-digest.js";

export type TeachingDepth = "off" | "concise" | "detailed";

const DEFAULT_LLM_MS = Number(process.env.DMOSS_TEACH_LLM_TIMEOUT_MS || 350) || 350;
const CACHE_TTL_MS = (Number(process.env.DMOSS_TEACH_CACHE_TTL_SEC || 60) || 60) * 1000;

export interface TeachDryRunSummary {
  device: string;
  scope: string;
  rollback: string;
  duration: string;
  risk: string;
}

export type StudioTeachingMetaV1 = {
  v: 1;
  toolCallId?: string;
  argsDigest?: string;
  phase: "pre" | "post" | "dry_run_summary";
  patch?: Record<string, unknown>;
  streamDone?: boolean;
  confirmToken?: string;
  awaitingConfirm?: boolean;
};

export function normalizeTeachingDepth(raw: unknown): TeachingDepth {
  if (raw === "off" || raw === "concise" || raw === "detailed") return raw;
  return "off";
}

function firstAssistantText(resp: LLMResponse): string {
  for (const b of resp.content) {
    if (b.type === "text") {
      const t = typeof (b as { text?: unknown }).text === "string"
        ? String((b as { text: string }).text).trim()
        : "";
      if (t) return t;
    }
  }
  return "";
}

function parseJsonLoose(raw: string): Record<string, unknown> | null {
  const trimmed = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const i = trimmed.indexOf("{");
    const j = trimmed.lastIndexOf("}");
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(trimmed.slice(i, j + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function llmJsonObject(params: {
  llmProvider: LLMProvider;
  modelId: string;
  temperature?: number;
  timeoutMs: number;
  system: string;
  user: string;
}): Promise<Record<string, unknown> | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), Math.max(80, params.timeoutMs));
  try {
    const resp = await params.llmProvider.complete({
      model: params.modelId,
      systemPrompt: params.system,
      messages: [{ role: "user", content: params.user }],
      maxTokens: 512,
      temperature: params.temperature ?? 0.2,
      reasoning: null,
      abortSignal: ac.signal,
    });
    const text = sanitizeSecrets(firstAssistantText(resp));
    return parseJsonLoose(text || "{}");
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function clampLines(s: string, maxLines: number, maxChars: number): string {
  const lines = sanitizeSecrets(String(s || "")).split("\n").map((x) => x.trim()).filter(Boolean);
  const cut = lines.slice(0, maxLines).join("\n");
  return cut.length > maxChars ? `${cut.slice(0, maxChars)}…` : cut;
}

function postProcessConfidence(
  row: Record<string, unknown>,
  isMutation: boolean,
  toolError: boolean,
): Record<string, unknown> {
  let conf = String(row.confidence || "medium").toLowerCase();
  if (conf !== "high" && conf !== "medium" && conf !== "low") conf = "medium";
  if (toolError || conf === "high" && isMutation) {
    row.confidence = toolError ? "low" : "medium";
    if (!row.confidenceReason) {
      row.confidenceReason = toolError ? "tool returned error output" : "mutation steps are capped at medium";
    }
  }
  if (row.confidence === "high" && isMutation) {
    row.confidence = "medium";
    row.confidenceReason = row.confidenceReason || "mutation tools cannot be high-confidence";
  }
  return row;
}

export interface StudioTeachingLayerParams {
  depth: TeachingDepth;
  /** User checkbox in RDK Studio — may still be non-interactive on IM channels. */
  teachingConfirmRequested: boolean;
  /** False on weixin/feishu — auto-approve (no SSE meta user actions). */
  teachingConfirmInteractive: boolean;
  llmProvider: LLMProvider;
  modelId: string;
  temperature?: number;
  /** meta push (caller filters IM / suppress) */
  emitTeachingMeta: (st: StudioTeachingMetaV1) => void;
  runId: string;
  sessionKey: string;
  deviceLabel: string;
  familyIsRdk: boolean;
  waitTeachingConfirm: (token: string) => Promise<boolean>;
  /** Host-injected: classify whether a tool is a plan-mode mutation (avoids coupling to plan-mode-policy/tool-capability chain). */
  classifyPlanMutation: (toolName: string) => boolean;
  abortSignal?: AbortSignal;
}

export function createStudioTeachingHooks(p: StudioTeachingLayerParams): {
  onBeforeToolExec: (req: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
  onToolResult: (call: ToolCall, result: ToolResult) => void;
} {
  if (p.depth === "off" && !p.teachingConfirmRequested) {
    return {
      onBeforeToolExec: async () => ({ approved: true }),
      onToolResult: () => {},
    };
  }

  const cache = new Map<string, { exp: number; json: Record<string, unknown> }>();
  let dryRunEmitted = false;

  const shouldAnnotate = (_toolName: string, mutation: boolean): boolean => {
    if (p.depth === "off") return false;
    if (p.depth === "detailed") return true;
    return mutation;
  };

  const getCacheJson = (key: string): Record<string, unknown> | null => {
    const hit = cache.get(key);
    if (!hit || hit.exp < Date.now()) return null;
    return hit.json;
  };

  const setCacheJson = (key: string, json: Record<string, unknown>) => {
    cache.set(key, { exp: Date.now() + CACHE_TTL_MS, json });
  };

  const buildHeuristicDryRun = (
    toolName: string,
    input: Record<string, unknown>,
  ): TeachDryRunSummary => ({
    device: p.deviceLabel || "(not bound)",
    scope: `${toolName} · ${sanitizeSecrets(JSON.stringify(Object.keys(input || {}).slice(0, 12)))}`,
    rollback: p.classifyPlanMutation(toolName)
      ? "Depends on command — review stderr and stop if destructive."
      : "N/A (read-only)",
    duration: "seconds to minutes",
    risk: p.classifyPlanMutation(toolName)
      ? "May change board or workspace files; SSH/output may contain sensitive paths."
      : "Low visibility risk",
  });

  async function emitDryRunAndMaybeAwait(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ToolApprovalDecision> {
    dryRunEmitted = true;
    const heuristic = buildHeuristicDryRun(toolName, input);
    let summary: TeachDryRunSummary = heuristic;
    if (
      (p.teachingConfirmRequested && p.teachingConfirmInteractive) || p.depth === "detailed"
    ) {
      const row = await llmJsonObject({
        llmProvider: p.llmProvider,
        modelId: p.modelId,
        temperature: p.temperature,
        timeoutMs:
          p.teachingConfirmRequested && p.teachingConfirmInteractive ? 2_500 : DEFAULT_LLM_MS,
        system:
          `You summarize an upcoming DEVICE/SHELL mutation for the developer. Reply ONLY compact JSON keys: `
          + `{ "device","scope","rollback","duration","risk" } each 1–2 short sentences max, zh-CN acceptable. `,
        user: sanitizeSecrets(
          `tool=${toolName}\ninputKeys=${JSON.stringify(Object.keys(input || {})).slice(0, 600)}\n`
            + `device=${p.deviceLabel}\nfamilyRdk=${p.familyIsRdk ? "yes" : "no"}`,
        ).slice(0, 6000),
      });
      if (row) {
        summary = {
          device: String(row.device || heuristic.device).slice(0, 280),
          scope: String(row.scope || heuristic.scope).slice(0, 420),
          rollback: String(row.rollback || heuristic.rollback).slice(0, 320),
          duration: String(row.duration || heuristic.duration).slice(0, 120),
          risk: String(row.risk || heuristic.risk).slice(0, 320),
        };
      }
    }

    const token = crypto.randomUUID();
    const blockingConfirm = Boolean(p.teachingConfirmRequested && p.teachingConfirmInteractive);
    const meta: StudioTeachingMetaV1 = {
      v: 1,
      phase: "dry_run_summary",
      // Type bridge: summary is a structured object compatible with Record<string, unknown> at runtime
      patch: summary as unknown as Record<string, unknown>,
      confirmToken: blockingConfirm ? token : undefined,
      awaitingConfirm: blockingConfirm,
      streamDone: true,
    };
    p.emitTeachingMeta(meta);

    if (!blockingConfirm) return { approved: true };

    const proceed = await p.waitTeachingConfirm(token);
    if (!proceed) return { approved: false, reason: "User stopped risky step (teaching confirm)" };
    return { approved: true };
  }

  const onBeforeToolExec = async (
    req: ToolApprovalRequest,
  ): Promise<ToolApprovalDecision> => {
    if (p.abortSignal?.aborted) return { approved: true };

    const toolName = req.tool.name;
    const input = req.input || {};
    const mutation = p.classifyPlanMutation(toolName);

    if (
      mutation &&
      !dryRunEmitted &&
      (p.depth !== "off" || p.teachingConfirmRequested)
    ) {
      const d = await emitDryRunAndMaybeAwait(toolName, input as Record<string, unknown>);
      if (!d.approved) return d;
    }

    if (!shouldAnnotate(toolName, mutation)) return { approved: true };

    const digest = digestStudioToolCall(toolName, input as Record<string, unknown>);
    const cacheKey = `${p.sessionKey}:${digest}:pre`;

    void (async () => {
      const cached = getCacheJson(cacheKey);
      if (cached) {
        p.emitTeachingMeta({
          v: 1,
          argsDigest: digest,
          phase: "pre",
          patch: cached,
          streamDone: true,
        });
        return;
      }

      const rdkHint = p.familyIsRdk
        ? "Hardware notes: Prefer MJPEG for UVC stability; verify v4l2 formats before blaming model paths."
        : "";

      const row = await llmJsonObject({
        llmProvider: p.llmProvider,
        modelId: p.modelId,
        temperature: p.temperature,
        timeoutMs: DEFAULT_LLM_MS,
        system:
          `You write microscopic teaching captions for ONE tool invocation. Reply JSON ONLY:\n`
          + `{ "why": string (<=1 sentence), "concept": string (<=1 sentence), "pitfalls": string[] (0-3, each <=1 sentence), "skip": optional boolean }\n`
          + `Do NOT paste secrets, passwords, URLs with tokens, or full args. Explain intent only.${rdkHint ? ` ${rdkHint}` : ""}`,
        user: sanitizeSecrets(`tool=${toolName}\ndevice=${p.deviceLabel}\nmutation=${mutation ? "yes" : "no"}`).slice(
          0,
          4000,
        ),
      });

      const json = row ?? { skip: true };
      const skip = Boolean(json.skip === true || json.skip === "true");
      if (skip) {
        p.emitTeachingMeta({ v: 1, argsDigest: digest, phase: "pre", patch: { skip: true }, streamDone: true });
        return;
      }

      const why = clampLines(String(json.why || ""), mutation ? 2 : 1, mutation ? 360 : 200);
      const concept = clampLines(String(json.concept || ""), mutation ? 2 : 1, mutation ? 360 : 200);
      const pitfallsRaw = Array.isArray(json.pitfalls) ? json.pitfalls : [];
      const pitfalls = pitfallsRaw
        .map((x) => clampLines(String(x), 1, 160))
        .filter(Boolean)
        .slice(0, p.depth === "detailed" ? 3 : (mutation ? 2 : 0));

      const pre = { why, concept, ...(pitfalls.length ? { pitfalls } : {}) };
      setCacheJson(cacheKey, pre);
      p.emitTeachingMeta({ v: 1, argsDigest: digest, phase: "pre", patch: pre, streamDone: true });
    })().catch(() => {});

    return { approved: true };
  };

  const onToolResult = (call: ToolCall, result: ToolResult): void => {
    if (p.depth === "off" || p.abortSignal?.aborted) return;
    const toolName = call.name;
    const mutation = p.classifyPlanMutation(toolName);
    if (!shouldAnnotate(toolName, mutation)) return;

    void (async () => {
      const postCacheKey = `${p.sessionKey}:${call.id}:post`;
      const cached = getCacheJson(postCacheKey);
      if (cached) {
        p.emitTeachingMeta({
          v: 1,
          toolCallId: call.id,
          phase: "post",
          patch: cached,
          streamDone: true,
        });
        return;
      }

      const toolErr = Boolean(result.isError);
      const errHint = typeof result.content === "string"
        ? sanitizeSecrets(result.content).slice(0, 900)
        : "";

      const row = await llmJsonObject({
        llmProvider: p.llmProvider,
        modelId: p.modelId,
        temperature: p.temperature,
        timeoutMs: DEFAULT_LLM_MS,
        system:
          `Reply JSON ONLY for AFTER tool reflection:\n`
          + `{ "verifyHint": string<=1sentence, "confidence":"high"|"medium"|"low", "confidenceReason"?: string, `
          + `"nextStepIfFails": string<=1sentence, "rollbackSupported": boolean, "rollbackHint"?: string, `
          + `"failureCard"?: {"cause","actions"[1-3],"stopWhen","rollbackAvailable"} }\n`
          + `mutation tools must declare rollback honestly. Never claim high confidence if stderr suggests failure.`,
        user: sanitizeSecrets(
          `tool=${toolName}\nmutation=${mutation ? "yes" : "no"}\nisError=${toolErr ? "yes" : "no"}\nstderrSample=${errHint}`,
        ).slice(0, 5200),
      });

      let patch: Record<string, unknown>;
      if (!row || toolErr) {
        patch = postProcessConfidence(
          {
            verifyHint: toolErr ? "Inspect tool output tail for root cause codes." : "Scan logs for regressions.",
            confidence: toolErr ? "low" : "medium",
            confidenceReason: toolErr ? "tool error flag set" : undefined,
            nextStepIfFails: p.familyIsRdk
              ? "Check UVC MJPEG negotiation, ros2 topics, then .hbm path per board docs."
              : "Isolate whether host, SSH, or app layer failed.",
            rollbackSupported: false,
            ...(toolErr && !row
              ? {
                  failureCard: {
                    cause: clampLines(errHint, 2, 400),
                    actions: ["Re-run with narrower command", "Check device SSH reachability"],
                    stopWhen: "Repeated identical failure",
                    rollbackAvailable: false,
                  },
                }
              : {}),
          },
          mutation,
          toolErr,
        );
      } else {
        patch = postProcessConfidence(row, mutation, toolErr);
        patch.verifyHint = clampLines(String(patch.verifyHint ?? ""), 1, 220);
        patch.nextStepIfFails = clampLines(String(patch.nextStepIfFails ?? ""), 1, 220);
      }

      setCacheJson(postCacheKey, patch);
      p.emitTeachingMeta({ v: 1, toolCallId: call.id, phase: "post", patch, streamDone: true });
    })().catch(() => {});
  };

  return { onBeforeToolExec, onToolResult };
}
