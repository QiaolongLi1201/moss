/**
 * Skill candidate scorer — shared confidence scoring extracted from
 * `packages/dmoss-agent/src/core/skill-learner.ts` so both the
 * distiller (#14) and evidence collector (#12) use the same signals.
 */

import type { SkillCandidateEvidence, SkillCandidateToolCall } from "./skill-candidate-store.js";

export interface SkillScoreResult {
  confidence: number;
  signals: {
    toolCallCount: number;
    distinctTools: number;
    errorRecovered: boolean;
    patternOccurrences: number;
    hasVerification: boolean;
    allSucceeded: boolean;
    /** Number of tool calls recorded as failed. */
    failedCount: number;
    /** True when some failure was never followed by a success of the same tool. */
    unrecoveredFailure: boolean;
  };
  errorRecoveryPatterns: string[];
  preconditions: string[];
}

const HIGH_CONFIDENCE_THRESHOLD = 0.7;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.5;

export function isHighConfidence(score: SkillScoreResult): boolean {
  return score.confidence >= HIGH_CONFIDENCE_THRESHOLD;
}

export function isMediumConfidence(score: SkillScoreResult): boolean {
  return score.confidence >= MEDIUM_CONFIDENCE_THRESHOLD;
}

export function scoreSkillCandidate(
  evidence: SkillCandidateEvidence,
  patternOccurrences: number = 1,
): SkillScoreResult {
  const toolCalls = evidence.toolCalls;
  const distinctTools = new Set(toolCalls.map((tc) => tc.name)).size;
  const errorRecovered = detectErrorRecovery(toolCalls);
  const hasVerification = toolCalls.some((tc) =>
    tc.name === "exec" || tc.name === "device_exec" ||
    tc.name === "read" || tc.name === "read_file" || tc.name === "device_file_read",
  );
  const allSucceeded = toolCalls.every((tc) => !tc.failed);
  const failedCount = toolCalls.filter((tc) => tc.failed).length;
  const endsWithFailure = toolCalls.length > 0 && toolCalls[toolCalls.length - 1].failed === true;
  // A failure is only "recovered" when the SAME tool succeeds later;
  // an unrelated next tool succeeding is not evidence of recovery.
  const unrecoveredFailure = toolCalls.some(
    (tc, i) =>
      tc.failed &&
      !toolCalls.slice(i + 1).some((later) => later.name === tc.name && !later.failed),
  );

  let confidence = 0.3;

  if (toolCalls.length >= 4) confidence += 0.15;
  else if (toolCalls.length >= 3) confidence += 0.1;

  if (errorRecovered) confidence += 0.2;

  if (patternOccurrences >= 3) confidence += 0.3;
  else if (patternOccurrences >= 2) confidence += 0.15;

  if (distinctTools >= 3) confidence += 0.1;

  if (allSucceeded && toolCalls.length >= 3) confidence += 0.1;

  if (hasVerification) confidence += 0.05;

  // Teaching meta quality bonus
  if (evidence.teachingMeta) {
    const hasPreAnnotations =
      evidence.teachingMeta.preAnnotations &&
      evidence.teachingMeta.preAnnotations.length > 0;
    const hasPostAnnotations =
      evidence.teachingMeta.postAnnotations &&
      evidence.teachingMeta.postAnnotations.length > 0;
    if (hasPreAnnotations && hasPostAnnotations) confidence += 0.1;
    else if (hasPreAnnotations || hasPostAnnotations) confidence += 0.05;

    // Post-annotation confidence signals
    if (hasPostAnnotations) {
      const highConfPosts = evidence.teachingMeta.postAnnotations!.filter(
        (a) => a.confidence === "high",
      ).length;
      if (highConfPosts >= 2) confidence += 0.05;
    }
  }

  // Run completeness bonus
  if (evidence.runMeta.completionKind === "complete") {
    confidence += 0.05;
  }

  // Failure gates: a run whose tool failures were never recovered, that ends
  // in a failure, or where most calls failed is not a reusable "verified
  // path" — cap it below the medium-confidence threshold regardless of other
  // bonuses. (Regression: a fully-denied run used to score 0.95 "high".)
  if (
    unrecoveredFailure ||
    endsWithFailure ||
    (toolCalls.length > 0 && failedCount / toolCalls.length > 0.5)
  ) {
    confidence = Math.min(confidence, 0.4);
  }

  confidence = Math.min(1, Math.max(0, confidence));

  return {
    confidence: Math.round(confidence * 100) / 100,
    signals: {
      toolCallCount: toolCalls.length,
      distinctTools,
      errorRecovered,
      patternOccurrences,
      hasVerification,
      allSucceeded,
      failedCount,
      unrecoveredFailure,
    },
    errorRecoveryPatterns: extractErrorRecoveryPatterns(toolCalls),
    preconditions: extractPreconditions(toolCalls),
  };
}

// Recovery means the SAME tool succeeded later. A different tool succeeding
// next proves nothing about the failure (and used to reward runs where every
// distinct tool failed once).
function detectErrorRecovery(toolCalls: SkillCandidateToolCall[]): boolean {
  return toolCalls.some(
    (tc, i) =>
      tc.failed &&
      toolCalls.slice(i + 1).some((later) => later.name === tc.name && !later.failed),
  );
}

function extractErrorRecoveryPatterns(
  toolCalls: SkillCandidateToolCall[],
): string[] {
  const patterns: string[] = [];
  for (let i = 0; i < toolCalls.length; i++) {
    if (!toolCalls[i].failed) continue;
    const j = toolCalls.findIndex((tc, k) => k > i && tc.name === toolCalls[i].name && !tc.failed);
    if (j === -1) continue;
    const via = toolCalls.slice(i + 1, j).filter((tc) => !tc.failed).map((tc) => tc.name);
    patterns.push(
      via.length
        ? `${toolCalls[i].name} failed → recovered with ${via.join(", ")} → ${toolCalls[j].name} succeeded`
        : `${toolCalls[i].name} failed → recovered with ${toolCalls[j].name}`,
    );
  }
  return patterns;
}

function extractPreconditions(toolCalls: SkillCandidateToolCall[]): string[] {
  const preconditions: string[] = [];
  const first = toolCalls[0];
  if (!first) return preconditions;

  if (first.name === "read" || first.name === "device_file_read") {
    const filePath =
      String(first.input.file_path || first.input.path || "");
    if (filePath) preconditions.push(`File exists: ${filePath}`);
  }
  if (first.name === "device_exec") {
    preconditions.push("Device SSH connected");
  }
  return preconditions;
}