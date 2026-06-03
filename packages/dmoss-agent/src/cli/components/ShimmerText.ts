// ShimmerText — ANSI 256-color shimmer loading animation (10fps)
// Inspired by Claude Code's shimmer effect for in-progress content.

import React, { useState, useEffect } from 'react';
import { Text } from 'ink';

const SHIMMER_FRAMES = [
  '\u001B[38;5;240m', '\u001B[38;5;241m', '\u001B[38;5;242m', '\u001B[38;5;243m',
  '\u001B[38;5;244m', '\u001B[38;5;245m', '\u001B[38;5;246m', '\u001B[38;5;247m',
  '\u001B[38;5;248m', '\u001B[38;5;249m', '\u001B[38;5;248m', '\u001B[38;5;247m',
  '\u001B[38;5;246m', '\u001B[38;5;245m', '\u001B[38;5;244m', '\u001B[38;5;243m',
  '\u001B[38;5;242m', '\u001B[38;5;241m',
];

export function ShimmerText({ text, active = true }: { text: string; active?: boolean }): React.ReactElement {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % SHIMMER_FRAMES.length);
    }, 100);
    return () => clearInterval(interval);
  }, [active]);

  if (!active) return React.createElement(Text, { dimColor: true }, text);

  return React.createElement(Text, null,
    `${SHIMMER_FRAMES[frame]}${text}\u001B[39m`,
  );
}
