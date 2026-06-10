/**
 * File-based custom slash commands — mainstream alignment (Claude Code / codex),
 * zero core growth. Design: docs/slash-command-architecture.md ("Custom commands").
 *
 * A user drops `<name>.md` into a commands directory and `/<name>` expands the
 * file body into the next prompt. Two roots, workspace wins on a name clash:
 *   - `<workspace>/.moss/commands/<name>.md`   (project, shareable via git)
 *   - `<configDir>/commands/<name>.md`         (personal, all workspaces)
 *
 * Custom commands enter the SAME registry as built-ins, so they appear in the
 * same help/completion and inherit the unknown-command UX. Built-ins always win
 * a name collision (reservedNames guard) — a custom file can never shadow or
 * break a shipped command.
 */

import fs from 'node:fs';
import path from 'node:path';
import { INTERACTIVE_COMMAND_SECTIONS } from '../interactive-commands.js';
import { registryCommandNames, type CommandSpec } from './registry.js';

/**
 * Every command name a custom file must not shadow: registry built-ins plus the
 * legacy commands still dispatched directly by the REPL/TUI chains, plus the
 * control commands that never appear as help rows. Built-ins always win, so
 * this set keeps custom files from silently capturing a shipped name.
 *
 * IMPORTANT: derives from ALL `INTERACTIVE_COMMAND_SECTIONS` rows — including
 * `hidden` ones (`/memory`, `/skills`, `/context`, `/rewind`, `/detail`, …) —
 * not the menu-only `INTERACTIVE_COMPLETION_COMMANDS`, which omits hidden rows
 * and would let a custom file shadow a hidden legacy command.
 */
export function reservedBuiltinNames(): ReadonlySet<string> {
  const names = new Set<string>([
    ...registryCommandNames(),
    '/help',
    '/quit',
    '/exit',
    '/stop',
    '/abort',
    '/clear',
    '/thinking',
    '/paste',
    '/logout',
  ]);
  for (const section of INTERACTIVE_COMMAND_SECTIONS) {
    for (const row of section.rows) {
      names.add(row.command.split(/\s+/, 1)[0]);
      for (const alias of row.aliases ?? []) names.add(alias);
    }
  }
  return names;
}

/** A custom command name is a single path-safe token (becomes `/<name>`). */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export interface CustomCommandSource {
  /** Workspace dir; files read from `<workspace>/.moss/commands/*.md`. */
  workspace: string;
  /** User config dir; files read from `<configDir>/commands/*.md`. */
  configDir: string;
  /** Built-in command names (with leading slash) custom files must not shadow. */
  reservedNames: ReadonlySet<string>;
}

export interface ParsedCommandFile {
  description?: string;
  argumentHint?: string;
  body: string;
}

/**
 * Parse optional `--- key: value ---` frontmatter (description, argument-hint)
 * followed by the prompt body. Deliberately a tiny line parser, not a YAML
 * dependency — the only recognized keys are description and argument-hint.
 */
export function parseCommandFile(raw: string): ParsedCommandFile {
  let description: string | undefined;
  let argumentHint: string | undefined;
  let body = raw;
  const fm = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm) {
    body = raw.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim().replace(/^["']|["']$/g, '');
      if (key === 'description') description = value;
      else if (key === 'argument-hint' || key === 'argumenthint') argumentHint = value;
    }
  }
  return { description, argumentHint, body: body.trim() };
}

/**
 * Expand a command body against the typed arguments. Supports `$ARGUMENTS` (all
 * args verbatim) and `$1`..`$9` (positional). When the body references neither
 * but arguments were given, they are appended so `/cmd extra context` still
 * reaches the model.
 */
export function expandCommandBody(body: string, args: string): string {
  const trimmed = args.trim();
  const tokens = trimmed.length ? trimmed.split(/\s+/) : [];
  let used = false;
  let out = body.replace(/\$ARGUMENTS\b/g, () => {
    used = true;
    return trimmed;
  });
  out = out.replace(/\$([1-9])/g, (_match, digit: string) => {
    used = true;
    return tokens[Number(digit) - 1] ?? '';
  });
  if (!used && trimmed) out = `${out}\n\n${trimmed}`;
  return out.trim();
}

interface CommandFileEntry {
  name: string;
  file: string;
  parsed: ParsedCommandFile;
}

function readCommandsFromDir(dir: string): CommandFileEntry[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: CommandFileEntry[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -3);
    if (!NAME_RE.test(name)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, entry), 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseCommandFile(raw);
    if (!parsed.body) continue;
    out.push({ name, file: path.join(dir, entry), parsed });
  }
  return out;
}

/**
 * Load custom commands as registry CommandSpecs. Synchronous (small text files)
 * and re-readable each session so editing a `.md` is picked up on next launch.
 * Workspace commands take precedence over user commands of the same name; both
 * skip names already owned by a built-in command.
 */
export function loadCustomCommands(source: CustomCommandSource): CommandSpec[] {
  const seen = new Set<string>();
  const specs: CommandSpec[] = [];
  const dirs = [
    path.join(source.workspace, '.moss', 'commands'),
    path.join(source.configDir, 'commands'),
  ];
  for (const dir of dirs) {
    for (const { name, parsed } of readCommandsFromDir(dir)) {
      const slash = `/${name}` as const;
      if (source.reservedNames.has(slash)) continue;
      if (seen.has(slash)) continue;
      seen.add(slash);
      const summary = parsed.description?.trim() || `custom command (${name}.md)`;
      specs.push({
        name: slash,
        summary: parsed.argumentHint ? `${summary} — args: ${parsed.argumentHint}` : summary,
        run(ctx, args) {
          const prompt = expandCommandBody(parsed.body, args);
          if (!prompt) {
            ctx.say('error', `Custom command ${slash} expanded to an empty prompt.`);
            return;
          }
          // submitPrompt runs it as a turn (both real surfaces wire it). Fall
          // back to pre-filling the input when a surface cannot submit.
          if (ctx.submitPrompt) ctx.submitPrompt(prompt);
          else ctx.prefillInput(prompt);
        },
      });
    }
  }
  return specs;
}
