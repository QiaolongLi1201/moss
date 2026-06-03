/**
 * Workspace Memory Layer — reads Markdown files from the workspace to build
 * persistent context.
 *
 * D-Moss uses a three-layer memory architecture:
 *   Layer 1 (this module): file-based memory (USER.md, MEMORY.md, AGENTS.md)
 *                          that persists across sessions and is injected into
 *                          the system prompt on every request.
 *   Layer 2: MemoryManager — BM25 keyword search over prior turns.
 *   Layer 3: Session JSONL — full append-only journal of every event.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export interface WorkspaceMemoryConfig {
  workspaceDir: string;
}

export interface WorkspaceMemoryContext {
  projectInstructions: string | null;
  userProfile: string | null;
  longTermMemory: string | null;
  agentRules: string | null;
}

interface MemoryFileSpec {
  key: keyof WorkspaceMemoryContext;
  /** Candidate filenames, tried in order (covers case variants on case-sensitive FS). */
  filenames: string[];
  label: string;
  /** Whether `ensureDefaultFiles` scaffolds an empty version when absent. */
  scaffold: boolean;
}

const MEMORY_FILES: MemoryFileSpec[] = [
  // Project-level instructions, the standalone analog of CLAUDE.md / AGENTS.md.
  { key: 'projectInstructions', filenames: ['MOSS.md', 'Moss.md', 'moss.md'], label: 'Project Instructions', scaffold: false },
  { key: 'agentRules', filenames: ['AGENTS.md'], label: 'Agent Rules', scaffold: true },
  { key: 'userProfile', filenames: ['USER.md'], label: 'User Profile', scaffold: true },
  { key: 'longTermMemory', filenames: ['MEMORY.md'], label: 'Long-term Memory', scaffold: true },
];

const MAX_FILE_SIZE = 10_000;

export class WorkspaceMemory {
  private readonly dir: string;

  constructor(config: WorkspaceMemoryConfig) {
    this.dir = config.workspaceDir;
  }

  async loadContext(): Promise<WorkspaceMemoryContext> {
    const ctx: WorkspaceMemoryContext = {
      projectInstructions: null,
      userProfile: null,
      longTermMemory: null,
      agentRules: null,
    };

    for (const { key, filenames } of MEMORY_FILES) {
      for (const filename of filenames) {
        try {
          const filePath = path.join(this.dir, filename);
          const content = await fs.readFile(filePath, 'utf-8');
          if (content.trim()) {
            ctx[key] = content.length > MAX_FILE_SIZE
              ? content.slice(0, MAX_FILE_SIZE) + '\n\n[... truncated]'
              : content;
            break; // first matching candidate wins
          }
        } catch { /* file doesn't exist, try next candidate */ }
      }
    }

    return ctx;
  }

  buildPromptLayer(ctx: WorkspaceMemoryContext): string {
    const sections: string[] = [];

    if (ctx.projectInstructions) {
      sections.push(`## Project Instructions (MOSS.md)\n${ctx.projectInstructions}`);
    }
    if (ctx.agentRules) {
      sections.push(`## Agent Rules\n${ctx.agentRules}`);
    }
    if (ctx.userProfile) {
      sections.push(`## User Profile\n${ctx.userProfile}`);
    }
    if (ctx.longTermMemory) {
      sections.push(`## Long-term Memory\n${ctx.longTermMemory}`);
    }

    if (sections.length === 0) return '';
    return `# Workspace Context\n\n${sections.join('\n\n')}`;
  }

  async ensureDefaultFiles(): Promise<void> {
    for (const { filenames, label, scaffold } of MEMORY_FILES) {
      if (!scaffold) continue;
      const filePath = path.join(this.dir, filenames[0]);
      try {
        await fs.access(filePath);
      } catch {
        const defaultContent = `# ${label}\n\n<!-- This file is automatically read by D-Moss on startup. -->\n<!-- Add your notes here and they will persist across sessions. -->\n`;
        await fs.writeFile(filePath, defaultContent, 'utf-8');
      }
    }
  }
}
