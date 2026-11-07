// Public errors are safe to render. Upstream text is not: it can carry a
// bearer token, an absolute path, or a stack that names a private file.

const BEARER = /bearer\s+\S+/gi;
const ASSIGNMENT =
  /\b(api[_-]?key|token|secret|password|authorization|mcp_secret)\b\s*[:=]\s*\S+/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_\-+/=]{32,}\b/g;
const STACK_LINE = /^\s*at\s+\S+/;
const ABS_PATH = /(?:\/[\w.@+-]+){2,}/g;

export function redactPublicMessage(input: unknown, fallback = 'The upstream read failed.'): string {
  const raw = typeof input === 'string' ? input : '';
  const noStack = raw
    .split('\n')
    .filter(line => !STACK_LINE.test(line))
    .join(' ');
  const cleaned = noStack
    .replace(BEARER, 'bearer [redacted]')
    .replace(ASSIGNMENT, '$1 [redacted]')
    .replace(ABS_PATH, '[path]')
    .replace(LONG_TOKEN, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, 200);
}
