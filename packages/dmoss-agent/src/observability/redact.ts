/**
 * Telemetry redaction layer — strips sensitive fields, IPs, file contents,
 * and credential-bearing URLs from structured data before it leaves the runtime.
 *
 * This is complementary to `safety/secret-sanitizer` which operates on raw text.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface RedactOptions {
  /** Fields to allow even if they match a sensitive pattern */
  allowFields?: string[];
  /** Additional patterns to redact */
  extraPatterns?: RegExp[];
}

// ── Constants ───────────────────────────────────────────────────────

const REDACTED = '[REDACTED]';
const CIRCULAR = '[CIRCULAR]';

/** Field-name pattern considered sensitive (matches at field-name word boundaries: start/end/_ or -). */
const SENSITIVE_FIELD_PATTERN =
  /(?:^|[_-])(token|api[_-]?key|secret|password|credential|auth|private[_-]?key|access[_-]?key|connection[_-]?string|dsn|jwt|ssh[_-]?key|signing[_-]?key|encryption[_-]?key|client[_-]?secret)(?:$|[_-])/i;

/** Sensitive field names that contain the word "prompt". */
const PROMPT_FIELD_PATTERN = /prompt/i;

/**
 * IPv4 — reasonably specific: 4 octets of 1-3 digits separated by dots.
 * Avoids matching bare numbers by requiring the dotted structure.
 */
const IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/;
const IPV4_PATTERN_GLOBAL = new RegExp(IPV4_PATTERN.source, 'g');

/**
 * IPv6 — matches full, compressed (::), and mixed forms.
 * Uses lookaround instead of \b since ':' is not a word character.
 */
const IPV6_PATTERN =
  /(?<![0-9a-fA-F:])(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}|:(?::[0-9a-fA-F]{1,4}){1,7}|::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}|::)(?![0-9a-fA-F:])/;
const IPV6_PATTERN_GLOBAL = new RegExp(IPV6_PATTERN.source, 'g');

/** URL with embedded credentials: protocol://user:pass@host */
const URL_WITH_CREDENTIALS_PATTERN = /[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^:]+:[^@]+@/;

/** Threshold: strings longer than this are checked for file-content patterns. */
const FILE_CONTENT_LENGTH_THRESHOLD = 200;

/** Heuristic: a string looks like file contents if it has many lines or looks like code/data. */
const FILE_CONTENT_HEURISTICS: RegExp[] = [
  /^(import |export |from |const |let |var |function |class |def |fn |pub )/m,
  /^(\{|\[|<\w)/m,
  /\n.*\n.*\n.*\n.*\n/m, // 5+ newlines → multi-line content
];

// ── Helpers ─────────────────────────────────────────────────────────

function isSensitiveField(field: string, allowSet: Set<string>): boolean {
  if (allowSet.has(field)) return false;
  if (PROMPT_FIELD_PATTERN.test(field)) return true;
  if (SENSITIVE_FIELD_PATTERN.test(field)) return true;
  return false;
}

function isSensitiveValue(value: string, extraPatterns?: RegExp[]): boolean {
  // Check extra patterns first
  if (extraPatterns) {
    for (const pattern of extraPatterns) {
      if (pattern.test(value)) return true;
    }
  }

  // URL with credentials
  if (URL_WITH_CREDENTIALS_PATTERN.test(value)) return true;

  // File content heuristic (only for long strings)
  if (value.length > FILE_CONTENT_LENGTH_THRESHOLD) {
    for (const heuristic of FILE_CONTENT_HEURISTICS) {
      if (heuristic.test(value)) return true;
    }
  }

  return false;
}

// ── IP redaction ─────────────────────────────────────────────────────

function redactIPs(value: string): string {
  return value
    .replace(IPV4_PATTERN_GLOBAL, '[IP_REDACTED]')
    .replace(IPV6_PATTERN_GLOBAL, '[IP_REDACTED]');
}

// ── Core redaction ──────────────────────────────────────────────────

function walk(
  value: unknown,
  allowSet: Set<string>,
  extraPatterns: RegExp[] | undefined,
  seen: WeakSet<object>,
): unknown {
  // Primitives, null, undefined — pass through
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (isSensitiveValue(value, extraPatterns)) return REDACTED;
    return redactIPs(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'symbol' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'function') {
    return value;
  }

  // Object guard — must be after primitive checks
  if (typeof value !== 'object') return value;

  // Circular reference detection
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  // Arrays
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, allowSet, extraPatterns, seen));
  }

  // Built-in types — walk Map/Set entries so sensitive fields inside them are still redacted
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      const key = String(k);
      if (isSensitiveField(key, allowSet)) {
        obj[key] = REDACTED;
      } else {
        obj[key] = walk(v, allowSet, extraPatterns, seen);
      }
    }
    return obj;
  }
  if (value instanceof Set) {
    return [...value].map((item) => walk(item, allowSet, extraPatterns, seen));
  }
  if (value instanceof Date) return value.toISOString();

  // Plain objects — redact sensitive fields, recurse on the rest
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveField(key, allowSet)) {
      result[key] = REDACTED;
    } else if (typeof val === 'string' && isSensitiveValue(val, extraPatterns)) {
      result[key] = REDACTED;
    } else {
      result[key] = walk(val, allowSet, extraPatterns, seen);
    }
  }
  return result;
}

/**
 * Recursively redact sensitive data from an arbitrary value.
 *
 * - Walks objects and arrays deeply
 * - Replaces sensitive values with `[REDACTED]`
 * - Returns a deep copy — never mutates the input
 * - Handles circular references by emitting `[CIRCULAR]`
 * - Safe on primitives, null, undefined
 */
export function redactSensitiveData(obj: unknown, options?: RedactOptions): unknown {
  const allowSet = new Set<string>(options?.allowFields ?? []);
  // Also merge env-based allowlist
  for (const field of parseTelemetryAllow()) {
    allowSet.add(field);
  }
  const seen = new WeakSet<object>();
  return walk(obj, allowSet, options?.extraPatterns, seen);
}

// ── Environment variable parsing ────────────────────────────────────

/**
 * Parse `DMOSS_TELEMETRY_ALLOW` env var into a set of field names.
 *
 * Hosts set this to opt specific fields into telemetry collection:
 *   DMOSS_TELEMETRY_ALLOW=prompt,token,secret
 */
export function parseTelemetryAllow(): Set<string> {
  const raw = process.env.DMOSS_TELEMETRY_ALLOW;
  if (!raw || typeof raw !== 'string') return new Set();
  const fields = raw
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  const allowed = new Set<string>();
  for (const field of fields) {
    if (SENSITIVE_FIELD_PATTERN.test(field) || PROMPT_FIELD_PATTERN.test(field)) {
      console.warn(`[redact] DMOSS_TELEMETRY_ALLOW: rejected sensitive field "${field}"`);
      continue;
    }
    allowed.add(field);
  }
  return allowed;
}

