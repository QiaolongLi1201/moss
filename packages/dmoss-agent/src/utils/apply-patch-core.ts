/**
 * Apply Patch core logic (filesystem-agnostic, aligned with Codex apply_patch).
 *
 * Splits Codex-compatible patch text into typed hunks and applies updates.
 * Concrete I/O (workspace vs device, etc.) is provided by the caller.
 *
 * Format reference (compatible with OpenAI apply_patch grammar):
 *
 *   *** Begin Patch
 *   *** Update File: path/to/file.ts
 *   @@
 *     context line
 *   - removed line
 *   + added line
 *   *** Add File: path/to/new-file.ts
 *   +line 1
 *   +line 2
 *   *** Delete File: path/to/old-file.ts
 *   *** End Patch
 */

export interface PatchHunk {
  type: 'add' | 'update' | 'delete';
  path: string;
  lines: PatchLine[];
}

export interface PatchLine {
  op: '+' | '-' | ' ' | 'context_marker';
  text: string;
}

export interface ParsedPatch {
  hunks: PatchHunk[];
  errors: string[];
}

export function parsePatch(raw: string): ParsedPatch {
  const lines = raw.split('\n');
  const hunks: PatchHunk[] = [];
  const errors: string[] = [];
  let currentHunk: PatchHunk | null = null;
  let inPatch = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('*** Begin Patch')) {
      inPatch = true;
      continue;
    }
    if (line.startsWith('*** End Patch')) {
      if (currentHunk) {
        hunks.push(currentHunk);
        currentHunk = null;
      }
      inPatch = false;
      continue;
    }
    if (!inPatch) continue;

    if (line.startsWith('*** Add File: ')) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = {
        type: 'add',
        path: line.slice('*** Add File: '.length).trim(),
        lines: [],
      };
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = {
        type: 'update',
        path: line.slice('*** Update File: '.length).trim(),
        lines: [],
      };
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = {
        type: 'delete',
        path: line.slice('*** Delete File: '.length).trim(),
        lines: [],
      };
      hunks.push(currentHunk);
      currentHunk = null;
      continue;
    }
    if (line === '*** End of File') continue;

    if (!currentHunk) continue;

    if (line.startsWith('@@')) {
      currentHunk.lines.push({ op: 'context_marker', text: line.slice(2).trimStart() });
      continue;
    }
    if (line.startsWith('+')) {
      currentHunk.lines.push({ op: '+', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({ op: '-', text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      currentHunk.lines.push({ op: ' ', text: line.slice(1) });
    }
  }

  if (currentHunk) hunks.push(currentHunk);
  if (hunks.length === 0 && raw.trim().length > 0) {
    errors.push('未识别到有效的 patch 块。请使用 *** Begin Patch / *** End Patch 格式。');
  }
  return { hunks, errors };
}

export function applyUpdateHunk(
  original: string,
  hunk: PatchHunk,
): { result: string; error?: string } {
  const origLines = original.split('\n');
  const patchLines = hunk.lines;

  if (patchLines.length === 0) return { result: original };

  const contextGroups: { contextLines: string[]; removes: string[]; adds: string[] }[] = [];
  let currentGroup: { contextLines: string[]; removes: string[]; adds: string[] } = {
    contextLines: [],
    removes: [],
    adds: [],
  };

  for (const pl of patchLines) {
    if (pl.op === 'context_marker') {
      if (
        currentGroup.contextLines.length > 0 ||
        currentGroup.removes.length > 0 ||
        currentGroup.adds.length > 0
      ) {
        contextGroups.push(currentGroup);
        currentGroup = { contextLines: [], removes: [], adds: [] };
      }
      if (pl.text.trim()) currentGroup.contextLines.push(pl.text);
      continue;
    }
    if (pl.op === ' ') {
      if (currentGroup.removes.length > 0 || currentGroup.adds.length > 0) {
        contextGroups.push(currentGroup);
        currentGroup = { contextLines: [], removes: [], adds: [] };
      }
      currentGroup.contextLines.push(pl.text);
    } else if (pl.op === '-') {
      currentGroup.removes.push(pl.text);
    } else if (pl.op === '+') {
      currentGroup.adds.push(pl.text);
    }
  }
  if (
    currentGroup.contextLines.length > 0 ||
    currentGroup.removes.length > 0 ||
    currentGroup.adds.length > 0
  ) {
    contextGroups.push(currentGroup);
  }

  let result = [...origLines];
  let offset = 0;

  for (const group of contextGroups) {
    if (group.removes.length === 0 && group.adds.length === 0) continue;

    const anchor = findContextAnchor(result, group.contextLines, group.removes, offset);
    if (anchor.error) {
      return {
        result: original,
        error: anchor.error,
      };
    }
    if (anchor.index < 0) {
      return {
        result: original,
        error: `无法在文件中定位上下文行（从偏移 ${offset} 开始）：${JSON.stringify(group.contextLines.slice(0, 3))}`,
      };
    }

    const insertAt = anchor.index + group.contextLines.length;
    const removeCount = group.removes.length;

    if (removeCount > 0) {
      for (let r = 0; r < removeCount; r++) {
        const actualIdx = insertAt + r;
        if (actualIdx >= result.length) break;
        const expected = group.removes[r].trimEnd();
        const actual = result[actualIdx].trimEnd();
        const matches = anchor.ignoreLeadingWhitespace
          ? expected.trimStart() === actual.trimStart()
          : expected === actual;
        if (!matches) {
          return {
            result: original,
            error: `删除行不匹配 (行 ${actualIdx + 1})：期望 "${expected}"，实际 "${actual}"`,
          };
        }
      }
    }

    const adds = normalizeAddsForAnchor(group.adds, anchor);
    result.splice(insertAt, removeCount, ...adds);
    offset = insertAt + adds.length;
  }

  return { result: result.join('\n') };
}

export function extractAddContent(hunk: PatchHunk): string {
  return hunk.lines
    .filter((l) => l.op === '+')
    .map((l) => l.text)
    .join('\n');
}

function findContextAnchor(
  lines: string[],
  contextLines: string[],
  removeLines: string[],
  startFrom: number,
): { index: number; ignoreLeadingWhitespace: boolean; indentPrefix: string; error?: string } {
  if (contextLines.length === 0 && removeLines.length > 0) {
    const firstRemove = removeLines[0].trimEnd();
    const exactMatches: number[] = [];
    for (let i = startFrom; i < lines.length; i++) {
      if (lines[i].trimEnd() === firstRemove) exactMatches.push(i);
    }
    const exact = uniqueAnchor(exactMatches, false, '');
    if (exact.index >= 0 || exact.error) return exact;

    const looseMatches: { index: number; indentPrefix: string }[] = [];
    const firstRemoveTrimmed = firstRemove.trimStart();
    for (let i = startFrom; i < lines.length; i++) {
      const actual = lines[i].trimEnd();
      if (actual.trim().length > 0 && actual.trimStart() === firstRemoveTrimmed) {
        looseMatches.push({ index: i, indentPrefix: leadingWhitespace(lines[i]) });
      }
    }
    return uniqueAnchor(looseMatches, true, '');
  }

  if (contextLines.length === 0) return { index: startFrom, ignoreLeadingWhitespace: false, indentPrefix: '' };

  const exactMatches: number[] = [];
  for (let i = startFrom; i <= lines.length - contextLines.length; i++) {
    let match = true;
    for (let j = 0; j < contextLines.length; j++) {
      if (lines[i + j].trimEnd() !== contextLines[j].trimEnd()) {
        match = false;
        break;
      }
    }
    if (match && removesMatchAt(lines, i + contextLines.length, removeLines, false)) {
      exactMatches.push(i);
    }
  }
  const exact = uniqueAnchor(exactMatches, false, '');
  if (exact.index >= 0 || exact.error) return exact;

  const looseMatches: { index: number; indentPrefix: string }[] = [];
  for (let i = startFrom; i <= lines.length - contextLines.length; i++) {
    let match = true;
    let indentPrefix = '';
    for (let j = 0; j < contextLines.length; j++) {
      const actual = lines[i + j].trimEnd();
      const expected = contextLines[j].trimEnd();
      if (actual.trim().length === 0 || actual.trimStart() !== expected.trimStart()) {
        match = false;
        break;
      }
      if (!indentPrefix) indentPrefix = leadingWhitespace(lines[i + j]);
    }
    if (match && removesMatchAt(lines, i + contextLines.length, removeLines, true)) {
      looseMatches.push({ index: i, indentPrefix });
    }
  }
  return uniqueAnchor(looseMatches, true, '');
}

function removesMatchAt(
  lines: string[],
  startAt: number,
  removeLines: string[],
  ignoreLeadingWhitespace: boolean,
): boolean {
  for (let r = 0; r < removeLines.length; r++) {
    const actual = lines[startAt + r];
    if (actual === undefined) return false;
    const expected = removeLines[r].trimEnd();
    const actualTrimmed = actual.trimEnd();
    if (ignoreLeadingWhitespace) {
      if (expected.trimStart() !== actualTrimmed.trimStart()) return false;
    } else if (expected !== actualTrimmed) {
      return false;
    }
  }
  return true;
}

function uniqueAnchor(
  matches: Array<number | { index: number; indentPrefix: string }>,
  ignoreLeadingWhitespace: boolean,
  defaultIndentPrefix: string,
): { index: number; ignoreLeadingWhitespace: boolean; indentPrefix: string; error?: string } {
  if (matches.length === 0) {
    return { index: -1, ignoreLeadingWhitespace: false, indentPrefix: '' };
  }
  if (matches.length > 1) {
    return {
      index: -1,
      ignoreLeadingWhitespace,
      indentPrefix: '',
      error: `上下文匹配到 ${matches.length} 处，无法唯一定位；请提供更多上下文行。`,
    };
  }
  const match = matches[0];
  if (typeof match === 'number') {
    return { index: match, ignoreLeadingWhitespace, indentPrefix: defaultIndentPrefix };
  }
  return { index: match.index, ignoreLeadingWhitespace, indentPrefix: match.indentPrefix };
}

function normalizeAddsForAnchor(
  adds: string[],
  anchor: { ignoreLeadingWhitespace: boolean; indentPrefix: string },
): string[] {
  if (!anchor.ignoreLeadingWhitespace || !anchor.indentPrefix) return adds;
  const nonBlankAdds = adds.filter((line) => line.trim().length > 0);
  if (nonBlankAdds.length === 0 || nonBlankAdds.some((line) => leadingWhitespace(line).length > 0)) {
    return adds;
  }
  return adds.map((line) => (line.trim().length > 0 ? `${anchor.indentPrefix}${line}` : line));
}

function leadingWhitespace(line: string): string {
  return line.match(/^[\t ]*/)?.[0] ?? '';
}
