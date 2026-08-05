// Resolving WHO is calling, in ONE place so the transports cannot drift.
//
// ─────────────────────── THE MISTAKE THIS FILE MAKES EXPLICIT ───────────────────────
//
// Every "get the client IP" helper on the internet reads a forwarding header:
// x-forwarded-for, x-real-ip, cf-connecting-ip. The subtlety usually stops at
// "don't take the FIRST x-forwarded-for entry, take the last one, because the
// left side is caller-supplied".
//
// That advice is only half the problem, and the half it misses is the one that
// bites. A forwarding header is written by a proxy. If there is NO proxy in
// front of you — `node server.js` on a VPS, a bare `next start`, an nginx
// without `proxy_set_header`, a container with a public port — then the
// *entire* header, last hop included, is a string the caller typed. Rotating
// `X-Forwarded-For: 203.0.113.1, .2, .3` then mints a brand new quota bucket
// per request and the rate limit is a no-op with extra steps.
//
// So this module inverts the default. Forwarding headers are NOT trusted
// unless the operator names the one their edge writes:
//
//   TRUSTED_PROXY_HEADER=x-vercel-forwarded-for   (Vercel)
//   TRUSTED_PROXY_HEADER=cf-connecting-ip         (Cloudflare)
//   TRUSTED_PROXY_HEADER=x-storefront-client-ip   (the bundled WordPress proxy)
//
// Naming a header is an ASSERTION with a precondition: "my edge overwrites
// this header on every request, AND nothing else can reach this origin". If
// your origin is publicly reachable, that header is forgeable by anyone who
// finds the origin URL, and you are back where you started — put the origin
// behind the edge (Vercel deployment protection, a firewall, an allowlist,
// mTLS) or accept that the counter is decorative.
//
// With no trusted header configured, the transport's own answer is used when
// it has one (the TCP peer address, which nobody can forge) and otherwise the
// caller is UNATTRIBUTED — and an unattributed deployment gets a different,
// clearly-labelled quota shape instead of a per-caller promise it cannot keep.
// See src/lib/ratelimit.ts.

export type HeaderLookup = (name: string) => string | string[] | null | undefined;

/** Key used when callers cannot be told apart on this deployment. */
export const UNATTRIBUTED_KEY = 'unattributed';

export interface CallerIdentity {
  /**
   * Quota key. Named to match CallContext in src/lib/commerce.ts so a
   * transport can hand this object straight to the protocol layer without an
   * adapter step that could quietly drop the `attributed` flag.
   */
  clientKey: string;
  /**
   * True when `clientKey` identifies one caller and cannot be set by that
   * caller. False means every caller shares it — the quota is then a process-wide
   * ceiling, not a per-caller one, and every message that mentions it says so.
   */
  attributed: boolean;
  /** How it was resolved: for startup logs and the descriptor. */
  source: 'trusted-header' | 'socket' | 'stdio' | 'none';
}

export const UNATTRIBUTED: CallerIdentity = {
  clientKey: UNATTRIBUTED_KEY,
  attributed: false,
  source: 'none',
};

/** env TRUSTED_PROXY_HEADER, normalized. Null when the operator set nothing. */
export function trustedProxyHeader(): string | null {
  const h = (process.env.TRUSTED_PROXY_HEADER ?? '').trim().toLowerCase();
  return h.length > 0 ? h : null;
}

function firstValue(value: string | string[] | null | undefined): string | null {
  if (value == null) return null;
  // Node collapses repeated headers into an array; the last one is the one the
  // closest hop appended.
  const v = Array.isArray(value) ? value[value.length - 1] : value;
  const s = (v ?? '').trim();
  return s.length > 0 ? s : null;
}

/**
 * Resolve the caller from request headers plus whatever the transport knows.
 *
 * @param get           header lookup for this request
 * @param socketAddress the peer address the transport observed, when it has
 *                      one (node:http gives you `req.socket.remoteAddress`;
 *                      a serverless Fetch handler does not). Unforgeable.
 */
export function resolveCaller(get: HeaderLookup, socketAddress?: string | null): CallerIdentity {
  const trusted = trustedProxyHeader();
  if (trusted) {
    const raw = firstValue(get(trusted));
    if (raw) {
      // Even a trusted header can be a list (x-forwarded-for style). The LAST
      // entry is the one the closest hop appended; everything to its left came
      // from further out and is worth nothing.
      const last = raw.split(',').pop()?.trim();
      if (last) return { clientKey: `ip:${last}`, attributed: true, source: 'trusted-header' };
    }
    // Configured but absent: do NOT silently fall back to another header. A
    // missing trusted header means this request did not come through the edge
    // the operator described, which is exactly the case worth not trusting.
  }

  const sock = (socketAddress ?? '').trim();
  if (sock) return { clientKey: `sock:${sock}`, attributed: true, source: 'socket' };

  return UNATTRIBUTED;
}

/** Convenience wrapper for the Fetch API `Headers` object (Next.js route). */
export function resolveCallerFromHeaders(headers: { get(name: string): string | null }): CallerIdentity {
  // A Fetch-style handler has no socket: without a trusted header this is
  // deliberately unattributed rather than optimistically forged.
  return resolveCaller(name => headers.get(name), null);
}

/** Convenience wrapper for node:http. */
export function resolveCallerFromNode(
  headers: Record<string, string | string[] | undefined>,
  socketAddress?: string | null,
): CallerIdentity {
  return resolveCaller(name => headers[name], socketAddress);
}
