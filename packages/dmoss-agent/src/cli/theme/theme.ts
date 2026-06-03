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

export const AURORA_DARK_TOKENS: CliThemeTokens = {
  claude: '#f05a1a', text: '#e5e7eb', textSecondary: '#d1d5db',
  textMuted: '#6b7280', textDim: '#4b5563', inverseText: '#0b1220',
  inactive: '#374151', subtle: '#1f2937', suggestion: '#9ca3af',
  user: '#22c55e', tool: '#38bdf8', permission: '#f59e0b',
  success: '#22c55e', error: '#ef4444', warning: '#f59e0b', merged: '#a78bfa',
  promptBorder: '#6b7280', planMode: '#a78bfa', autoAccept: '#22c55e',
  bashBorder: '#38bdf8', ide: '#f59e0b', fastMode: '#22c55e',
  diffAdded: '#166534', diffRemoved: '#991b1b', diffAddedDimmed: '#14532d',
  diffRemovedDimmed: '#7f1d1d', diffAddedWord: '#4ade80', diffRemovedWord: '#f87171',
  userMessageBackground: '#065f46', bashMessageBackgroundColor: '#1e3a5f',
  memoryBackgroundColor: '#1e293b', selectionBg: '#334155',
  rateLimitFill: '#f05a1a', rateLimitEmpty: '#374151',
  briefLabelYou: '#22c55e', briefLabelClaude: '#f05a1a',
  claudeShimmer: '#f05a1a', warningShimmer: '#f59e0b',
  permissionShimmer: '#f59e0b', toolShimmer: '#38bdf8',
  subagent1: '#ef4444', subagent2: '#3b82f6', subagent3: '#22c55e', subagent4: '#eab308',
  subagent5: '#a855f7', subagent6: '#f97316', subagent7: '#ec4899', subagent8: '#06b6d4',
  rainbowRed: '#ef4444', rainbowOrange: '#f97316', rainbowYellow: '#eab308',
  rainbowGreen: '#22c55e', rainbowCyan: '#06b6d4', rainbowBlue: '#3b82f6', rainbowViolet: '#8b5cf6',
  primary: '#c65f2a', primarySoft: '#f59e0b', border: '#9ca3af',
};

export const AURORA_DARK_THEME: CliTheme = {
  name: 'Aurora Dark',
  type: 'dark',
  tokens: AURORA_DARK_TOKENS,
};

// Legacy shape used by tui.ts while the JSON theme engine is being wired in.
export const legacyTheme = {
  primary: '#d97742',
  primarySoft: '#e5a36a',
  user: '#7aa874',
  tool: '#75a7d8',
  warn: '#d59f4a',
  error: '#b91c1c',
  success: '#7aa874',
  text: undefined as string | undefined,
  textMuted: '#8a837a',
  textDim: '#6f6a63',
  border: '#4a4038',
  // extended tokens for new components
  diffAddedDimmed: '#14532d' as string,
  diffRemovedDimmed: '#7f1d1d' as string,
};

const BUILTIN_THEMES: CliTheme[] = [AURORA_DARK_THEME];

export function getBuiltinThemes(): CliTheme[] { return BUILTIN_THEMES; }
export function getDefaultTheme(): CliTheme { return AURORA_DARK_THEME; }

export function resolveTheme(base: CliTheme, overrides: Partial<CliThemeTokens>): CliTheme {
  return { ...base, tokens: { ...base.tokens, ...overrides } };
}
