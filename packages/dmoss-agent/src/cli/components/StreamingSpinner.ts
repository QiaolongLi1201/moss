// StreamingSpinner — dynamic spinner during streaming LLM responses
// Dot animation + tool-call pulse indicator.

import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import { legacyTheme as theme } from '../theme/theme.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DOT_FRAMES = ['', '.', '..', '...'];
const PULSE_FRAMES = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '▇', '▆', '▅', '▄', '▃', '▂', '▁'];

export function StreamingSpinner({ active = true, showDots = true }: { active?: boolean; showDots?: boolean }): React.ReactElement {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => setTick((prev) => prev + 1), 120);
    return () => clearInterval(interval);
  }, [active]);

  if (!active) return React.createElement(Text, null, '');

  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
  const dots = showDots ? DOT_FRAMES[tick % DOT_FRAMES.length] : '';

  return React.createElement(Text, null, ` ${spinner}${dots} `);
}

/** Pulsing bar indicator for active tool calls */
export function ToolPulse({ active = true, toolName }: { active?: boolean; toolName?: string }): React.ReactElement {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => setTick((prev) => prev + 1), 100);
    return () => clearInterval(interval);
  }, [active]);

  if (!active) return React.createElement(Text, null, '');

  const pulse = PULSE_FRAMES[tick % PULSE_FRAMES.length];
  const label = toolName ? ` ${toolName}` : '';
  return React.createElement(Text, { color: theme.tool }, `${pulse}${label}`);
}
