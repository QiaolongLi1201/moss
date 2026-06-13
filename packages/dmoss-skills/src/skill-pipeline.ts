import * as crypto from "node:crypto";
import { isSyntheticUserText, type LLMMessage } from "./llm-message.js";
import { writeSkillCandidate, listCandidates } from "./skill-candidate-store.js";
import { distillCandidate, type DistillResult } from "./skill-distiller.js";
import { promoteSkillCandidate, type PromoteResult } from "./skill-promoter.js";
import { isHighConfidence } from "./skill-scorer.js";

/**
 * Read-only / info-gathering tool names used by the low-value run gate.
 * A run whose every distinct tool is in this set did no mutating or
 * meaningful work and is not worth persisting as a skill candidate. Hosts
 * that know each tool's authoritative `sideEffectClass` can override this via
 * {@link SkillPipelineConfig.readonlyToolNames}; the defaults cover the
 * well-known vendor-neutral read-only built-ins. Mutating/verifying tools
 * (`exec`, `device_exec`, writes) are deliberately absent.
 * @public
 */
export const DEFAULT_READONLY_TOOL_NAMES: readonly string[] = [
  "read",
  "read_file",
  "device_file_read",
  "list_directory",
  "search_files",
  "search_code",
  "glob",
  "grep",
  "memory_read",
  "web_fetch",
  "web_search",
];

export interface SkillPipelineConfig {
  workspaceDir: string;
  model?: string;
  autoPromoteHighConfidence?: boolean;
  /**
   * Tool names treated as read-only info-gathering by the low-value run gate.
   * Defaults to {@link DEFAULT_READONLY_TOOL_NAMES}. Pass the host's set of
   * `sideEffectClass: 'readonly'` tool names to keep the gate authoritative
   * without hard-coding a vendor workflow into core.
   */
  readonlyToolNames?: readonly string[];
}

export interface SkillPipelineResult {
  candidateId: string;
  candidatePath: string;
  distill: DistillResult | null;
  promoted: PromoteResult | null;
}

interface ExtractedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  failed: boolean;
}

/**
 * True when the assistant's final text reads as a clarifying question rather
 * than a completed result. Conservative and language-neutral: the trimmed
 * text ends with a question mark (ASCII `?` or fullwidth `？`). Declarative
 * results ("Done. …") are never matched.
 */
function isClarifyingQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const last = trimmed[trimmed.length - 1];
  return last === "?" || last === "？";
}

export class SkillPipeline {
  private readonly workspaceDir: string;
  private readonly model: string;
  private readonly autoPromote: boolean;
  private readonly readonlyToolNames: ReadonlySet<string>;

  constructor(config: SkillPipelineConfig) {
    this.workspaceDir = config.workspaceDir;
    this.model = config.model ?? "unknown";
    this.autoPromote = config.autoPromoteHighConfidence ?? false;
    this.readonlyToolNames = new Set(
      (config.readonlyToolNames ?? DEFAULT_READONLY_TOOL_NAMES).map((n) => n.trim()),
    );
  }

  /**
   * Process a finished session into a skill candidate (+ optional auto-promote).
   *
   * Contract: callers must only invoke this AFTER verifying the task actually
   * completed — the dmoss-agent host gates on `taskFrame.status === 'completed'`.
   * Pass `runMeta` to record the real outcome; the defaults assert completion
   * on the caller's behalf and feed the scorer's completeness bonus.
   */
  async processSession(
    sessionKey: string,
    messages: LLMMessage[],
    runMeta?: {
      completionKind?: "complete" | "partial" | "cancelled" | "failed";
      totalElapsedMs?: number;
      stopReason?: string;
    },
  ): Promise<SkillPipelineResult | null> {
    const toolCalls = this.extractToolCalls(messages);
    if (toolCalls.length < 2) return null;

    const userMessage = this.getFirstUserMessage(messages);
    const assistantText = this.getLastAssistantText(messages);
    if (!userMessage || !assistantText) return null;

    // Quality gate (host-neutral): skip persistence for low-value runs so the
    // candidate store is not polluted by trivial info-gathering or
    // clarification turns. Two signals, both derivable from evidence we have:
    //  (a) the assistant's final turn is a clarifying question — the task was
    //      not completed, it asked the user for more input; and
    //  (b) every distinct tool used is read-only info-gathering — no mutating
    //      or meaningful work happened.
    if (this.isLowValueRun(toolCalls, assistantText)) return null;

    const currentToolNames = [...new Set(toolCalls.map((tc) => tc.name))];
    const sortedToolNamesKey = [...currentToolNames].sort().join("|");

    const existingCandidates = await listCandidates(this.workspaceDir);
    const patternOccurrences = existingCandidates.filter((c) => {
      const names = [...c.toolNames].sort().join("|");
      return names === sortedToolNamesKey;
    }).length + 1;

    const candidateResult = await writeSkillCandidate({
      workspaceDir: this.workspaceDir,
      sessionKey,
      turnHash: this.buildTurnHash(sessionKey, currentToolNames),
      gate: "strict",
      toolCalls: toolCalls.map((tc) => ({
        name: tc.name,
        input: tc.input,
        failed: tc.failed,
      })),
      userMessage,
      assistantText,
      runMeta: {
        completionKind: runMeta?.completionKind ?? "complete",
        model: this.model,
        totalElapsedMs: runMeta?.totalElapsedMs ?? 0,
        ...(runMeta?.stopReason ? { stopReason: runMeta.stopReason } : {}),
      },
    });

    if (!candidateResult) return null;

    const distill = await distillCandidate(
      this.workspaceDir,
      candidateResult.candidateId,
      { patternOccurrences },
    );

    let promoted: PromoteResult | null = null;
    if (
      this.autoPromote &&
      distill &&
      isHighConfidence(distill.score) &&
      patternOccurrences >= 2
    ) {
      promoted = await promoteSkillCandidate({
        workspaceDir: this.workspaceDir,
        candidateId: candidateResult.candidateId,
        confidence: distill.score.confidence,
      });
    }

    return {
      candidateId: candidateResult.candidateId,
      candidatePath: candidateResult.path,
      distill,
      promoted,
    };
  }

  /**
   * True when a finished run is not worth persisting as a skill candidate:
   * the assistant ended by asking a clarifying question, or every distinct
   * tool used was read-only info-gathering with no mutating/meaningful work.
   */
  private isLowValueRun(
    toolCalls: ExtractedToolCall[],
    assistantText: string,
  ): boolean {
    if (isClarifyingQuestion(assistantText)) return true;
    const distinct = new Set(toolCalls.map((tc) => tc.name).filter(Boolean));
    if (distinct.size === 0) return true;
    for (const name of distinct) {
      if (!this.readonlyToolNames.has(name)) return false;
    }
    return true;
  }

  private extractToolCalls(messages: LLMMessage[]): ExtractedToolCall[] {
    const calls: ExtractedToolCall[] = [];
    const byId = new Map<string, ExtractedToolCall>();

    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (typeof block !== "object" || block === null) continue;
        const rec = block as Record<string, unknown>;

        if (rec.type === "tool_use") {
          const id = String(rec.id || `call_${calls.length}`);
          const call: ExtractedToolCall = {
            id,
            name: String(rec.name || "").trim(),
            input:
              rec.input && typeof rec.input === "object" && !Array.isArray(rec.input)
                ? (rec.input as Record<string, unknown>)
                : {},
            failed: false,
          };
          if (!call.name) continue;
          calls.push(call);
          byId.set(id, call);
        } else if (rec.type === "tool_result" && rec.is_error) {
          const id = String(rec.tool_use_id || "");
          const call = id ? byId.get(id) : calls[calls.length - 1];
          if (call) call.failed = true;
        }
      }
    }

    return calls;
  }

  private getFirstUserMessage(messages: LLMMessage[]): string {
    for (const msg of messages) {
      if (msg.role !== "user") continue;
      if (typeof msg.content === "string" && msg.content.trim()) {
        // Skip runtime-synthesized user messages (compaction summaries,
        // [Steering]/[System] injections) — using them produced garbage
        // skill names like "the-conversation-history-before-…".
        if (isSyntheticUserText(msg.content)) continue;
        return msg.content.trim().slice(0, 600);
      }
      if (Array.isArray(msg.content)) {
        const hasToolResultOnly = msg.content.every(
          (b) =>
            typeof b === "object" &&
            b !== null &&
            (b as Record<string, unknown>).type === "tool_result",
        );
        if (hasToolResultOnly) continue;
        const text = msg.content
          .filter(
            (b): b is { type: "text"; text: string } =>
              typeof b === "object" &&
              b !== null &&
              (b as Record<string, unknown>).type === "text",
          )
          .map((b) => b.text)
          .join(" ")
          .trim();
        if (text && isSyntheticUserText(text)) continue;
        if (text) return text.slice(0, 600);
      }
    }
    return "";
  }

  private getLastAssistantText(messages: LLMMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role !== "assistant") continue;
      if (typeof msg.content === "string") return msg.content.trim().slice(0, 700);
      if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter(
            (b): b is { type: "text"; text: string } =>
              typeof b === "object" &&
              b !== null &&
              (b as Record<string, unknown>).type === "text",
          )
          .map((b) => b.text)
          .join(" ")
          .trim();
        if (text) return text.slice(0, 700);
      }
    }
    return "";
  }

  private buildTurnHash(sessionKey: string, toolNames: string[]): string {
    return crypto
      .createHash("sha1")
      .update(`${sessionKey}:${[...toolNames].sort().join(",")}`)
      .digest("hex")
      .slice(0, 16);
  }
}
