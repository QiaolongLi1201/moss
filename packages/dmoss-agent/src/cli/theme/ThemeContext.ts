import { createContext, useContext } from 'react';
import type { CliTheme } from './theme.js';
import { AURORA_DARK_THEME } from './theme.js';

const ThemeCtx = createContext<CliTheme>(AURORA_DARK_THEME);
export const ThemeProvider = ThemeCtx.Provider;
export function useCliTheme(): CliTheme { return useContext(ThemeCtx); }
