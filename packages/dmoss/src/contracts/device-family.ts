/**
 * Canonical DeviceFamily taxonomy for @dmoss/core.
 *
 * Consumers (host codebases, third-party extensions) MUST import this
 * type from `@dmoss/core/contracts/device-family` to ensure type unity.
 *
 * Helper functions like `deriveDeviceFamily()` or `familyPingFailTtlMs()`
 * live in the host codebase (e.g. `shared/device-family.ts`) since they
 * encode host-specific judgement (TTL values for ping-fail caches,
 * UI labels, ceremony predicates). The contract here is intentionally
 * minimal: just the taxonomy.
 *
 * Semver policy:
 *   - Adding a new family member is a MINOR change.
 *   - Removing or renaming a member is a MAJOR change.
 */
export type DeviceFamily =
  | 'rdk'
  | 'linux-generic'
  | 'jetson'
  | 'rpi'
  | 'rockchip'
  | 'unknown';
