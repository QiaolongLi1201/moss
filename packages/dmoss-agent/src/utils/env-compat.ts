/**
 * Environment variable utilities — preference-based env reading with legacy fallback.
 */

export function readEnv(name: string): string | undefined {
  const env =
    typeof process !== 'undefined' && typeof process.env === 'object'
      ? process.env
      : undefined;
  const value = env?.[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export function readEnvFlag(name: string): boolean {
  const value = readEnv(name);
  return value === '1' || value === 'true';
}

export function parseEnvPositiveInt(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function parseEnvBoundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Parse a float env var, clamped to [min, max]. Returns fallback if unset or non-finite.
 * Use for ratios / fractional knobs (e.g. buffer ratios, chars-per-token estimates).
 */
export function parseEnvBoundedFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function envPreferDmoss(dmossKey: string, legacyKey: string): string | undefined {
  const v = readEnv(dmossKey);
  if (v !== undefined && v !== '') return v;
  const legacy = readEnv(legacyKey);
  if (legacy !== undefined && legacy !== '') return legacy;
  return undefined;
}

export function parseEnvNumberPreferDmoss(dmossKey: string, legacyKey: string): number | undefined {
  const raw = envPreferDmoss(dmossKey, legacyKey);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function envTruthyUnlessZeroPreferDmoss(dmossKey: string, legacyKey: string): boolean {
  const dm = readEnv(dmossKey);
  const leg = readEnv(legacyKey);
  if (dm !== undefined) return dm !== '0';
  if (leg !== undefined) return leg !== '0';
  return true;
}
