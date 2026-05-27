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
];

export function safeChildEnv(overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (DANGEROUS_ENV_KEYS.includes(key)) continue;
    env[key] = value;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      env[key] = value;
    }
  }
  return env;
}
