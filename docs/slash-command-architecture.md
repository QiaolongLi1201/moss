# Slash Command Architecture: Unify the Dual Dispatch

Status: proposed (evidence collected 2026-06-10) · Owner: CLI maintainers

## Problem, with evidence

Every slash command is implemented twice: once in the readline REPL loop
(`packages/dmoss-agent/src/cli/repl.ts`) and once in the TUI's `handleCommand`
(`packages/dmoss-agent/src/cli/tui.ts`). Command metadata lives in a third
place (`packages/dmoss-agent/src/cli/interactive-commands.ts` help rows) and a
fourth (`commandArgumentHint` / `commandSuggestion` in `tui.ts`).

Measured today: TUI dispatches 42 commands, REPL 36, all hand-written chains.

Observed drift (all real, all user-visible):

1. Unknown-command UX exists in three variants: TUI (suggestion + "will not
   reach the model" note, localized), REPL (plain list dump), and the prompt
   editor's inline suggestion.
2. Ctrl+D leaves board mode in the TUI but ends the REPL process.
3. Before the 2026-06-10 fixes, `/connect`'s usage string, help row, and
   argument hint each documented a different subset of its real flags — the
   flags existed, three metadata sites drifted independently.
4. Cost evidence: the board-mode work required editing both dispatch chains
   for `/connect` (3×) and `/disconnect` (1×) in a single session.

Classification (CLAUDE.md brainstorming workflow): **B** — nothing is broken
today, but drift recurs structurally and every command change costs 2×.

## Target shape (lean, not a framework)

One registry module, `cli/commands/`:

```ts
interface CommandSpec {
  name: string;                 // '/connect'
  summary: string;              // help row text
  argHint?: string;             // prompt-editor hint
  scope: 'both' | 'tui' | 'repl';
  hidden?: boolean;
  run(ctx: CommandContext, args: string): Promise<void> | void;
}

interface CommandContext {
  say(kind: 'system' | 'error', text: string): void;  // transcript or console
  prefillInput?(text: string): void;                  // TUI input / rl.write
  agent: DmossAgent;
  runtime: CliRuntimeStatus;
  locale?: string;
  sessionKey: string;
}
```

- `interactive-commands.ts` help rows, completion lists, and argument hints
  become **views derived from the registry** — one source of truth.
- `repl.ts` and `tui.ts` each shrink to a ~10-line dispatcher plus their own
  `CommandContext` implementation. Business logic stays where it already
  lives (`device-connect.ts`, `compact-command.ts`, `model-catalog.ts`, …) —
  the registry owns *dispatch and metadata only*.
- Unknown-command handling is written once (suggestion + "does not reach the
  model" note, localized).

## Custom commands (mainstream alignment, zero core growth) — IMPLEMENTED

File-based custom commands following the Claude Code convention:
`.moss/commands/<name>.md` (workspace) and `<configDir>/commands/<name>.md`
(user). Each file registers a CommandSpec whose `run` expands the file body
into the next prompt. This answers "let users define /xxx" without adding any
core surface: custom commands enter the same registry, appear in the same
help/completion, and inherit the same unknown-command behavior.

Shipped in `cli/commands/custom-commands.ts`:

- Two roots, workspace wins a name clash; both skip reserved built-in names
  (`reservedBuiltinNames()`), so a custom file can never shadow a shipped
  command — built-ins are matched first in `findRegistryCommand`.
- Optional `--- description / argument-hint ---` frontmatter; body supports
  `$ARGUMENTS` and `$1..$9`, and appends bare args when neither is referenced.
- A new optional `CommandContext.submitPrompt` lets a command run its expanded
  body as a turn; the REPL wires it to `runOneShot`, the TUI to `runInput`.
- Custom commands appear in the TUI slash menu (`commandRowsForSlashInput`
  takes an `extra` arg), in `/help` on both surfaces, and in the REPL
  unknown-command "Available" list.

This shipped ahead of full registry consolidation because both surfaces
already dispatch through the registry FIRST: file-based commands work today
without waiting for phases 2–3, and the built-in-wins guard keeps them safe.

## Migration plan (each phase shippable alone)

1. Registry + context types + derived help/completion. Pilot three commands
   (`/version`, `/help`, `/disconnect`) through it; parity-test against the
   old chains (`cli-goal-visibility` and the TUI render snapshots are the
   safety net).
2. Batch-move the pure-output commands (`/status`, `/tools`, `/examples`,
   `/permissions`, `/quickstart`, `/version`, `/models`, `/cost`, `/context`).
3. Move the stateful ones last (`/connect`, `/model`, `/goal`, `/compact`,
   `/auth`, `/skills`), one per PR, then delete both legacy chains.
4. Only after the registry is the single dispatch: add `.moss/commands/`
   custom commands.

## Non-goals (recorded so they are not re-proposed)

- No plugin API for commands beyond the file-based convention above.
- No moving of command business logic into the registry — dispatch only.
- No REPL/TUI feature parity forcing: scope: 'tui' is legitimate for
  attachment/queue commands that need a rich terminal.

## Reopening trigger

Begin phase 1 the next time any command must be added or changed on both
surfaces — that event has already occurred 4× in one session, so in practice:
next CLI feature.
