/**
 * Skill Learner — continuous self-improvement loop (enhanced).
 *
 * After each agent turn, extract reusable patterns (command sequences, error
 * recovery paths, successful tool chains) and persist them so future sessions
 * can match them before spending tokens on re-derivation.
 *
 * Enhanced capabilities (aligned with Codex auto-skill vision):
 * 1. Pattern detection: identifies repeated tool sequences across sessions
 * 2. Error recovery extraction: captures successful error→fix patterns
 * 3. Confidence scoring: only persists skills above confidence threshold
 * 4. Deduplication: checks existing skills before creating new ones
 * 5. Skill quality signals: tracks usage count and success rate
 *
 * Storage: `<workspace>/skills/learned/<slug>.md`
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LLMMessage } from './llm-message.js';

export interface LearnedSkill {
  name: string;
  description: string;
  steps: string[];
  tools: string[];
  /** Error patterns that this skill knows how to recover from */
  errorRecoveryPatterns: string[];
  /** Preconditions that should be checked before running */
  preconditions: string[];
  createdAt: number;
  sourceSessionKey: string;
  /** How confident we are this is a reusable skill (0-1) */
  confidence: number;
  /** How many times this pattern was seen */
  occurrenceCount: number;
}

export interface SkillLearnerConfig {
  skillsDir: string;
  minToolCalls?: number;
  /** Minimum confidence to persist a skill (default 0.6) */
  minConfidence?: number;
}

/** Extracted tool chain pattern for dedup and frequency tracking */
interface ToolChainPattern {
  toolSequence: string[];
  inputSignature: string;
  succeeded: boolean;
  errorRecovered: boolean;
}

const DEFAULT_MIN_TOOL_CALLS = 2;
const DEFAULT_MIN_CONFIDENCE = 0.6;

export class SkillLearner {
  private readonly skillsDir: string;
  private readonly minToolCalls: number;
  private readonly minConfidence: number;
  /** In-memory pattern frequency tracker (session-scoped) */
  private patternCounts = new Map<string, number>();

  constructor(config: SkillLearnerConfig) {
    this.skillsDir = path.join(config.skillsDir, 'learned');
    this.minToolCalls = config.minToolCalls ?? DEFAULT_MIN_TOOL_CALLS;
    this.minConfidence = config.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  }

  /**
   * Analyze a completed conversation and extract a skill if the task was
   * multi-step and completed successfully.
   *
   * Enhanced: considers error recovery patterns, deduplicates against existing
   * skills, and scores confidence based on multiple signals.
   */
  async maybeLearnFromSession(
    sessionKey: string,
    messages: LLMMessage[],
    summarize?: (prompt: string) => Promise<string>,
  ): Promise<string | null> {
    const toolCalls = this.extractToolCalls(messages);
    if (toolCalls.length < this.minToolCalls) return null;

    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant) return null;

    const lastText = this.extractText(lastAssistant);
    const finalFailed = toolCalls.length > 0 && toolCalls[toolCalls.length - 1].failed;
    const successKeyword =
      /done|success|完成|成功|已完成|已修复|已定位|已部署|finished|fixed|resolved|ready/i.test(lastText);
    const looksSuccessful = successKeyword || !finalFailed;
    if (!looksSuccessful) return null;

    const userMessages = messages.filter(m => m.role === 'user');
    const firstUserMsg = userMessages[0] ? this.extractText(userMessages[0]) : '';
    if (!firstUserMsg) return null;

    const pattern = this.extractToolChainPattern(toolCalls);
    const patternKey = pattern.toolSequence.join('→');
    this.patternCounts.set(patternKey, (this.patternCounts.get(patternKey) ?? 0) + 1);

    const confidence = this.scoreConfidence(toolCalls, pattern, messages);
    if (confidence < this.minConfidence) return null;

    const existingSkills = await this.listLearnedSkills();
    if (await this.isDuplicate(pattern, existingSkills)) return null;

    const toolNames = [...new Set(toolCalls.map(tc => tc.name))];
    const steps = this.extractMeaningfulSteps(toolCalls);
    const errorRecoveryPatterns = this.extractErrorRecoveryPatterns(toolCalls);
    const preconditions = this.extractPreconditions(toolCalls, messages);

    let name = this.slugify(firstUserMsg.slice(0, 60));
    let description = firstUserMsg;

    if (summarize) {
      try {
        const summary = await summarize(
          `Summarize this task in one sentence (Chinese preferred, max 15 words): "${firstUserMsg}"\nTools used: ${toolNames.join(', ')}`
        );
        if (summary.trim()) {
          description = summary.trim();
          name = this.slugify(description.slice(0, 60));
        }
      } catch { /* use original */ }
    }

    const skill: LearnedSkill = {
      name,
      description,
      steps,
      tools: toolNames,
      errorRecoveryPatterns,
      preconditions,
      createdAt: Date.now(),
      sourceSessionKey: sessionKey,
      confidence,
      occurrenceCount: this.patternCounts.get(patternKey) ?? 1,
    };

    const filePath = await this.saveSkill(skill);
    return filePath;
  }

  /**
   * Score how likely this session represents a reusable skill (0-1).
   *
   * Signals:
   * - More tool calls = higher signal (multi-step)
   * - Error recovery = valuable pattern
   * - Pattern seen before = much higher confidence
   * - Clean success without errors = moderate signal
   * - Diverse tool usage = more generalizable
   */
  private scoreConfidence(
    toolCalls: ReturnType<typeof this.extractToolCalls>,
    pattern: ToolChainPattern,
    _messages: LLMMessage[],
  ): number {
    let score = 0.3;

    if (toolCalls.length >= 4) score += 0.15;
    else if (toolCalls.length >= 3) score += 0.1;

    if (pattern.errorRecovered) score += 0.2;

    const patternKey = pattern.toolSequence.join('→');
    const occurrences = this.patternCounts.get(patternKey) ?? 0;
    if (occurrences >= 3) score += 0.3;
    else if (occurrences >= 2) score += 0.15;

    const uniqueTools = new Set(toolCalls.map(tc => tc.name));
    if (uniqueTools.size >= 3) score += 0.1;

    const failedCalls = toolCalls.filter(tc => tc.failed);
    if (failedCalls.length === 0 && toolCalls.length >= 3) score += 0.1;

    const hasVerification = toolCalls.some(tc =>
      tc.name === 'exec' || tc.name === 'device_exec' || tc.name === 'read'
    );
    if (hasVerification) score += 0.05;

    return Math.min(1, score);
  }

  private extractToolChainPattern(
    toolCalls: ReturnType<typeof this.extractToolCalls>,
  ): ToolChainPattern {
    const toolSequence = toolCalls.map(tc => tc.name);
    const inputSignature = toolCalls
      .map(tc => `${tc.name}:${Object.keys(tc.input).sort().join(',')}`)
      .join('|');
    const succeeded = !toolCalls[toolCalls.length - 1]?.failed;
    const errorRecovered = toolCalls.some((tc, i) =>
      tc.failed && i < toolCalls.length - 1 && !toolCalls[toolCalls.length - 1].failed
    );
    return { toolSequence, inputSignature, succeeded, errorRecovered };
  }

  private extractMeaningfulSteps(
    toolCalls: ReturnType<typeof this.extractToolCalls>,
  ): string[] {
    return toolCalls
      .filter(tc => !tc.failed)
      .map(tc => {
        const inputKeys = Object.keys(tc.input);
        const primaryArg = inputKeys[0];
        const primaryValue = primaryArg ? String(tc.input[primaryArg] ?? '').slice(0, 80) : '';
        return primaryValue
          ? `${tc.name}: ${primaryArg}=${primaryValue}`
          : tc.name;
      });
  }

  private extractErrorRecoveryPatterns(
    toolCalls: ReturnType<typeof this.extractToolCalls>,
  ): string[] {
    const patterns: string[] = [];
    for (let i = 0; i < toolCalls.length - 1; i++) {
      if (toolCalls[i].failed && !toolCalls[i + 1].failed) {
        patterns.push(
          `${toolCalls[i].name} failed → recovered with ${toolCalls[i + 1].name}`
        );
      }
    }
    return patterns;
  }

  private extractPreconditions(
    toolCalls: ReturnType<typeof this.extractToolCalls>,
    _messages: LLMMessage[],
  ): string[] {
    const preconditions: string[] = [];
    const firstTool = toolCalls[0];
    if (firstTool) {
      if (firstTool.name === 'read' || firstTool.name === 'device_file_read') {
        const filePath = String(firstTool.input.file_path || firstTool.input.path || '');
        if (filePath) preconditions.push(`File exists: ${filePath}`);
      }
      if (firstTool.name === 'device_exec') {
        preconditions.push('Device SSH connected');
      }
    }
    return preconditions;
  }

  private async isDuplicate(pattern: ToolChainPattern, existingFiles: string[]): Promise<boolean> {
    for (const file of existingFiles) {
      try {
        const content = await fs.readFile(path.join(this.skillsDir, file), 'utf-8');
        const existingTools = content.match(/tools:\n([\s\S]*?)(?:\n[a-z]|\n---)/)?.[1] ?? '';
        const existingToolList = existingTools
          .split('\n')
          .map(l => l.replace(/^\s*-\s*/, '').trim())
          .filter(Boolean);

        if (existingToolList.length === 0) continue;
        const overlap = pattern.toolSequence.filter(t => existingToolList.includes(t));
        if (overlap.length >= Math.min(existingToolList.length, pattern.toolSequence.length) * 0.8) {
          return true;
        }
      } catch { /* skip unreadable files */ }
    }
    return false;
  }

  private extractToolCalls(messages: LLMMessage[]): Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    failed: boolean;
  }> {
    const calls: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
      failed: boolean;
    }> = [];
    const callIdToIndex = new Map<string, number>();

    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (typeof block !== 'object' || block === null || !('type' in block)) continue;
        const b = block as Record<string, unknown>;

        if (msg.role === 'assistant' && b.type === 'tool_use') {
          const id = String(b.id ?? `call_${calls.length}`);
          callIdToIndex.set(id, calls.length);
          calls.push({
            id,
            name: String(b.name || ''),
            input: (b.input as Record<string, unknown>) || {},
            failed: false,
          });
          continue;
        }

        if (msg.role === 'user' && b.type === 'tool_result' && b.is_error) {
          const useId = String(b.tool_use_id ?? '');
          const idx = callIdToIndex.get(useId);
          if (idx !== undefined) {
            calls[idx].failed = true;
          } else if (calls.length > 0) {
            calls[calls.length - 1].failed = true;
          }
        }
      }
    }
    return calls;
  }

  private extractText(msg: LLMMessage): string {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((b): b is { type: 'text'; text: string } =>
          typeof b === 'object' && b !== null && 'type' in b && b.type === 'text'
        )
        .map(b => b.text)
        .join(' ');
    }
    return '';
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || `skill-${Date.now()}`;
  }

  private yamlSafeString(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }

  private async saveSkill(skill: LearnedSkill): Promise<string> {
    await fs.mkdir(this.skillsDir, { recursive: true });

    const hash = crypto.createHash('md5')
      .update(skill.name)
      .digest('hex')
      .slice(0, 8);
    const fileName = `${skill.name}-${hash}.md`;
    const filePath = path.join(this.skillsDir, fileName);

    const content = [
      '---',
      `name: ${skill.name}`,
      `description: "${this.yamlSafeString(skill.description)}"`,
      `confidence: ${skill.confidence.toFixed(2)}`,
      `occurrence_count: ${skill.occurrenceCount}`,
      `tools:`,
      ...skill.tools.map(t => `  - ${t}`),
      `learned_at: ${new Date(skill.createdAt).toISOString()}`,
      `source_session: ${skill.sourceSessionKey}`,
      '---',
      '',
      `# ${skill.description}`,
      '',
      ...(skill.preconditions.length > 0 ? [
        '## Preconditions',
        '',
        ...skill.preconditions.map(p => `- ${p}`),
        '',
      ] : []),
      '## Steps',
      '',
      ...skill.steps.map((s, i) => `${i + 1}. \`${s}\``),
      '',
      ...(skill.errorRecoveryPatterns.length > 0 ? [
        '## Error Recovery',
        '',
        ...skill.errorRecoveryPatterns.map(p => `- ${p}`),
        '',
      ] : []),
    ].join('\n');

    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  async listLearnedSkills(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.skillsDir);
      return files.filter(f => f.endsWith('.md'));
    } catch {
      return [];
    }
  }
}
