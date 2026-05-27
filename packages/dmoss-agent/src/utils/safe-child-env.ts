/**
 * Build a safe child-process environment for SSH/exec tools.
 * Strips host-side secrets so they are never leaked to remote devices
 * or subprocesses.
 */

const DANGEROUS_ENV_KEYS = [
  'SSHPASS',
  'DMOSS_DEVICE_PASSWORD',
  'DMOSS_DEVICE_HOST',
  'DMOSS_DEVICE_USER',
  'DMOSS_DEVICE_KEY',
  'DMOSS_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'AZURE_API_KEY',
  'HF_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'DATABASE_URL',
  'REDIS_URL',
  'MONGODB_URI',
];

const DANGEROUS_ENV_KEY_PATTERNS = [
  /(^|_)(API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(_|$)/i,
];

const MCP_CHILD_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'NODE_ENV',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
]);

function isAllowedMcpChildEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return MCP_CHILD_ENV_ALLOWLIST.has(normalized) || normalized.startsWith('LC_');
}

function isDangerousEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return DANGEROUS_ENV_KEYS.includes(normalized) || DANGEROUS_ENV_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function safeChildEnv(overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isDangerousEnvKey(key)) continue;
    env[key] = value;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Build an environment for third-party MCP server subprocesses.
 *
 * Unlike device SSH helpers, MCP servers are untrusted community processes, so
 * they receive only minimal runtime variables by default. Per-server mcp.json
 * config.env is the explicit channel for granting a specific secret.
 */
export function safeMcpChildEnv(overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!isAllowedMcpChildEnvKey(key)) continue;
    env[key] = value;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      env[key] = value;
    }
  }
  return env;
}
