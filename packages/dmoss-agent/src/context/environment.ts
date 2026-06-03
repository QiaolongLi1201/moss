/**
 * Environment context layer — a session-start snapshot of the working
 * environment, injected into the system prompt so a standalone `moss` run is
 * oriented in the project the way a host app (RDK Studio) orients it.
 *
 * Captures: working directory, platform, date, a shallow top-level file listing,
 * and git state (branch, uncommitted changes, recent commits). The snapshot is
 * taken once per session, so it stays stable within a session (prompt-cache
 * friendly) while reflecting the real project on each new run.
 */

import fs from 'node:fs/promises';
import { runProcess } from '../utils/run-process.js';
import { safeChildEnv } from '../utils/safe-child-env.js';

const GIT_TIMEOUT_MS = 3000;
const MAX_TREE_ENTRIES = 40;
const MAX_STATUS_LINES = 20;
const MAX_LOG_LINES = 5;

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const r = await runProcess('git', {
      args,
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: safeChildEnv({ GIT_OPTIONAL_LOCKS: '0' }),
    });
    return r.stdout.trim();
  } catch {
    return null;
  }
}

async function topLevelEntries(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .slice(0, MAX_TREE_ENTRIES);
  } catch {
    return [];
  }
}

export interface EnvironmentContextOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Skip git probing (e.g. for tests or non-repo workspaces). */
  includeGit?: boolean;
}

/**
 * Build the `# Environment` prompt layer for a workspace. Returns an empty
 * string only if the workspace is unreadable.
 */
export async function buildEnvironmentContextLayer(
  workspaceDir: string,
  options: EnvironmentContextOptions = {},
): Promise<string> {
  const now = options.now ?? (() => new Date());
  const includeGit = options.includeGit !== false;
  const lines: string[] = [];

  lines.push(`- Working directory: ${workspaceDir}`);
  lines.push(`- Platform: ${process.platform}`);
  lines.push(`- Today's date: ${now().toISOString().slice(0, 10)}`);

  const entries = await topLevelEntries(workspaceDir);
  if (entries.length > 0) {
    lines.push(`- Top-level entries: ${entries.join(', ')}`);
  }

  if (includeGit) {
    const insideRepo = (await git(['rev-parse', '--is-inside-work-tree'], workspaceDir)) === 'true';
    if (!insideRepo) {
      lines.push('- Git: not a git repository');
    } else {
      const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceDir);
      if (branch) lines.push(`- Git branch: ${branch}`);

      const status = await git(['status', '--porcelain'], workspaceDir);
      if (status !== null) {
        const changed = status ? status.split('\n').filter(Boolean) : [];
        if (changed.length === 0) {
          lines.push('- Git status: clean (no uncommitted changes)');
        } else {
          lines.push(`- Git status: ${changed.length} uncommitted change(s):`);
          for (const c of changed.slice(0, MAX_STATUS_LINES)) lines.push(`    ${c}`);
          if (changed.length > MAX_STATUS_LINES) {
            lines.push(`    ... and ${changed.length - MAX_STATUS_LINES} more`);
          }
        }
      }

      const log = await git(['log', '--oneline', '-n', String(MAX_LOG_LINES)], workspaceDir);
      if (log) {
        lines.push('- Recent commits:');
        for (const l of log.split('\n').slice(0, MAX_LOG_LINES)) lines.push(`    ${l}`);
      }
    }
  }

  return `# Environment\n\n${lines.join('\n')}`;
}
