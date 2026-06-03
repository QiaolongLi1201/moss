// ────────────────────────────────────────────────────────────────────────────
// TranscriptViewport — auto-scrolling transcript container for Ink TUI.
//
// Limits visible transcript items to fit the terminal and provides
// auto-follow (scrolls to bottom on new messages) + pause-on-scroll-up.
// Ctrl+End resumes auto-scroll.
//
// In Ink, true pixel scrolling isn't available, so we implement this as
// a "windowed" view — show only the last N items, with an indicator when
// scrolled up (viewing history).
// ────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text } from 'ink';

export interface ViewportState {
  /** Whether auto-follow is active (scrolls to bottom on new items) */
  autoFollow: boolean;
  /** Number of items hidden above the visible window */
  scrolledBack: number;
  /** Total items in the transcript */
  totalItems: number;
  /** Max visible items */
  maxVisible: number;
}

export interface TranscriptViewportProps {
  /** Total transcript items */
  totalItems: number;
  /** Max items to render at once (default: terminal height - 10) */
  maxVisible?: number;
  /** Called when viewport state changes */
  onStateChange?: (state: ViewportState) => void;
  /** Children: the visible slice of transcript items */
  children: React.ReactNode;
}

/**
 * Manages auto-scroll state for the transcript viewport.
 * Returns the visible item slice indices and control callbacks.
 */
export function useTranscriptViewport(totalItems: number, maxVisible: number = 40): ViewportState & {
  visibleStart: number;
  visibleEnd: number;
  scrollUp: (count?: number) => void;
  scrollDown: (count?: number) => void;
  resumeAutoFollow: () => void;
  handleKey: (key: string) => boolean; // returns true if key was consumed
} {
  const [autoFollow, setAutoFollow] = useState(true);
  const [scrolledBack, setScrolledBack] = useState(0);
  const prevTotalRef = useRef(totalItems);

  // Auto-follow: when new items arrive while autoFollow is on, stay at bottom
  useEffect(() => {
    if (totalItems > prevTotalRef.current && autoFollow) {
      setScrolledBack(0);
    }
    prevTotalRef.current = totalItems;
  }, [totalItems, autoFollow]);

  const visibleStart = Math.max(0, totalItems - maxVisible - scrolledBack);
  const visibleEnd = totalItems - scrolledBack;

  const scrollUp = useCallback((count: number = 5) => {
    setAutoFollow(false);
    setScrolledBack((prev) => Math.min(prev + count, totalItems - 1));
  }, [totalItems]);

  const scrollDown = useCallback((count: number = 5) => {
    const next = Math.max(0, scrolledBack - count);
    setScrolledBack(next);
    if (next === 0) setAutoFollow(true);
  }, [scrolledBack]);

  const resumeAutoFollow = useCallback(() => {
    setAutoFollow(true);
    setScrolledBack(0);
  }, []);

  const handleKey = useCallback((key: string): boolean => {
    // Ctrl+End or Ctrl+E -> resume auto-follow
    if (key === '\x05') { // Ctrl+E
      resumeAutoFollow();
      return true;
    }
    // PageUp -> scroll up one page
    if (key === '\x1b[5~') {
      scrollUp(maxVisible);
      return true;
    }
    // PageDown -> scroll down one page
    if (key === '\x1b[6~') {
      scrollDown(maxVisible);
      return true;
    }
    return false;
  }, [resumeAutoFollow, scrollUp, scrollDown, maxVisible]);

  return {
    autoFollow,
    scrolledBack,
    totalItems,
    maxVisible,
    visibleStart,
    visibleEnd,
    scrollUp,
    scrollDown,
    resumeAutoFollow,
    handleKey,
  };
}

/**
 * Renders a "scrolled up" indicator bar when viewing history.
 */
export function ScrollIndicator({ scrolledBack, totalItems: _totalItems, onResume: _onResume }: {
  scrolledBack: number;
  totalItems: number;
  onResume: () => void;
}): React.ReactElement | null {
  if (scrolledBack <= 0) return null;

  return React.createElement(
    Box,
    { flexDirection: 'row', marginY: 1 },
    React.createElement(Text, { dimColor: true },
      `▲ ${scrolledBack} messages above · Ctrl+E to resume auto-scroll`),
  );
}

/**
 * Full TranscriptViewport component — wraps children with scroll controls.
 */
export function TranscriptViewport({
  totalItems,
  maxVisible = 40,
  onStateChange,
  children,
}: TranscriptViewportProps): React.ReactElement {
  const vp = useTranscriptViewport(totalItems, maxVisible);

  useEffect(() => {
    onStateChange?.(vp);
  }, [vp.autoFollow, vp.scrolledBack, vp.totalItems]);

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(ScrollIndicator, {
      scrolledBack: vp.scrolledBack,
      totalItems: vp.totalItems,
      onResume: vp.resumeAutoFollow,
    }),
    children,
    vp.autoFollow ? null : React.createElement(
      Box,
      { flexDirection: 'row', marginY: 1 },
      React.createElement(Text, { dimColor: true },
        `▼ auto-scroll paused · Ctrl+E to resume`),
    ),
  );
}
