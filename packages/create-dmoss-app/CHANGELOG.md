# Changelog

All notable changes to `create-dmoss-app` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-06-08

### Fixed

- Updated the fallback generated Moss dependency range to `^0.3.16`.
- Added release and hygiene checks so scaffold dependency ranges stay aligned
  with the published Moss workspace version.

## [0.1.2] - 2026-06-08

### Fixed

- Generated project dependencies now follow the installed `@rdk-moss/core` and
  `@rdk-moss/agent` versions when available, falling back to the current
  `^0.3.15` range. This keeps consumer smoke tests and local scaffolds from
  drifting behind newly published Moss packages.

## [0.1.1] - 2026-05-17

### Changed

- Generated projects now depend on the current Moss package ranges:
  `@rdk-moss/core@^0.3.2` and `@rdk-moss/agent@^0.3.6`.
- Scaffold version ranges are verified by `publish:dmoss:lint` and the consumer
  smoke.

## [0.1.0] - 2026-04-14

### Added

- Initial `minimal` and `openai` project templates for standalone D-Moss agents.
