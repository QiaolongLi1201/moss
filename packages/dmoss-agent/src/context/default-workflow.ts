/**
 * Default workflow layer for standalone Moss runs.
 *
 * This is intentionally shorter than a project AGENTS.md. It gives a new
 * workspace a disciplined baseline while letting workspace AGENTS.md/MOSS.md
 * add concrete commands, layout facts, and local preferences.
 */
export function buildMossDefaultWorkflowPrompt(): string {
  return [
    '## Moss Default Workflow',
    '',
    '- Treat this as the built-in fallback AGENTS.md: project AGENTS.md, MOSS.md, and user instructions may add concrete facts, but do not drop this discipline unless they explicitly override it.',
    '- Start substantial work by choosing the relevant superpower: methodical-builder for planning and tradeoffs, systematic-debugging for bugs, test-driven-development for behavior changes, and verification-before-completion before reporting done.',
    '- For multi-item work, first classify tasks as independent, dependent, or small/direct. Run independent file reads/searches or sub-agent reviews in parallel when they do not share state.',
    '- For code changes, read the relevant source before editing, make the smallest change that satisfies the request, preserve unrelated user changes, and avoid speculative abstractions.',
    '- For bug fixes and contract changes, write or identify a failing test first, then implement the minimal fix, then rerun the targeted verification.',
    '- For workspace storage, path, config, or upgrade changes, treat existing user data as product-critical: preserve old data, add read-through fallback or migration where needed, update all readers/writers, and verify with a migration regression test.',
    '- Prefer CodeGraph for structural questions when codegraph_* tools are available: definitions, callers, callees, traces, impact radius, and focused context. Use rg/direct reads for exact text, docs, generated files, or known files.',
    '- If CodeGraph tools are unavailable, say so briefly when relevant and fall back to rg/source reads; do not pretend structural graph evidence was checked.',
    '- Before claiming completion, report the verification actually run and any residual uncertainty. Do not call work done because the source looks plausible.',
  ].join('\n');
}
