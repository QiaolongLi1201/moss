// ThemeSelector — interactive theme picker triggered by /theme command
// Shows live preview of available themes with color swatches.

import React from 'react';
import { Box, Text } from 'ink';
import type { CliTheme } from '../theme/theme.js';
import { AURORA_DARK_THEME } from '../theme/theme.js';

interface ThemeSelectorProps {
  themes: CliTheme[];
  currentTheme: CliTheme;
  onSelect: (theme: CliTheme) => void;
}

function themeSwatch(theme: CliTheme): React.ReactElement {
  const t = theme.tokens;
  const swatches = [
    t.accent, t.user, t.tool, t.warning, t.error, t.success,
    t.primary, t.primarySoft,
  ];
  return React.createElement(Text, null,
    ...swatches.map((color, i) =>
      React.createElement(Text, { key: i, color }, '██'),
    ),
    React.createElement(Text, null, `  ${theme.name} ${theme.type === 'dark' ? '🌙' : theme.type === 'light' ? '☀️' : '🎨'}`),
  );
}

export function ThemeSelector({ themes, currentTheme, onSelect: _onSelect }: ThemeSelectorProps): React.ReactElement {
  return React.createElement(Box, { flexDirection: 'column', marginTop: 1, paddingLeft: 2 },
    React.createElement(Text, { bold: true }, 'Themes'),
    React.createElement(Text, { dimColor: true }, 'Use /theme <name> to switch. Current theme is highlighted.'),
    ...themes.map((theme, i) => React.createElement(Box, { key: theme.name, marginTop: i === 0 ? 1 : 0 },
      React.createElement(Text, { bold: theme.name === currentTheme.name },
        theme.name === currentTheme.name ? '▶ ' : '  ',
      ),
      themeSwatch(theme),
    )),
  );
}

/** Quick theme list for /theme command output */
export function renderThemeList(themes?: CliTheme[]): React.ReactElement {
  const list = themes || [AURORA_DARK_THEME];
  return React.createElement(ThemeSelector, {
    themes: list,
    currentTheme: list[0]!,
    onSelect: () => {},
  });
}
