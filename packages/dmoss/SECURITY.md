# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in `@rdk-moss/core`, please report it responsibly:

1. **Do NOT** open a public GitHub issue
2. Email the maintainers at **security@d-robotics.cc** with:
   - A description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
3. You will receive an acknowledgment within **48 hours**
4. A fix will be developed and released as a patch version

## Scope

`@rdk-moss/core` is a pure TypeScript contract library with no runtime dependencies,
no network access, and no file system operations (except prompt string builders).

Security concerns are most likely to arise in:
- **Prompt injection** via crafted `PromptFragment` content
- **Type confusion** if contracts are misused by host implementations

## Responsible Disclosure

We follow a coordinated disclosure process. Please allow up to 90 days for a fix
before publicly disclosing any vulnerability.
