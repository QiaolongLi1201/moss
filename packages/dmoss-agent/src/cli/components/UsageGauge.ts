// UsageGauge — context window usage meter in the status bar
// Progressive color: green → amber → orange → red as usage increases.

import React from 'react';
import { Text } from 'ink';

const BAR_WIDTH = 10;
const BAR_CHARS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];

function usageColor(ratio: number): [number, number, number] {
  if (ratio < 0.5) return [34, 197, 94];    // green
  if (ratio < 0.75) return [234, 179, 8];   // amber
  if (ratio < 0.9) return [249, 115, 22];   // orange
  return [239, 68, 68];                       // red
}

export function UsageGauge({ used, total, label }: { used: number; total: number; label?: string }): React.ReactElement {
  if (total <= 0) return React.createElement(Text, null, '');
  const ratio = Math.min(1, Math.max(0, used / total));
  const [r, g, b] = usageColor(ratio);
  const filledWidth = ratio * BAR_WIDTH;
  const fullBlocks = Math.floor(filledWidth);
  const partialIndex = Math.floor((filledWidth - fullBlocks) * BAR_CHARS.length);
  let bar = BAR_CHARS[7]!.repeat(fullBlocks);
  if (partialIndex > 0 && fullBlocks < BAR_WIDTH) {
    bar += BAR_CHARS[partialIndex - 1] || '';
  }
  const emptyBg = '\u001B[48;2;55;65;81m';
  const filledBg = `\u001B[48;2;${r};${g};${b}m`;
  const reset = '\u001B[49m';
  const paddedBar = bar.padEnd(BAR_WIDTH, ' ');
  const filledPct = Math.round(ratio * 100);
  const displayLabel = label || `${filledPct}%`;
  return React.createElement(Text, null,
    ` ${filledBg}${paddedBar.slice(0, fullBlocks)}${reset}${emptyBg}${paddedBar.slice(fullBlocks)}${reset} ${displayLabel}`,
  );
}
