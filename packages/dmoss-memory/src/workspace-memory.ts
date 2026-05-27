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
  userProfile: string | null;
  longTermMemory: string | null;
  agentRules: string | null;
}

const MEMORY_FILES: Array<{ key: keyof WorkspaceMemoryContext; filename: string; label: string }> = [
  { key: 'userProfile', filename: 'USER.md', label: 'User Profile' },
  { key: 'longTermMemory', filename: 'MEMORY.md', label: 'Long-term Memory' },
  { key: 'agentRules', filename: 'AGENTS.md', label: 'Agent Rules' },
];

const MAX_FILE_SIZE = 10_000;

export class WorkspaceMemory {
  private readonly dir: string;

  constructor(config: WorkspaceMemoryConfig) {
    this.dir = config.workspaceDir;
  }

  async loadContext(): Promise<WorkspaceMemoryContext> {
    const ctx: WorkspaceMemoryContext = {
      userProfile: null,
      longTermMemory: null,
      agentRules: null,
    };

    for (const { key, filename } of MEMORY_FILES) {
      try {
        const filePath = path.join(this.dir, filename);
        const content = await fs.readFile(filePath, 'utf-8');
        if (content.trim()) {
          ctx[key] = content.length > MAX_FILE_SIZE
            ? content.slice(0, MAX_FILE_SIZE) + '\n\n[... truncated]'
            : content;
        }
      } catch { /* file doesn't exist, skip */ }
    }

    return ctx;
  }

  buildPromptLayer(ctx: WorkspaceMemoryContext): string {
    const sections: string[] = [];

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
    for (const { filename, label } of MEMORY_FILES) {
      const filePath = path.join(this.dir, filename);
      try {
        await fs.access(filePath);
      } catch {
        const defaultContent = `# ${label}\n\n<!-- This file is automatically read by D-Moss on startup. -->\n<!-- Add your notes here and they will persist across sessions. -->\n`;
        await fs.writeFile(filePath, defaultContent, 'utf-8');
      }
    }
  }
}
