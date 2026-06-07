// ────────────────────────────────────────────────────────────────────────────
// CLI brand mark — the D-Moss logo, rendered for a terminal.
//
// The product app icon is an orange "cloud" carrying a white `>_` terminal
// prompt with a teal cursor square. In a TUI we distill that to a tiny two-part
// mark: an orange prompt (`❯_`) followed by a cyan cursor block (`▪`). It is
// meant to sit next to the product name as a compact terminal identity mark.
// Colors are applied by the caller so each part keeps its hue.
// ────────────────────────────────────────────────────────────────────────────

/** Logo orange (cloud / prompt). Matches theme token `accent`. */
export const BRAND_ORANGE = '#f05a1a';
/** Logo cyan (cursor square). Matches theme token `rainbowCyan`. */
export const BRAND_CYAN = '#06b6d4';

export interface BrandMark {
  /** Prompt chevron — render with {@link BRAND_ORANGE}. */
  prompt: string;
  /** Cursor block — render with {@link BRAND_CYAN}. */
  cursor: string;
}

/**
 * The inline brand mark shown before the product name: an orange prompt chevron
 * followed by a cyan cursor square (`❯▪`), echoing the app icon's
 * `>_` prompt and teal cursor. Sits next to "D-Moss Code" the way agent UI
 * `✻` sits next to its name. Pass `{ ascii: true }` for terminals without these
 * glyphs (e.g. `DMOSS_TUI_NO_EMOJI`).
 *
 * Unicode: `❯` + `▪`
 * ASCII:   `>` + `#`
 */
export function brandMark(opts?: { ascii?: boolean }): BrandMark {
  if (opts?.ascii) return { prompt: '>', cursor: '#' };
  return { prompt: '❯', cursor: '▪' };
}
