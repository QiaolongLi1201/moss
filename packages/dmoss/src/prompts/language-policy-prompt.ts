/**
 * Response-language policy — domain-independent.
 *
 * D-Moss is English-first: the model answers in English by default and only
 * switches when the user's own most recent message is written in another
 * language (auto-detected by the model itself — no per-turn wiring, so the
 * directive stays in the cached stable layer). Kept separate from the domain
 * persona and the agent-behavior contract so a host can drop it independently.
 */

/**
 * Full response-language directive. Hosts inject this into the system-prompt
 * stable layer (the agent does so by default; see `includeLanguagePolicyPrompt`).
 * @public
 */
export function buildLanguagePolicyPrompt(): string {
  return [
    '## Response Language',
    '- **Default to English.** Write each response in the language of the user\'s most recent message: if they write in Chinese, reply in Chinese; if in English, reply in English; likewise for any other language.',
    '- When the latest message carries no clear language signal — it is only code, a file path, a URL, a number, a single command or symbol, or is otherwise ambiguous — respond in **English**.',
    '- Let only the user\'s own prose decide the language. Do **not** switch based on quoted text, log lines, file contents, or tool results, even when those are in another language.',
    '- Keep code, identifiers, file paths, shell commands, API and tool names, and tool-call arguments verbatim regardless of the response language; never translate or transliterate them.',
    '- If the user explicitly asks for a specific output language, follow that and keep using it until they ask otherwise.',
  ].join('\n');
}

/**
 * Compact variant for context-limited scenarios, paired with the `*Quick`
 * persona/behavior prompts.
 * @public
 */
export function buildLanguagePolicyPromptQuick(): string {
  return [
    '## Response Language (brief)',
    'Default to English; otherwise match the language of the user\'s latest message (Chinese in → Chinese out). Ambiguous or code-only → English. Decide from the user\'s own prose only, never from quoted text or tool output. Never translate code, identifiers, paths, commands, or tool arguments. Honor an explicit language request until the user changes it.',
  ].join('\n');
}
