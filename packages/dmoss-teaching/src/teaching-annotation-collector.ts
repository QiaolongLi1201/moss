/**
 * P0a evidence collector: captures teaching annotations emitted during a run
 * and assembles them into SkillCandidateTeachingMeta for the candidate store.
 * No SSE contract changes — taps into the existing emitTeachingMeta callback.
 */

import type { StudioTeachingMetaV1 } from "./teaching-layer.js";
import type { SkillCandidateTeachingMeta } from "@rdk-moss/skills";
import { digestStudioToolCall } from "./teaching-tool-digest.js";

interface CollectedAnnotation {
  argsDigest?: string;
  toolCallId?: string;
  phase: "pre" | "post" | "dry_run_summary";
  patch: Record<string, unknown>;
}

export class TeachingAnnotationCollector {
  private annotations: CollectedAnnotation[] = [];
  private eligibleToolNames: Set<string> = new Set();
  private teachingDepth: "off" | "concise" | "detailed";
  /** argsDigest → toolName — populated from onBeforeToolExec requests */
  private digestToolNameMap: Map<string, string> = new Map();
  /** toolCallId → toolName — populated from onToolResult calls */
  private callIdToolNameMap: Map<string, string> = new Map();

  constructor(teachingDepth: "off" | "concise" | "detailed") {
    this.teachingDepth = teachingDepth;
  }

  /** Record that a tool execution is about to start — maps argsDigest → toolName */
  recordToolStart(toolName: string, input: Record<string, unknown>): void {
    const digest = digestStudioToolCall(toolName, input);
    this.digestToolNameMap.set(digest, toolName);
  }

  /** Record that a tool execution finished — maps toolCallId → toolName */
  recordToolResult(callId: string, toolName: string): void {
    this.callIdToolNameMap.set(callId, toolName);
  }

  /** Mark a tool as eligible for teaching annotation (based on depth + mutation) */
  markEligible(toolName: string, isMutation: boolean): void {
    if (this.teachingDepth === "detailed") {
      this.eligibleToolNames.add(toolName);
    } else if (this.teachingDepth === "concise" && isMutation) {
      this.eligibleToolNames.add(toolName);
    }
  }

  /** Observe a teaching annotation — called from emitTeachingMeta callback */
  observe(meta: StudioTeachingMetaV1): void {
    if (meta.phase === "dry_run_summary") return;
    if (!meta.patch || meta.patch.skip === true) return;
    this.annotations.push({
      argsDigest: meta.argsDigest,
      toolCallId: meta.toolCallId,
      phase: meta.phase,
      patch: meta.patch,
    });
  }

  /** Assemble all collected annotations into SkillCandidateTeachingMeta */
  assembleTeachingMeta(): SkillCandidateTeachingMeta | undefined {
    if (this.annotations.length === 0 && this.digestToolNameMap.size === 0) return undefined;

    const preAnnotations: SkillCandidateTeachingMeta["preAnnotations"] = [];
    const postAnnotations: SkillCandidateTeachingMeta["postAnnotations"] = [];
    const annotatedToolNames = new Set<string>();

    for (const ann of this.annotations) {
      const toolName = ann.phase === "pre"
        ? this.digestToolNameMap.get(ann.argsDigest ?? "")
        : this.callIdToolNameMap.get(ann.toolCallId ?? "");

      if (ann.phase === "pre") {
        const patch = ann.patch;
        preAnnotations.push({
          argsDigest: ann.argsDigest,
          toolName,
          why: typeof patch.why === "string" ? patch.why : undefined,
          concept: typeof patch.concept === "string" ? patch.concept : undefined,
          pitfalls: Array.isArray(patch.pitfalls)
            ? patch.pitfalls.filter((x): x is string => typeof x === "string")
            : undefined,
        });
        if (toolName) annotatedToolNames.add(toolName);
      } else if (ann.phase === "post") {
        const patch = ann.patch;
        const rawCard = patch.failureCard;
        postAnnotations.push({
          toolCallId: ann.toolCallId,
          toolName,
          verifyHint: typeof patch.verifyHint === "string" ? patch.verifyHint : undefined,
          confidence: typeof patch.confidence === "string" ? patch.confidence : undefined,
          confidenceReason: typeof patch.confidenceReason === "string" ? patch.confidenceReason : undefined,
          nextStepIfFails: typeof patch.nextStepIfFails === "string" ? patch.nextStepIfFails : undefined,
          rollbackSupported: typeof patch.rollbackSupported === "boolean" ? patch.rollbackSupported : undefined,
          rollbackHint: typeof patch.rollbackHint === "string" ? patch.rollbackHint : undefined,
          failureCard: rawCard && typeof rawCard === "object" ? {
            cause: typeof (rawCard as Record<string, unknown>).cause === "string" ? (rawCard as Record<string, unknown>).cause as string : undefined,
            actions: Array.isArray((rawCard as Record<string, unknown>).actions) ? (rawCard as Record<string, unknown>).actions as string[] : undefined,
            stopWhen: typeof (rawCard as Record<string, unknown>).stopWhen === "string" ? (rawCard as Record<string, unknown>).stopWhen as string : undefined,
            rollbackAvailable: typeof (rawCard as Record<string, unknown>).rollbackAvailable === "boolean" ? (rawCard as Record<string, unknown>).rollbackAvailable as boolean : undefined,
          } : undefined,
        });
        if (toolName) annotatedToolNames.add(toolName);
      }
    }

    if (preAnnotations.length === 0 && postAnnotations.length === 0) return undefined;

    const eligible = [...this.eligibleToolNames];
    const annotated = [...annotatedToolNames];
    const annotationCoverage = eligible.length > 0
      ? annotated.filter((n) => eligible.includes(n)).length / eligible.length
      : annotated.length > 0 ? 1 : 0;

    return {
      preAnnotations,
      postAnnotations,
      annotatedToolNames: annotated,
      eligibleToolNames: eligible,
      annotationCoverage,
    };
  }
}