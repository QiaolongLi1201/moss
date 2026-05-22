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
    tc.name === "exec" || tc.name === "device_exec" || tc.name === "read",
  );
  const allSucceeded = toolCalls.every((tc) => !tc.failed);

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
    },
    errorRecoveryPatterns: extractErrorRecoveryPatterns(toolCalls),
    preconditions: extractPreconditions(toolCalls),
  };
}

function detectErrorRecovery(toolCalls: SkillCandidateToolCall[]): boolean {
  for (let i = 0; i < toolCalls.length - 1; i++) {
    if (toolCalls[i].failed && !toolCalls[toolCalls.length - 1].failed) {
      return true;
    }
  }
  return false;
}

function extractErrorRecoveryPatterns(
  toolCalls: SkillCandidateToolCall[],
): string[] {
  const patterns: string[] = [];
  for (let i = 0; i < toolCalls.length - 1; i++) {
    if (toolCalls[i].failed && !toolCalls[i + 1].failed) {
      patterns.push(
        `${toolCalls[i].name} failed → recovered with ${toolCalls[i + 1].name}`,
      );
    }
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