# Changelog

All notable changes to `create-dmoss-app` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-05-17

### Changed

- Generated projects now depend on the current Moss package ranges:
  `@rdk-moss/core@^0.3.1` and `@rdk-moss/agent@^0.3.1`.
- Scaffold version ranges are verified by `publish:dmoss:lint` and the consumer
  smoke.

## [0.1.0] - 2026-04-14

### Added

- Initial `minimal` and `openai` project templates for standalone D-Moss agents.
