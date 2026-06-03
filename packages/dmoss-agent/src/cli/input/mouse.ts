// SGR mouse sequence parser for terminal mouse support
// Enables click-to-position, drag selection, scroll wheel in TUI.

export interface MouseEvent {
  type: 'click' | 'scroll-up' | 'scroll-down' | 'drag' | 'release';
  x: number;
  y: number;
  button: 'left' | 'middle' | 'right';
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

// Standard SGR mouse protocol: \x1b[<Btn;X;Y[Mm]
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

export function enableMouse(): void {
  // Enable SGR extended mouse mode
  process.stdout.write('\x1b[?1000h');  // basic mouse tracking
  process.stdout.write('\x1b[?1002h');  // button-event tracking (drag)
  process.stdout.write('\x1b[?1006h');  // SGR extended mode
  process.stdout.write('\x1b[?1015h');  // urxvt extended mode
}

export function disableMouse(): void {
  process.stdout.write('\x1b[?1015l');
  process.stdout.write('\x1b[?1006l');
  process.stdout.write('\x1b[?1002l');
  process.stdout.write('\x1b[?1000l');
}

/** Parse an SGR mouse sequence from stdin data. Returns null if not a mouse event. */
export function parseMouseEvent(data: Buffer): MouseEvent | null {
  const str = data.toString();
  const match = str.match(SGR_MOUSE_RE);
  if (!match) return null;

  const btn = parseInt(match[1] || '0', 10);
  const x = parseInt(match[2] || '1', 10);
  const y = parseInt(match[3] || '1', 10);
  const isRelease = match[4] === 'm';

  // Decode button + modifiers (SGR encoding)
  const buttonNum = btn & 3;
  const buttonMap: Record<number, 'left' | 'middle' | 'right'> = { 0: 'left', 1: 'middle', 2: 'right' };
  const button = buttonMap[buttonNum] || 'left';

  // Scroll wheel is encoded as buttons 64/65 in SGR
  if (btn === 64) return { type: 'scroll-up', x, y, button: 'left', shift: false, alt: false, ctrl: false };
  if (btn === 65) return { type: 'scroll-down', x, y, button: 'left', shift: false, alt: false, ctrl: false };

  const shift = !!(btn & 4);
  const alt = !!(btn & 8);
  const ctrl = !!(btn & 16);

  if (isRelease) return { type: 'release', x, y, button, shift, alt, ctrl };
  if (btn & 32) return { type: 'drag', x, y, button, shift, alt, ctrl };

  return { type: 'click', x, y, button, shift, alt, ctrl };
}
