export interface InteractiveCommandRow {
  command: string;
  description: string;
  menuDescription?: string;
  aliases?: readonly string[];
  hidden?: boolean;
}

export interface InteractiveCommandSection {
  title: string;
  rows: InteractiveCommandRow[];
}

export const INTERACTIVE_COMMAND_SECTIONS: readonly InteractiveCommandSection[] = [
  {
    title: 'Work',
    rows: [
      { command: '/status', description: 'view model, workspace, device, and tool state' },
      { command: '/subagents', description: 'show background sub-agent status and progress' },
      { command: '/model', description: 'choose or switch the active model for this session' },
      { command: '/goal', description: 'show or manage the persistent session goal' },
      { command: '/goal <objective>', description: 'set the goal Moss should keep in context' },
      { command: '/compact', description: 'compress older conversation history into a summary' },
      { command: '/context', description: 'show current context-window usage', hidden: true },
      { command: '/attach <path>', description: 'fallback: attach an image or text file to the next prompt', hidden: true },
      { command: '/connect <ip>', description: 'connect an RDK board for this session without restarting' },
    ],
  },
  {
    title: 'Inspect',
    rows: [
      { command: '/sessions', description: 'list saved conversations you can resume' },
      { command: '/cost', description: 'show recorded token usage and estimated cost', hidden: true },
      { command: '/diff', description: 'show git working-tree changes' },
      { command: '/rewind [seq]', description: 'undo file edits from a checkpoint', hidden: true },
      { command: '/memory', description: 'show stored long-term memories', hidden: true },
      { command: '/skills', description: 'list learned SKILL.md files', hidden: true },
    ],
  },
  {
    title: 'Configure',
    rows: [
      { command: '/auth login', description: 'optional: link a D-Robotics developer community account' },
      { command: '/auth login --manual', description: 'optional SSH login by pasting the browser redirect URL or token', hidden: true },
      { command: '/logout', description: 'log out of the D-Robotics developer community', hidden: true },
      {
        command: '/quickstart',
        description: 'configure model, workspace, board, and first tasks',
        aliases: ['/quick_start', '/start'],
        hidden: true,
      },
      { command: '/examples', description: 'show task examples for enabled capabilities', hidden: true },
      { command: '/permissions', description: 'show safety, approvals, cache, and config policy', hidden: true },
      { command: '/config', description: 'show config file and policy commands', hidden: true },
      { command: '/tools', description: 'view available tool groups and how Moss chooses them', hidden: true },
      { command: '/models', description: 'list selectable models for the active provider', hidden: true },
    ],
  },
  {
    title: 'Control',
    rows: [
      { command: '/stop', description: 'stop the active run', hidden: true },
      { command: '/queue', description: 'show, drop, resume, or clear queued prompts', hidden: true },
      { command: '/detail [mode]', description: 'set quiet, progress, or verbose output', hidden: true },
      { command: '/thinking', description: 'toggle thinking deltas', hidden: true },
      { command: '/clear', description: 'clear the visible transcript', hidden: true },
      { command: '/version', description: 'show the installed Moss version', hidden: true },
      { command: '/upgrade', description: 'show install and update commands', hidden: true },
      { command: '/init', description: 'create an AGENTS.md project memory file', hidden: true },
      { command: '/help', description: 'show this command reference' },
      { command: '/quit', description: 'exit D-Moss', hidden: true },
    ],
  },
] as const;

function uniqueMenuRows(): InteractiveCommandRow[] {
  const seen = new Set<string>();
  const rows: InteractiveCommandRow[] = [];
  for (const row of INTERACTIVE_COMMAND_SECTIONS.flatMap((section) => section.rows)) {
    if (row.hidden) continue;
    const command = commandToken(row.command);
    if (seen.has(command)) continue;
    seen.add(command);
    rows.push({
      command,
      description: row.menuDescription ?? row.description,
      ...(row.aliases ? { aliases: row.aliases } : {}),
    });
  }
  return rows;
}

export const SLASH_MENU_ROWS: readonly InteractiveCommandRow[] = uniqueMenuRows();

function commandToken(command: string): string {
  return command.split(/\s+/, 1)[0] ?? command;
}

export const INTERACTIVE_COMPLETION_COMMANDS: readonly string[] = Array.from(new Set([
  ...SLASH_MENU_ROWS.map((row) => row.command),
  ...SLASH_MENU_ROWS.flatMap((row) => row.aliases ?? []),
]));

export function commandRowsForSlashInput(value: string): Array<[string, string]> {
  if (!value.startsWith('/')) return [];
  const normalized = value.trim().toLowerCase();
  const rows = SLASH_MENU_ROWS.map((row): [string, string] => [row.command, row.description]);
  return normalized === '/'
    ? rows
    : rows.filter(([command]) => command.startsWith(normalized));
}

export function formatInteractiveCommandSections(options: {
  indent?: string;
  commandWidth?: number;
  includeHidden?: boolean;
} = {}): string[] {
  const indent = options.indent ?? '    ';
  const commandWidth = options.commandWidth ?? 23;
  const lines: string[] = [];
  for (const section of INTERACTIVE_COMMAND_SECTIONS) {
    lines.push(`  ${section.title}`);
    for (const row of section.rows) {
      if (row.hidden && !options.includeHidden) continue;
      lines.push(`${indent}${row.command.padEnd(commandWidth)} ${row.description}`);
    }
  }
  return lines;
}
