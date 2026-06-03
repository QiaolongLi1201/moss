// Configurable keybindings system — loaded from ~/.dmoss/keybindings.json
// Supports 6 context-aware binding scopes.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type BindingContext = 'global' | 'editor' | 'approval' | 'transcript' | 'queue' | 'menu';

export interface KeyBinding {
  key: string;       // e.g. "ctrl+o", "escape", "tab"
  action: string;    // e.g. "tools.toggle", "editor.submit"
  context?: BindingContext;
}

export interface KeyBindingSet {
  bindings: KeyBinding[];
}

const DEFAULT_BINDINGS: KeyBinding[] = [
  { key: 'ctrl+o', action: 'tools.toggle', context: 'global' },
  { key: 'ctrl+c', action: 'app.exit', context: 'global' },
  { key: 'escape', action: 'approval.deny', context: 'approval' },
  { key: 'y', action: 'approval.allow-once', context: 'approval' },
  { key: 'a', action: 'approval.allow-always', context: 'approval' },
  { key: 'n', action: 'approval.deny', context: 'approval' },
  { key: 'enter', action: 'editor.submit', context: 'editor' },
  { key: 'shift+enter', action: 'editor.newline', context: 'editor' },
  { key: 'up', action: 'editor.history-prev', context: 'editor' },
  { key: 'down', action: 'editor.history-next', context: 'editor' },
  { key: 'tab', action: 'editor.complete', context: 'editor' },
  { key: 'ctrl+a', action: 'editor.home', context: 'editor' },
  { key: 'ctrl+e', action: 'editor.end', context: 'editor' },
  { key: 'ctrl+u', action: 'editor.kill-before', context: 'editor' },
  { key: 'ctrl+k', action: 'editor.kill-after', context: 'editor' },
  { key: 'ctrl+w', action: 'editor.delete-prev-word', context: 'editor' },
];

function configPath(): string {
  return path.join(os.homedir(), '.dmoss', 'keybindings.json');
}

export function loadKeyBindings(): KeyBinding[] {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    const parsed: KeyBindingSet = JSON.parse(raw);
    if (Array.isArray(parsed.bindings)) {
      // Merge user bindings over defaults (user wins)
      const userKeys = new Set(parsed.bindings.map((b) => `${b.context || 'global'}:${b.key}`));
      const merged = [...parsed.bindings, ...DEFAULT_BINDINGS.filter((b) => !userKeys.has(`${b.context || 'global'}:${b.key}`))];
      return merged;
    }
  } catch { /* file doesn't exist or invalid JSON — use defaults */ }
  return DEFAULT_BINDINGS;
}

export function getBindingsForContext(context: BindingContext): KeyBinding[] {
  const all = loadKeyBindings();
  return all.filter((b) => (b.context || 'global') === context || b.context === 'global');
}

export function findBinding(key: string, context: BindingContext): KeyBinding | undefined {
  return getBindingsForContext(context).find((b) => b.key === key);
}

// Normalize key descriptions for display
export function describeBinding(binding: KeyBinding): string {
  const keyDisplay = binding.key.replace(/ctrl\+/gi, 'Ctrl+').replace(/shift\+/gi, 'Shift+');
  return `${keyDisplay} → ${binding.action}`;
}
