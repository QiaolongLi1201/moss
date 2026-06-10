import * as crypto from "node:crypto";
import { isSyntheticUserText, type LLMMessage } from "./llm-message.js";
import { writeSkillCandidate, listCandidates } from "./skill-candidate-store.js";
import { distillCandidate, type DistillResult } from "./skill-distiller.js";
import { promoteSkillCandidate, type PromoteResult } from "./skill-promoter.js";
import { isHighConfidence } from "./skill-scorer.js";

export interface SkillPipelineConfig {
  workspaceDir: string;
  model?: string;
  autoPromoteHighConfidence?: boolean;
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

export class SkillPipeline {
  private readonly workspaceDir: string;
  private readonly model: string;
  private readonly autoPromote: boolean;

  constructor(config: SkillPipelineConfig) {
    this.workspaceDir = config.workspaceDir;
    this.model = config.model ?? "unknown";
    this.autoPromote = config.autoPromoteHighConfidence ?? false;
  }

  async processSession(
    sessionKey: string,
    messages: LLMMessage[],
  ): Promise<SkillPipelineResult | null> {
    const toolCalls = this.extractToolCalls(messages);
    if (toolCalls.length < 2) return null;

    const userMessage = this.getFirstUserMessage(messages);
    const assistantText = this.getLastAssistantText(messages);
    if (!userMessage || !assistantText) return null;

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
        completionKind: "complete",
        model: this.model,
        totalElapsedMs: 0,
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
