// DiffView — unified diff renderer with added/removed line + word-level highlights
// Inspired by Claude Code's code diff display with semantic coloring.

import React from 'react';
import { Box, Text } from 'ink';
import { legacyTheme as theme } from '../theme/theme.js';

export type DiffLineType = 'added' | 'removed' | 'context' | 'header';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffViewProps {
  lines: DiffLine[];
  maxLines?: number;
}

function linePrefix(line: DiffLine): string {
  const oldNum = line.oldLine !== undefined ? String(line.oldLine).padStart(4) : '    ';
  const newNum = line.newLine !== undefined ? String(line.newLine).padStart(4) : '    ';
  const numStr = `${oldNum} ${newNum}`;
  switch (line.type) {
    case 'added': return `\u001B[38;2;74;222;128m${numStr} +\u001B[39m `;
    case 'removed': return `\u001B[38;2;248;113;113m${numStr} -\u001B[39m `;
    case 'header': return `\u001B[1m${numStr}  \u001B[22m `;
    default: return `\u001B[38;2;156;163;175m${numStr}  \u001B[39m `;
  }
}

function renderLine(line: DiffLine, index: number): React.ReactElement {
  const prefix = linePrefix(line);
  let color: string | undefined;
  let bg: string | undefined;
  switch (line.type) {
    case 'added': color = theme.text; bg = theme.diffAddedDimmed; break;
    case 'removed': color = theme.text; bg = theme.diffRemovedDimmed; break;
    case 'header': color = undefined; break;
    default: color = theme.textMuted; break;
  }

  return React.createElement(Text, { key: index, color, backgroundColor: bg },
    prefix,
    line.text,
  );
}

export function DiffView({ lines, maxLines = 50 }: DiffViewProps): React.ReactElement {
  const display = lines.length > maxLines
    ? [...lines.slice(0, maxLines - 1), { type: 'context' as const, text: `... ${lines.length - maxLines + 1} more lines ...` }]
    : lines;

  return React.createElement(Box, { flexDirection: 'column', marginTop: 1, marginBottom: 1 },
    ...display.map((line, i) => renderLine(line, i)),
  );
}

/** Quick parse a unified diff string into DiffLine[] */
export function parseUnifiedDiff(diffText: string): DiffLine[] {
  const raw = diffText.split('\n');
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of raw) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        oldLine = parseInt(match[1] || '1', 10);
        newLine = parseInt(match[3] || '1', 10);
      }
      result.push({ type: 'header', text: line });
    } else if (line.startsWith('+')) {
      result.push({ type: 'added', text: line.slice(1), newLine: newLine++ });
    } else if (line.startsWith('-')) {
      result.push({ type: 'removed', text: line.slice(1), oldLine: oldLine++ });
    } else {
      result.push({ type: 'context', text: line.startsWith(' ') ? line.slice(1) : line, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return result;
}
