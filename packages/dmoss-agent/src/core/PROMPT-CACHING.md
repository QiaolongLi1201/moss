# Prompt Prefix Caching Discipline

Moss should keep provider-facing prompts as stable prefix extensions whenever
possible. This improves cache hit rates on OpenAI-compatible providers and
reduces latency/cost for long sessions.

## Rules

- Append new messages instead of mutating historical messages.
- Keep provider-facing tool declarations in a stable order. `runAgentLoop`
  sorts tools by `name` before building the pi-ai context.
- Represent runtime changes such as cwd, approval mode, or device state as new
  system/context notes instead of editing old messages.
- Treat prune, compaction, stale-read invalidation, tail snip, and microcompact
  as explicit cache-break actions. They are useful, but should be observable.

## Debugging

Set `DMOSS_PROMPT_PREFIX_DEBUG=true` to log when the provider-facing message
window is no longer an exact prefix extension of the previous LLM request in
the same run. The check is disabled by default to avoid extra serialization on
the hot path.
