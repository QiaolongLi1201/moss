export interface InteractiveCommandRow {
  command: string;
  description: string;
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
      { command: '/model', description: 'choose or switch the active model for this session' },
      { command: '/goal', description: 'show or manage the persistent session goal' },
      { command: '/goal set <objective>', description: 'set the goal Moss should keep in context' },
      { command: '/compact', description: 'compress older conversation history into a summary' },
      { command: '/context', description: 'show current context-window usage' },
      { command: '/attach <path>', description: 'attach an image or text file to the next prompt' },
    ],
  },
  {
    title: 'Inspect',
    rows: [
      { command: '/sessions', description: 'list saved conversations you can resume' },
      { command: '/cost', description: 'show recorded token usage and estimated cost' },
      { command: '/diff', description: 'show git working-tree changes' },
      { command: '/rewind [seq]', description: 'undo file edits from a checkpoint' },
      { command: '/memory', description: 'show stored long-term memories' },
      { command: '/skills', description: 'list learned SKILL.md files' },
    ],
  },
  {
    title: 'Configure',
    rows: [
      { command: '/auth login', description: 'log in to the D-Robotics developer community' },
      { command: '/logout', description: 'log out of the D-Robotics developer community' },
      { command: '/quick_start', description: 'configure model, workspace, board, and first tasks' },
      { command: '/examples', description: 'show task examples for enabled capabilities' },
      { command: '/permissions', description: 'show safety, approvals, cache, and config policy' },
      { command: '/config', description: 'show config file and policy commands' },
      { command: '/tools', description: 'view available tool groups and how Moss chooses them' },
      { command: '/models', description: 'list selectable models for the active provider' },
    ],
  },
  {
    title: 'Control',
    rows: [
      { command: '/stop', description: 'stop the active run' },
      { command: '/queue', description: 'show, drop, resume, or clear queued prompts' },
      { command: '/detail [mode]', description: 'set quiet, progress, or verbose output' },
      { command: '/thinking', description: 'toggle thinking deltas' },
      { command: '/clear', description: 'clear the visible transcript' },
      { command: '/version', description: 'show the installed dmoss version' },
      { command: '/upgrade', description: 'show install and update commands' },
      { command: '/init', description: 'create an AGENTS.md project memory file' },
      { command: '/help', description: 'show this command reference' },
      { command: '/quit', description: 'exit D-Moss' },
    ],
  },
] as const;

export const SLASH_MENU_ROWS: readonly InteractiveCommandRow[] = [
  { command: '/status', description: 'view runtime state' },
  { command: '/model', description: 'choose active model' },
  { command: '/goal', description: 'manage session goal' },
  { command: '/compact', description: 'compress old context' },
  { command: '/context', description: 'show token usage' },
  { command: '/sessions', description: 'list saved chats' },
  { command: '/attach', description: 'attach file to next prompt' },
  { command: '/diff', description: 'show git changes' },
  { command: '/rewind', description: 'undo file edits' },
  { command: '/queue', description: 'manage queued prompts' },
  { command: '/stop', description: 'stop active run' },
  { command: '/auth login', description: 'community login' },
  { command: '/logout', description: 'community logout' },
  { command: '/quick_start', description: 'configure setup' },
  { command: '/examples', description: 'show task examples' },
  { command: '/permissions', description: 'show safety policy' },
  { command: '/config', description: 'show config policy' },
  { command: '/tools', description: 'view tool groups' },
  { command: '/models', description: 'list models' },
  { command: '/detail', description: 'set output detail' },
  { command: '/cost', description: 'show token cost' },
  { command: '/memory', description: 'show memories' },
  { command: '/skills', description: 'list skills' },
  { command: '/thinking', description: 'toggle thinking' },
  { command: '/version', description: 'show version' },
  { command: '/upgrade', description: 'show update commands' },
  { command: '/init', description: 'create AGENTS.md' },
  { command: '/clear', description: 'clear transcript' },
  { command: '/help', description: 'show commands' },
  { command: '/quit', description: 'exit D-Moss' },
] as const;

const COMMAND_VARIANTS = [
  '/session',
  '/queued',
  '/exit',
  '/abort',
  '/clearqueue',
  '/goal status',
  '/goal set',
  '/goal pause',
  '/goal resume',
  '/goal complete',
  '/goal block',
  '/goal clear',
  '/detail quiet',
  '/detail progress',
  '/detail verbose',
  '/auth',
  '/auth status',
  '/auth logout',
  '/queue drop',
  '/queue pop',
  '/queue clear',
  '/queue resume',
  '/queue continue',
  '/attach list',
  '/attach clear',
] as const;

function commandToken(command: string): string {
  return command.split(/\s+/, 1)[0] ?? command;
}

export const INTERACTIVE_COMPLETION_COMMANDS: readonly string[] = Array.from(new Set([
  ...SLASH_MENU_ROWS.map((row) => row.command),
  ...INTERACTIVE_COMMAND_SECTIONS.flatMap((section) => section.rows.map((row) => commandToken(row.command))),
  ...COMMAND_VARIANTS,
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
} = {}): string[] {
  const indent = options.indent ?? '    ';
  const commandWidth = options.commandWidth ?? 23;
  const lines: string[] = [];
  for (const section of INTERACTIVE_COMMAND_SECTIONS) {
    lines.push(`  ${section.title}`);
    for (const row of section.rows) {
      lines.push(`${indent}${row.command.padEnd(commandWidth)} ${row.description}`);
    }
  }
  return lines;
}
