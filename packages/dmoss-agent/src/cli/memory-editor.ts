import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve the editor command + args from the environment, Claude-Code style:
 * $VISUAL beats $EDITOR (VISUAL is the "full-screen" editor); falls back to a
 * platform default. The command string is split on whitespace so
 * `EDITOR="code -w"` works. Pure — the resolution order is unit-testable.
 * @internal
 */
export function resolveEditorCommand(
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } | null {
  const raw = (env.VISUAL || env.EDITOR || '').trim();
  if (raw) {
    const parts = raw.split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  }
  if (process.platform === 'win32') return { command: 'notepad', args: [] };
  // POSIX: nano (beginner-friendly, ships on macOS/most Linux), then vi as the
  // POSIX-guaranteed fallback is left to the user — nano is the safer default.
  return { command: 'nano', args: [] };
}

/**
 * Open `filePath` in the user's editor, inheriting the terminal so an
 * interactive editor (vim/nano/emacs) can take over the screen.
 *
 * DELIBERATE EXCEPTION to "child processes only via utils/run-process.ts":
 * runProcess pipes stdio and cannot host an interactive full-screen editor —
 * the editor needs the real TTY. run-process is for captured, cancellable tool
 * execution; an editor handoff is neither. Resolves on the editor's exit.
 * @internal
 */
export function openInEditor(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const resolved = resolveEditorCommand(env);
    if (!resolved) {
      reject(new Error('No editor configured ($VISUAL / $EDITOR unset)'));
      return;
    }
    const child = spawn(resolved.command, [...resolved.args, filePath], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });
}

/** Quick-add memory section header appended to AGENTS.md. @internal */
const QUICK_ADD_SECTION = '## Memories';

/**
 * If `raw` is a `#`-quick-add line, return the memory text; else null.
 * Requires a SINGLE leading `#` then whitespace then non-empty text, so a bare
 * `#` or a `##` markdown heading the user actually wants to send is NOT a
 * quick-add. Pure. @internal
 */
export function parseQuickAddMemory(raw: string): string | null {
  const m = /^#[ \t]+(\S.*)$/.exec(raw);
  return m ? m[1].trim() : null;
}

/**
 * Append a memory line to AGENTS.md under a "## Memories" section, creating the
 * file (from `template`) or the section as needed. Returns the absolute path.
 * Uses fs directly — the local memory file, no shell. @internal
 */
export function appendQuickAddMemory(workspace: string, text: string, template?: string): string {
  const target = path.join(workspace, 'AGENTS.md');
  let body = '';
  try {
    body = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    body = template ?? '';
  }
  const line = `- ${text}`;
  if (body.includes(QUICK_ADD_SECTION)) {
    // Function replacer: the matched header + the user's note are inserted as
    // LITERAL text, so a note containing `$1`/`$&`/`$\`` is never expanded as a
    // regex replacement pattern (which would corrupt the note and the file).
    body = body.replace(new RegExp(`${QUICK_ADD_SECTION}\\n`), (m) => `${m}${line}\n`);
  } else {
    const sep = body.length > 0 && !body.endsWith('\n') ? '\n' : '';
    body = `${body}${sep}\n${QUICK_ADD_SECTION}\n${line}\n`;
  }
  fs.writeFileSync(target, body, 'utf8');
  return target;
}
