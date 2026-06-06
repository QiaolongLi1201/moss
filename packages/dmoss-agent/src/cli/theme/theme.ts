// ────────────────────────────────────────────────────────────────────────────
// CLI Theme engine — JSON-driven semantic token system
// ────────────────────────────────────────────────────────────────────────────

export interface CliThemeTokens {
  claude: string; text: string; textSecondary: string; textMuted: string;
  textDim: string; inverseText: string; inactive: string; subtle: string;
  suggestion: string; user: string; tool: string; permission: string;
  success: string; error: string; warning: string; merged: string;
  promptBorder: string; planMode: string; autoAccept: string; bashBorder: string;
  ide: string; fastMode: string;
  diffAdded: string; diffRemoved: string; diffAddedDimmed: string; diffRemovedDimmed: string;
  diffAddedWord: string; diffRemovedWord: string;
  userMessageBackground: string; bashMessageBackgroundColor: string;
  memoryBackgroundColor: string; selectionBg: string;
  rateLimitFill: string; rateLimitEmpty: string;
  briefLabelYou: string; briefLabelClaude: string;
  claudeShimmer: string; warningShimmer: string; permissionShimmer: string; toolShimmer: string;
  subagent1: string; subagent2: string; subagent3: string; subagent4: string;
  subagent5: string; subagent6: string; subagent7: string; subagent8: string;
  rainbowRed: string; rainbowOrange: string; rainbowYellow: string; rainbowGreen: string;
  rainbowCyan: string; rainbowBlue: string; rainbowViolet: string;
  primary: string; primarySoft: string; border: string;
}

export interface CliTheme {
  name: string;
  type: 'dark' | 'light' | 'daltonized';
  tokens: CliThemeTokens;
}

// Aligned to Claude Code's dark theme (claude-code/src/utils/theme.ts `darkTheme`),
// rgb→hex. NOTE: downstream brand orange/cyan lives only in brand.ts/logo.ts
// for the startup logo; the general accent stays Claude orange #d77757.
export const AURORA_DARK_TOKENS: CliThemeTokens = {
  claude: '#d77757', text: '#ffffff', textSecondary: '#c4c4c4',
  textMuted: '#6a6a6a', textDim: '#505050', inverseText: '#000000',
  inactive: '#999999', subtle: '#505050', suggestion: '#b1b9f9',
  user: '#7ab4e8', tool: '#d77757', permission: '#b1b9f9',
  success: '#4eba65', error: '#ff6b80', warning: '#ffc107', merged: '#af87ff',
  promptBorder: '#888888', planMode: '#48968c', autoAccept: '#af87ff',
  bashBorder: '#fd5db1', ide: '#4782c8', fastMode: '#ff7814',
  diffAdded: '#225c2b', diffRemoved: '#7a2936', diffAddedDimmed: '#475a4a',
  diffRemovedDimmed: '#69484d', diffAddedWord: '#38a660', diffRemovedWord: '#b3596b',
  userMessageBackground: '#373737', bashMessageBackgroundColor: '#413c41',
  memoryBackgroundColor: '#374146', selectionBg: '#264f78',
  rateLimitFill: '#b1b9f9', rateLimitEmpty: '#505370',
  briefLabelYou: '#7ab4e8', briefLabelClaude: '#d77757',
  claudeShimmer: '#eb9f7f', warningShimmer: '#ffdf39',
  permissionShimmer: '#cfd7ff', toolShimmer: '#eb9f7f',
  subagent1: '#dc2626', subagent2: '#2563eb', subagent3: '#16a34a', subagent4: '#ca8a04',
  subagent5: '#9333ea', subagent6: '#ea580c', subagent7: '#db2777', subagent8: '#0891b2',
  rainbowRed: '#eb5f57', rainbowOrange: '#f58b57', rainbowYellow: '#fac35f',
  rainbowGreen: '#91c882', rainbowCyan: '#82aadc', rainbowBlue: '#9b82c8', rainbowViolet: '#c882b4',
  primary: '#d77757', primarySoft: '#eb9f7f', border: '#888888',
};

export const AURORA_DARK_THEME: CliTheme = {
  name: 'Aurora Dark',
  type: 'dark',
  tokens: AURORA_DARK_TOKENS,
};

// Claude-code-aligned light palette, tuned for terminal cells rather than a web
// canvas. The muted/dim tokens stay dark enough for white or translucent macOS
// Terminal backgrounds, where SGR dim can otherwise become unreadable.
export const AURORA_LIGHT_TOKENS: CliThemeTokens = {
  claude: '#d77757', text: '#000000', textSecondary: '#333333',
  textMuted: '#4b5563', textDim: '#6b7280', inverseText: '#ffffff',
  inactive: '#666666', subtle: '#9ca3af', suggestion: '#5769f7',
  user: '#2563eb', tool: '#c2410c', permission: '#5769f7',
  success: '#2c7a39', error: '#ab2b3f', warning: '#966c1e', merged: '#8700ff',
  promptBorder: '#767676', planMode: '#006666', autoAccept: '#8700ff',
  bashBorder: '#ff0087', ide: '#4782c8', fastMode: '#ff6a00',
  diffAdded: '#69db7c', diffRemoved: '#ffa8b4', diffAddedDimmed: '#c7e1cb',
  diffRemovedDimmed: '#fdd2d8', diffAddedWord: '#2f9d44', diffRemovedWord: '#d1454b',
  userMessageBackground: '#373737', bashMessageBackgroundColor: '#faf5fa',
  memoryBackgroundColor: '#e6f5fa', selectionBg: '#b4d5ff',
  rateLimitFill: '#5769f7', rateLimitEmpty: '#272f6f',
  briefLabelYou: '#2563eb', briefLabelClaude: '#d77757',
  claudeShimmer: '#f59575', warningShimmer: '#c89e50',
  permissionShimmer: '#899bff', toolShimmer: '#f59575',
  subagent1: '#dc2626', subagent2: '#2563eb', subagent3: '#16a34a', subagent4: '#ca8a04',
  subagent5: '#9333ea', subagent6: '#ea580c', subagent7: '#db2777', subagent8: '#0891b2',
  rainbowRed: '#eb5f57', rainbowOrange: '#f58b57', rainbowYellow: '#fac35f',
  rainbowGreen: '#91c882', rainbowCyan: '#82aadc', rainbowBlue: '#9b82c8', rainbowViolet: '#c882b4',
  primary: '#c2410c', primarySoft: '#966c1e', border: '#767676',
};

export const AURORA_LIGHT_THEME: CliTheme = {
  name: 'Aurora Light',
  type: 'light',
  tokens: AURORA_LIGHT_TOKENS,
};

export type CliThemeMode = 'dark' | 'light';

function forcedThemeMode(env: NodeJS.ProcessEnv): CliThemeMode | null {
  const raw = `${env.DMOSS_TUI_THEME ?? env.DMOSS_THEME ?? ''}`.trim().toLowerCase();
  if (!raw || raw === 'auto') return null;
  if (raw.startsWith('light')) return 'light';
  if (raw.startsWith('dark')) return 'dark';
  return null;
}

function modeFromColorFgBg(value: string | undefined): CliThemeMode | null {
  if (!value) return null;
  const last = value.split(/[;:]/).filter(Boolean).at(-1);
  const background = last === undefined ? Number.NaN : Number.parseInt(last, 10);
  if (!Number.isFinite(background)) return null;
  if (background === 7 || background >= 9) return 'light';
  if (background >= 0) return 'dark';
  return null;
}

function modeFromNamedEnvironment(env: NodeJS.ProcessEnv): CliThemeMode | null {
  const raw = [
    env.COLOR_SCHEME,
    env.OS_APPEARANCE,
    env.TERM_THEME,
    env.ITERM_PROFILE,
    env.TERMINAL_PROFILE,
  ].filter(Boolean).join(' ').toLowerCase();
  if (!raw) return null;
  if (/(light|day|paper|white|latte)/.test(raw)) return 'light';
  if (/(dark|night|black|pro|mocha)/.test(raw)) return 'dark';
  return null;
}

export function resolveTerminalThemeMode(env: NodeJS.ProcessEnv = process.env): CliThemeMode {
  return forcedThemeMode(env)
    ?? modeFromColorFgBg(env.COLORFGBG)
    ?? modeFromNamedEnvironment(env)
    ?? 'dark';
}

export function resolveThemeTokens(env: NodeJS.ProcessEnv = process.env): CliThemeTokens {
  return resolveTerminalThemeMode(env) === 'light' ? AURORA_LIGHT_TOKENS : AURORA_DARK_TOKENS;
}

// Active theme bag imported by tui.ts and the cli/components as `theme`.
// It is the full Claude-code-aligned token set plus the
// `warn` alias that the legacy call sites use, so existing `theme.x` references
// keep working while gaining the new tokens (permission, planMode, autoAccept,
// subtle, diffAdded/diffRemoved/word, userMessageBackground, …).
const RESOLVED_TOKENS = resolveThemeTokens();

export const legacyTheme = {
  ...RESOLVED_TOKENS,
  warn: RESOLVED_TOKENS.warning,
  // Primary text uses the TERMINAL DEFAULT foreground (undefined) so it stays
  // readable on BOTH light and dark terminals.
  // Elements with a fixed dark background set an explicit light fg instead
  // (see the user-message echo in tui.ts).
  text: undefined as string | undefined,
};

const BUILTIN_THEMES: CliTheme[] = [AURORA_DARK_THEME, AURORA_LIGHT_THEME];

export function getBuiltinThemes(): CliTheme[] { return BUILTIN_THEMES; }
export function getDefaultTheme(): CliTheme { return AURORA_DARK_THEME; }

export function resolveTheme(base: CliTheme, overrides: Partial<CliThemeTokens>): CliTheme {
  return { ...base, tokens: { ...base.tokens, ...overrides } };
}
