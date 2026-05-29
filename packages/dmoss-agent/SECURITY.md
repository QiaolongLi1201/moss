# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security issue in `@rdk-moss/agent`, please report it responsibly:

1. **Do not** open a public issue first
2. Email **security@d-robotics.cc** with:
   - a clear description of the issue
   - reproduction steps or proof of concept
   - affected versions
   - expected impact
3. We aim to acknowledge reports within **48 hours**
4. A fix or mitigation plan will be coordinated before public disclosure

## Security Scope

`@rdk-moss/agent` is a runtime package, so its security scope is broader than `@rdk-moss/core`.

Areas of particular concern include:

- **tool execution safety**: dangerous command approval, tool misuse, privilege escalation
- **filesystem safety**: sandbox paths, protected paths, path traversal
- **secret handling**: API keys or credentials leaking into prompts, logs, or tool results
- **prompt injection**: hostile prompt fragments, tool outputs, or fetched content influencing behavior
- **session isolation**: unintended cross-session data leakage
- **provider handling**: retries, stream parsing, and malformed provider responses

## Dependency hygiene (monorepo)

The `@rdk-moss/agent` package itself has a small dependency footprint (`@rdk-moss/core`, `@mariozechner/pi-ai`, `picocolors`). **`pi-ai` backs the optional `PiAiLLMProvider` adapter**; hosts can still integrate with **only** a custom `LLMProvider` and never call pi-ai APIs (see `README.md` / `API.md`). When this package is embedded in a larger host monorepo, run `npm audit` periodically and apply `npm audit fix` where semver allows. Treat production `dependencies` of `@rdk-moss/agent` as the highest priority when triaging. Overrides in the root `package.json` may pin transitive fixes when upstream packages lag.

### Triaging a large `npm audit` report

It is normal for large host trees to report many findings (Electron, desktop packagers, vendor-specific SDKs). For **OSS consumers of `@rdk-moss/agent` alone**, the relevant question is: *does the published package tarball pull in the vulnerable package at install time?* Use:

```bash
npm pack --workspace=@rdk-moss/agent --dry-run
```

and inspect dependency paths if needed. Prefer fixes that upgrade **runtime** deps of `@rdk-moss/agent`; document accepted risk for unrelated monorepo-only chains in release notes when publishing.

## Out of Scope

The following are generally out of scope for this package unless the bug is caused by a package-level abstraction:

- host-application frontend vulnerabilities
- host-application HTTP routes
- desktop packaging or sandbox issues of an embedding host
- third-party LLM provider outages or credential compromises outside the package
- device-side command risk introduced by a host tool that is not part of `@rdk-moss/agent`

## Hardening Expectations

When contributing security-sensitive changes, please verify:

1. dangerous operations still flow through approval boundaries
2. path-based helpers reject traversal and respect protected roots
3. secrets are not echoed into user-visible or persisted outputs
4. new hooks or events do not leak sensitive internal state by default
5. behavior remains documented in `README.md`, `API.md`, or `CHANGELOG.md` where appropriate

## Responsible Disclosure

Please allow a reasonable remediation window before public disclosure. When possible, include a minimal patch suggestion or failing test to help speed up triage.
