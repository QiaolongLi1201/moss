/**
 * Secret detection and sanitization — masks API keys, tokens, JWTs, and credentials in text.
 *
 * Stateless design: each call creates fresh RegExp instances to avoid lastIndex leaks.
 */

type SecretRule = { source: string; flags: string; label: string; groupIdx?: number };

const SECRET_RULES: SecretRule[] = [
  { source: '\\b(sk-[a-zA-Z0-9_-]{20,})\\b', flags: 'g', label: 'OpenAI key' },
  { source: '\\b(sk-ant-[a-zA-Z0-9_-]{20,})\\b', flags: 'g', label: 'Anthropic key' },
  { source: '\\b(gsk_[a-zA-Z0-9]{20,})\\b', flags: 'g', label: 'Groq key' },
  { source: '\\b(xai-[a-zA-Z0-9]{20,})\\b', flags: 'g', label: 'xAI key' },
  { source: '\\b(AIza[a-zA-Z0-9_-]{30,})\\b', flags: 'g', label: 'Google key' },
  { source: '\\b(ghp_[a-zA-Z0-9]{36,})\\b', flags: 'g', label: 'GitHub token' },
  { source: '\\b(github_pat_[a-zA-Z0-9_]{20,})\\b', flags: 'g', label: 'GitHub fine-grained token' },
  { source: '\\b(glpat-[a-zA-Z0-9_-]{20,})\\b', flags: 'g', label: 'GitLab token' },
  { source: '\\b(AKIA[A-Z0-9]{16})\\b', flags: 'g', label: 'AWS access key' },
  { source: '\\b(sk_live_[a-zA-Z0-9]{20,})\\b', flags: 'g', label: 'Stripe live key' },
  { source: '\\b(sk_test_[a-zA-Z0-9]{20,})\\b', flags: 'g', label: 'Stripe test key' },
  { source: '\\b(xoxb-[a-zA-Z0-9-]{20,})\\b', flags: 'g', label: 'Slack bot token' },
  { source: '(eyJ[a-zA-Z0-9_-]{10,}\\.eyJ[a-zA-Z0-9_-]{10,}\\.[a-zA-Z0-9_=+-]{10,})', flags: 'g', label: 'JWT' },
  {
    source: '(?:password|passwd|pwd|secret|token|apikey|api_key|api-key|access_key)\\s*[:=]\\s*[\'"]([^\'"]{6,})[\'"]',
    flags: 'gi',
    label: 'credential value',
    groupIdx: 1,
  },
];

function buildPattern(rule: SecretRule): RegExp {
  return new RegExp(rule.source, rule.flags);
}

function maskValue(value: string): string {
  if (value.length <= 4) return '***';
  const visible = Math.min(4, Math.floor(value.length * 0.15));
  return value.slice(0, visible) + '***' + value.slice(-2);
}

export function sanitizeSecrets(text: string): string {
  if (!text || typeof text !== 'string') return text ?? '';
  let result = text;
  for (const rule of SECRET_RULES) {
    const pattern = buildPattern(rule);
    if (rule.groupIdx !== undefined) {
      const gi = rule.groupIdx;
      result = result.replace(pattern, (...args) => {
        const full: string = args[0];
        const captured: string = args[gi];
        if (!captured) return full;
        return full.replace(captured, maskValue(captured));
      });
    } else {
      result = result.replace(pattern, (match) => maskValue(match));
    }
  }
  return result;
}

export function containsSecrets(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  for (const rule of SECRET_RULES) {
    const pattern = new RegExp(rule.source, rule.flags.replace('g', ''));
    if (pattern.test(text)) return true;
  }
  return false;
}
