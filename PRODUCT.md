# Product

## Register

product

## Users

Moss serves developers building, debugging, and embedding robotics-aware AI agents. Core users work in terminals, code repositories, robot labs, edge-device benches, and product host codebases. They need the tool to be fast to start, clear about what it can access, honest about evidence, and predictable when it touches code, devices, credentials, or long-running tasks.

## Product Purpose

Moss is an open terminal agent and embeddable runtime for robotics and edge-device workflows. It should let users start a useful agent session without forced model setup, connect RDK boards when needed, bring their own provider when required, and reuse the same host-neutral runtime in other products. Success means a user can understand the current model, workspace, device state, available tools, approval policy, and next action without reading implementation details.

## Brand Personality

Calm, technical, and accountable. Moss should feel like a precise terminal instrument rather than a chatbot skin: compact, readable, evidence-oriented, and clear about boundaries. Its voice should be direct and operational, with short labels and useful recovery guidance instead of marketing claims.

## Anti-references

Do not make Moss look like a decorative dashboard, a marketing landing page, or a novelty terminal theme. Avoid heavy gradients, bloated welcome panels, vague success messages, hidden state, unexplained autonomous behavior, walls of command text, and styling that reduces readability on light or dark terminal backgrounds.

## Design Principles

1. Put the operator's state first: model, workspace, approval mode, device mode, goal state, and pending action must be easy to scan.
2. Make first-run paths self-explanatory: built-in gateway, optional login, own-model setup, and board connection should each have one obvious next step.
3. Prefer verified outcomes over optimistic messages: success text must come from an actual probe, exit code, persisted state, or post-condition check.
4. Keep the TUI restrained and dense: use color for state and action, not decoration.
5. Preserve host neutrality: product-specific policy, credentials, storage, deployment, and UI choices belong in hosts or adapters, not hidden inside the core runtime.

## Accessibility & Inclusion

Terminal output must remain readable in dark and light themes, with enough contrast for muted chrome, errors, warnings, and selection states. Do not rely on color alone for critical status; pair color with words or symbols. Keep ASCII fallbacks for brand marks and avoid motion or shimmer as the only signal for progress.
