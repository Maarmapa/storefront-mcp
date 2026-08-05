// Resolving the caller's address, in ONE place so the transports cannot drift.
//
// The trap: `x-forwarded-for` is a list the request walks through, and the
// LEFTMOST entry is whatever the CLIENT wrote. Keying a rate limit on
// `xff.split(',')[0]` gives the caller a brand new quota bucket per request —
// send `X-Forwarded-For: 1.2.3.4`, then `1.2.3.5`, and the limiter is a no-op
// with extra steps.
//
// Rules, in order:
//   1. Prefer a header your own proxy/platform writes and strips from client
//     input (x-vercel-forwarded-for, x-real-ip, cf-connecting-ip...). Those
//     cannot be forged from outside.
//   2. Falling back to x-forwarded-for, take the LAST value: it was appended
//      by the hop closest to you. Everything to its left is caller-supplied
//      text and is worth nothing.
//
// If you deploy behind a different edge, add its header to PLATFORM_HEADERS —
// and make sure that edge overwrites it rather than appending to it.

/** Headers written by the infrastructure, not by the caller. Order = priority. */
const PLATFORM_HEADERS = [
  'x-vercel-forwarded-for',
  'cf-connecting-ip',
  'fly-client-ip',
  'true-client-ip',
  'x-real-ip',
];

export type HeaderLookup = (name: string) => string | string[] | null | undefined;

function first(value: string | string[] | null | undefined): string | null {
  if (value == null) return null;
  const v = Array.isArray(value) ? value[value.length - 1] : value;
  const s = (v ?? '').trim();
  return s.length > 0 ? s : null;
}

/**
 * Best-effort caller identity for rate limiting. Returns "unknown" rather than
 * throwing: an unresolvable address must not take the server down, it just
 * shares one bucket with every other unresolvable caller.
 */
export function clientIpFrom(get: HeaderLookup): string {
  for (const h of PLATFORM_HEADERS) {
    const v = first(get(h));
    if (v) return v.split(',').pop()!.trim();
  }
  const xff = first(get('x-forwarded-for'));
  if (xff) {
    // LAST hop, not first — see the header comment.
    const last = xff.split(',').pop()?.trim();
    if (last) return last;
  }
  return 'unknown';
}

/** Convenience wrapper for the Fetch API `Headers` object (Next.js route). */
export function clientIpFromHeaders(headers: { get(name: string): string | null }): string {
  return clientIpFrom(name => headers.get(name));
}

/** Convenience wrapper for node:http `IncomingHttpHeaders`. */
export function clientIpFromNodeHeaders(
  headers: Record<string, string | string[] | undefined>,
): string {
  return clientIpFrom(name => headers[name]);
}
