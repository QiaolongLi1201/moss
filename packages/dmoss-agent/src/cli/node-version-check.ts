/**
 * Friendly Node version gate for the CLI entry.
 *
 * npm only WARNS on engines mismatch (EBADENGINE) and installs anyway, so
 * users on Node 18/20 reached runtime and crashed with unrelated-looking
 * syntax/API errors. Fail fast with one actionable line instead.
 *
 * Keep in sync with `engines.node` in package.json (>=22.16.0).
 */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 16;

/** Returns an error message when `version` (e.g. "v20.11.1") is too old, else null. */
export function nodeVersionProblem(version: string): string | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null; // unparseable — do not block
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > MIN_NODE_MAJOR) return null;
  if (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR) return null;
  return [
    `Moss needs Node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}, but this is Node ${version.replace(/^v/, '')}.`,
    'Upgrade Node (https://nodejs.org or `nvm install 22`), then run moss again.',
    '(This is also why `npm install` printed EBADENGINE warnings.)',
  ].join('\n');
}

/** Exits the process with a clear message when the running Node is too old. */
export function enforceNodeVersion(): void {
  const problem = nodeVersionProblem(process.version);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}
