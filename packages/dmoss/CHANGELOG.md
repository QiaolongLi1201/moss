# Changelog

All notable changes to `@dmoss/core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-05-17

### Added

- Published package surface now includes the canonical `DeviceFamily` taxonomy at
  `@dmoss/core/contracts/device-family`.
- Release metadata and package boundaries are aligned for the Moss npm publish
  gate (`publish:dmoss:verify`).

### Compatibility

- Backward compatible for consumers: new exports are additive and `@dmoss/core`
  remains a zero-runtime-dependency contract package.

## [0.1.0] - 2026-04-14

### Added

- **KnowledgeModule** — pluggable domain knowledge contract for any hardware platform
  - `DeviceProfileBase` — hardware capability data
  - `DocIndexEntry` — documentation search index
  - `PromptFragment` — system prompt injection
  - `CommandPattern` — command semantics and risk classification
  - `FailureHint` — error pattern matching with recovery suggestions
- **DmossPlatformExtension** — primary integration point for new device ecosystems
- **DmossVendorPlugin** — prompt and tool contribution from vendor plugins
- **Robotics engineering prompts** — vendor-neutral, applicable to any robotics platform
