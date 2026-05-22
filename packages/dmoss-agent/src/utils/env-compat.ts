/**
 * Environment variable utilities — preference-based env reading with legacy fallback.
 */

export function envPreferDmoss(dmossKey: string, legacyKey: string): string | undefined {
  const v = process.env[dmossKey]?.trim();
  if (v !== undefined && v !== '') return v;
  const legacy = process.env[legacyKey]?.trim();
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
  const dm = process.env[dmossKey];
  const leg = process.env[legacyKey];
  if (dm !== undefined) return dm !== '0';
  if (leg !== undefined) return leg !== '0';
  return true;
}
