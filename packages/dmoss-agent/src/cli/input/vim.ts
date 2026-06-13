// ────────────────────────────────────────────────────────────────────────────
// Vim modal editing for the MOSS TUI prompt editor
// Supports Normal / Insert / Visual modes with standard Vim keybindings.
// Enable via DMOSS_VIM_MODE=1 or --vim flag.
// ────────────────────────────────────────────────────────────────────────────

export type VimMode = 'normal' | 'insert' | 'visual';

export interface VimState {
  mode: VimMode;
  /** Pending operator (d=delete, c=change, y=yank) */
  operator: string | null;
  /** Visual selection anchor (character offset from cursor) */
  visualAnchor: number | null;
  /** Accumulated count prefix (e.g. "12" in 12dd) */
  countPrefix: string;
  /** Last search term for n/N */
  lastSearch: string | null;
}

export interface VimAction {
  type: 'move' | 'edit' | 'mode' | 'delete' | 'none';
  /** For move: { direction, distance, unit } */
  move?: { direction: 'left' | 'right' | 'up' | 'down'; distance: number; unit: 'char' | 'word' | 'line' };
  /** For edit: operation to perform */
  edit?: { op: 'delete' | 'change' | 'yank'; count: number; unit: 'char' | 'word' | 'line' };
  /** For mode: target mode */
  targetMode?: VimMode;
  /** Delete range: [startLine, startCol, endLine, endCol] */
  deleteRange?: [number, number, number, number];
}

const DEFAULT_STATE: VimState = {
  mode: 'insert',
  operator: null,
  visualAnchor: null,
  countPrefix: '',
  lastSearch: null,
};

/** Single-instance Vim state for the prompt editor */
const vimState: VimState = { ...DEFAULT_STATE };

export function getVimState(): Readonly<VimState> {
  return vimState;
}

export function setVimMode(mode: VimMode): void {
  vimState.mode = mode;
  if (mode !== 'visual') {
    vimState.visualAnchor = null;
  }
  if (mode === 'insert') {
    vimState.operator = null;
    vimState.countPrefix = '';
  }
}

export function isVimEnabled(): boolean {
  return process.env.DMOSS_VIM_MODE === '1';
}

/**
 * Parse a single keypress in the current Vim mode.
 * Returns an action describing what the editor should do.
 * Returns { type: 'none' } if the key is not a recognized Vim binding.
 */
export function handleVimKey(key: string, cursorPos: number, lineLength: number): VimAction {
  if (!isVimEnabled()) return { type: 'none' };

  const count = parseCount(vimState.countPrefix);

  // ── Global: Escape always goes to normal mode ──
  if (key === 'escape') {
    setVimMode('normal');
    return { type: 'mode', targetMode: 'normal' };
  }

  // ── Digit accumulation for count prefix (in normal mode) ──
  if (vimState.mode === 'normal' && /^[0-9]$/.test(key)) {
    // Allow "0" only if we already have a prefix
    if (key === '0' && vimState.countPrefix === '') return { type: 'none' };
    vimState.countPrefix += key;
    return { type: 'none' };
  }

  // ── Insert mode: most keys pass through ──
  if (vimState.mode === 'insert') {
    return { type: 'none' }; // Let the editor handle normally
  }

  // ── Normal mode ──
  if (vimState.mode === 'normal') {
    return handleNormalKey(key, count, cursorPos, lineLength);
  }

  // ── Visual mode ──
  if (vimState.mode === 'visual') {
    return handleVisualKey(key, cursorPos, lineLength);
  }

  return { type: 'none' };
}

function handleNormalKey(key: string, count: number, cursorPos: number, lineLength: number): VimAction {
  const n = Math.max(count, 1);
  vimState.countPrefix = '';

  // ── Motion keys ──
  switch (key) {
    case 'h': return { type: 'move', move: { direction: 'left', distance: n, unit: 'char' } };
    case 'l': return { type: 'move', move: { direction: 'right', distance: n, unit: 'char' } };
    case 'k': return { type: 'move', move: { direction: 'up', distance: n, unit: 'line' } };
    case 'j': return { type: 'move', move: { direction: 'down', distance: n, unit: 'line' } };
    case '0': return { type: 'move', move: { direction: 'left', distance: cursorPos, unit: 'char' } };
    case '$': return { type: 'move', move: { direction: 'right', distance: lineLength - cursorPos, unit: 'char' } };
    case 'w': return { type: 'move', move: { direction: 'right', distance: n, unit: 'word' } };
    case 'b': return { type: 'move', move: { direction: 'left', distance: n, unit: 'word' } };
    case 'g':
      vimState.countPrefix = 'g';
      return { type: 'none' };
  }

  // ── gg (go to top) ──
  if (key === 'g' && vimState.countPrefix === 'g') {
    vimState.countPrefix = '';
    return { type: 'move', move: { direction: 'up', distance: 9999, unit: 'line' } };
  }
  // ── G (go to bottom) ──
  if (key === 'G') {
    return { type: 'move', move: { direction: 'down', distance: 9999, unit: 'line' } };
  }

  // ── Operators ──
  switch (key) {
    case 'd':
      if (vimState.operator === 'd') {
        // dd: delete current line
        vimState.operator = null;
        return { type: 'edit', edit: { op: 'delete', count: n, unit: 'line' } };
      }
      vimState.operator = 'd';
      return { type: 'none' };
    case 'c':
      if (vimState.operator === 'c') {
        // cc: change current line
        vimState.operator = null;
        setVimMode('insert');
        return { type: 'edit', edit: { op: 'change', count: n, unit: 'line' } };
      }
      vimState.operator = 'c';
      return { type: 'none' };
    case 'y':
      if (vimState.operator === 'y') {
        // yy: yank current line
        vimState.operator = null;
        return { type: 'edit', edit: { op: 'yank', count: n, unit: 'line' } };
      }
      vimState.operator = 'y';
      return { type: 'none' };
  }

  // ── Operator + motion: dw, cw, d$, etc. ──
  if (vimState.operator && ['w', 'b', '$', '0', 'h', 'l', 'j', 'k'].includes(key)) {
    const op = vimState.operator as 'd' | 'c' | 'y';
    vimState.operator = null;

    if (op === 'c') setVimMode('insert');

    const motionMap: Record<string, [number, 'char' | 'word' | 'line']> = {
      w: [n, 'word'], b: [n, 'word'],
      h: [n, 'char'], l: [n, 'char'],
      j: [n, 'line'], k: [n, 'line'],
      '$': [lineLength, 'char'], '0': [cursorPos, 'char'],
    };
    const [dist, unit] = motionMap[key] || [n, 'char'];

    const editOp = op === 'd' ? 'delete' as const : op === 'c' ? 'change' as const : 'yank' as const;
    return { type: 'edit', edit: { op: editOp, count: dist, unit } };
  }

  // ── Mode transitions ──
  switch (key) {
    case 'i':
      setVimMode('insert');
      return { type: 'mode', targetMode: 'insert' };
    case 'a':
      setVimMode('insert');
      return { type: 'move', move: { direction: 'right', distance: 1, unit: 'char' } };
    case 'I':
      setVimMode('insert');
      return { type: 'move', move: { direction: 'left', distance: cursorPos, unit: 'char' } };
    case 'A':
      setVimMode('insert');
      return { type: 'move', move: { direction: 'right', distance: lineLength - cursorPos, unit: 'char' } };
    case 'v':
      setVimMode('visual');
      vimState.visualAnchor = cursorPos;
      return { type: 'mode', targetMode: 'visual' };
    case 'o':
      // Insert new line below and enter insert mode
      setVimMode('insert');
      return { type: 'edit', edit: { op: 'change', count: 0, unit: 'line' } };
    case 'O':
      // Insert new line above and enter insert mode
      setVimMode('insert');
      return { type: 'edit', edit: { op: 'change', count: -1, unit: 'line' } };
    case 'x':
      // Delete character under cursor
      return { type: 'edit', edit: { op: 'delete', count: n, unit: 'char' } };
    case 'p':
      return { type: 'edit', edit: { op: 'yank', count: 0, unit: 'char' } }; // paste
    case 'u':
      return { type: 'edit', edit: { op: 'delete', count: -1, unit: 'char' } }; // undo signal
  }

  return { type: 'none' };
}

function handleVisualKey(key: string, _cursorPos: number, _lineLength: number): VimAction {
  switch (key) {
    case 'y':
      setVimMode('normal');
      return { type: 'edit', edit: { op: 'yank', count: 0, unit: 'char' } };
    case 'd':
    case 'x':
      setVimMode('normal');
      return { type: 'edit', edit: { op: 'delete', count: 0, unit: 'char' } };
    case 'c':
      setVimMode('insert');
      return { type: 'edit', edit: { op: 'change', count: 0, unit: 'char' } };
    // Motion keys work in visual mode too
    case 'h': return { type: 'move', move: { direction: 'left', distance: 1, unit: 'char' } };
    case 'l': return { type: 'move', move: { direction: 'right', distance: 1, unit: 'char' } };
    case 'k': return { type: 'move', move: { direction: 'up', distance: 1, unit: 'line' } };
    case 'j': return { type: 'move', move: { direction: 'down', distance: 1, unit: 'line' } };
    case '$': return { type: 'move', move: { direction: 'right', distance: 9999, unit: 'char' } };
    case '0': return { type: 'move', move: { direction: 'left', distance: 9999, unit: 'char' } };
  }
  return { type: 'none' };
}

function parseCount(prefix: string): number {
  if (!prefix) return 1;
  const n = parseInt(prefix, 10);
  return isNaN(n) ? 1 : Math.max(n, 1);
}

/** Get a human-readable Vim mode indicator for the status bar */
export function getVimModeIndicator(): string {
  switch (vimState.mode) {
    case 'normal': return 'NORMAL';
    case 'insert': return 'INSERT';
    case 'visual': return 'VISUAL';
    default: return 'INSERT';
  }
}

/** Get the color token for the current Vim mode indicator */
export function getVimModeColor(): string {
  switch (vimState.mode) {
    case 'normal': return '#38bdf8';  // blue
    case 'insert': return '#22c55e';  // green
    case 'visual': return '#a78bfa';  // purple
    default: return '#22c55e';
  }
}
