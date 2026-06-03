/**
 * `code_diagnostics` — run the project's type/lint checks and report errors/warnings.
 *
 * After editing code, the agent needs to see type errors and warnings (the first
 * pillar of "code intelligence"). This tool runs a diagnostic command in the
 * workspace and returns a clear pass/fail plus the checker output:
 *   - JS/TS projects are auto-detected (a package.json typecheck/lint/check
 *     script, then a local `tsc --noEmit`, then a local `eslint`).
 *   - Any other toolchain is supported via an explicit `command`
 *     (e.g. "ruff check .", "mypy .", "cargo check", "go vet ./...").
 *
 * Go-to-definition and find-references (the other two pillars) need a language
 * server or symbol index; wire one through Moss's MCP client (an LSP-MCP server)
 * rather than this tool.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess, ProcessError } from '../utils/run-process.js';
import { safeChildEnv } from '../utils/safe-child-env.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import { assertSandboxPath } from '../safety/sandbox-paths.js';
import type { Tool, ToolContext } from '../core/tools/tool-types.js';

const IS_WIN = process.platform === 'win32';
const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_MAX = 16_000;

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function localBin(dir: string, name: string): Promise<string | null> {
  const bin = path.join(dir, 'node_modules', '.bin', IS_WIN ? `${name}.cmd` : name);
  return (await fileExists(bin)) ? bin : null;
}

const ESLINT_CONFIGS = [
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
];

async function hasEslintConfig(dir: string): Promise<boolean> {
  for (const f of ESLINT_CONFIGS) {
    if (await fileExists(path.join(dir, f))) return true;
  }
  return false;
}

async function detectCommand(dir: string): Promise<{ command: string; why: string } | null> {
  // 1) package.json scripts (most authoritative — it's how the project checks itself)
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    const scripts = pkg?.scripts ?? {};
    for (const name of ['typecheck', 'type-check', 'tsc', 'lint', 'check']) {
      if (typeof scripts[name] === 'string') {
        return { command: `npm run ${name} --silent`, why: `package.json script "${name}"` };
      }
    }
  } catch {
    /* no package.json or unreadable */
  }
  // 2) local TypeScript compiler
  if (await fileExists(path.join(dir, 'tsconfig.json'))) {
    const bin = await localBin(dir, 'tsc');
    if (bin) return { command: `"${bin}" --noEmit --pretty false`, why: 'tsconfig.json + local tsc' };
  }
  // 3) local ESLint
  if (await hasEslintConfig(dir)) {
    const bin = await localBin(dir, 'eslint');
    if (bin) return { command: `"${bin}" .`, why: 'eslint config + local eslint' };
  }
  return null;
}

function truncate(s: string, max = OUTPUT_MAX): string {
  return s.length > max ? `${s.slice(0, max)}\n\n[... truncated ${s.length - max} chars]` : s;
}

export const codeDiagnosticsTool: Tool = {
  name: 'code_diagnostics',
  description:
    'Run the project type/lint checks and report errors and warnings — use this after editing code. ' +
    'Auto-detects JS/TS checks (package.json typecheck/lint script, local tsc, or local eslint). ' +
    'For other toolchains pass `command` (e.g. "ruff check .", "mypy .", "cargo check", "go vet ./...").',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    permissionBoundary:
      'Executes a diagnostic command in the workspace cwd. Hosts may gate it via AgentHooks.onBeforeToolExec.',
  },
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Explicit diagnostic command to run (overrides auto-detection)',
      },
      path: {
        type: 'string',
        description: 'Subdirectory to run in, relative to workspace root (default: workspace root)',
      },
      timeout_ms: { type: 'number', description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
    },
  },
  async execute(input, ctx: ToolContext) {
    const timeoutMs = Math.max(1000, Number(input.timeout_ms) || DEFAULT_TIMEOUT_MS);

    let cwd = ctx.workspaceDir;
    if (input.path) {
      try {
        const { resolved } = await assertSandboxPath({
          filePath: String(input.path),
          cwd: ctx.workspaceDir,
          root: ctx.workspaceDir,
        });
        cwd = resolved;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    let command = typeof input.command === 'string' ? input.command.trim() : '';
    let why = 'explicit command';
    if (!command) {
      const detected = await detectCommand(cwd);
      if (!detected) {
        return (
          'No diagnostic command detected (looked for package.json typecheck/lint/check scripts, ' +
          'local tsc, and local eslint). Pass `command` to run a specific checker, ' +
          'e.g. "ruff check .", "mypy .", "cargo check", "go vet ./...".'
        );
      }
      command = detected.command;
      why = detected.why;
    }

    const danger = isCommandDangerous(command);
    if (danger.blocked) return `Command blocked: ${danger.reason}`;

    const shell = IS_WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
    const args = IS_WIN ? ['/c', command] : ['-c', command];
    const header = `$ ${command}\n(via ${why})`;

    try {
      const result = await runProcess(shell, {
        args,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        signal: ctx.abortSignal,
        env: safeChildEnv({ LANG: process.env.LANG || 'en_US.UTF-8' }),
        cwd,
      });
      const out = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n').trim();
      return `${header}\n\n✓ Passed — no diagnostics (exit 0).${out ? `\n\n${truncate(out)}` : ''}`;
    } catch (err) {
      if (err instanceof ProcessError) {
        const out = [err.stdout.trim(), err.stderr.trim()].filter(Boolean).join('\n').trim();
        return `${header}\n\n✗ Diagnostics reported (exit ${err.exitCode}):\n\n${truncate(out) || err.message}`;
      }
      throw err;
    }
  },
};
