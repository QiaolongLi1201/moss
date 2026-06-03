// Paste folding — collapses large (>10KB) pastes into placeholder tokens
// Prevents TUI slowdown and accidental large-input submission.

const PASTE_THRESHOLD = 10_000; // chars
const PASTE_PLACEHOLDER = '[📋 Large paste folded — %s chars — Enter to submit, Esc to discard]';

export interface PasteFoldResult {
  folded: boolean;
  text: string;
  originalLength: number;
}

/**
 * If text exceeds PASTE_THRESHOLD, replace with a placeholder.
 * The original text is discarded; caller should warn the user.
 */
export function foldPaste(text: string): PasteFoldResult {
  const trimmed = text.trim();
  if (trimmed.length <= PASTE_THRESHOLD) {
    return { folded: false, text: trimmed, originalLength: trimmed.length };
  }
  const placeholder = PASTE_PLACEHOLDER.replace('%s', String(trimmed.length));
  return { folded: true, text: placeholder, originalLength: trimmed.length };
}

/**
 * Check if the current input looks like a paste (rapid multi-char burst).
 * Ink provides useInput with isActive — this helper can gate the check.
 */
export function isLikelyPaste(chars: string, _timeoutMs = 50): boolean {
  return chars.length > 100 && !chars.includes('\n') && !chars.startsWith('/');
}

/**
 * Extract the first N reasonable lines from a large paste for preview.
 */
export function pastePreview(text: string, maxLines = 3): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text.slice(0, 200);
  return lines.slice(0, maxLines).join('\n').slice(0, 200) + `\n... ${lines.length - maxLines} more lines (${text.length} chars total)`;
}
