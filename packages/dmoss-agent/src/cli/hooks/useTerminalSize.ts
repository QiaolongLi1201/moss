// ────────────────────────────────────────────────────────────────────────────
// useTerminalSize — reactive terminal dimensions for the Ink TUI.
//
// Stock `ink@7` does NOT surface {columns, rows} to React, nor re-render on
// terminal resize (SIGWINCH): `useStdout()` only returns a stable stream and
// reading `stdout.columns` during render gives the current value but never
// triggers a re-render when it changes. So we subscribe to the stream's
// 'resize' event ourselves and store the size in state. This makes every
// height/width-driven layout (bottom-anchored frame, command-menu windowing,
// width truncation, small-terminal condensing) actually respond to resize.
// ────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => ({
    columns: stdout?.columns ?? process.stdout.columns ?? 80,
    rows: stdout?.rows ?? process.stdout.rows ?? 24,
  }));

  useEffect(() => {
    if (!stdout || typeof stdout.on !== 'function') return undefined;
    const onResize = (): void => {
      const next = {
        columns: stdout.columns ?? 80,
        rows: stdout.rows ?? 24,
      };
      // Dedupe identical SIGWINCH bursts so we don't re-render needlessly.
      setSize((prev) => (prev.columns === next.columns && prev.rows === next.rows ? prev : next));
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return size;
}
