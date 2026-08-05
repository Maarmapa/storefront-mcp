// Signed double opt-in tokens.
//
// The problem this solves: an email address that arrived as a tool argument is
// an address SOMEBODY ELSE typed. Persisting a subscription from it is
// subscribing a stranger. So the tool never activates anything — it can only
// mint a token and mail it, and the subscription exists once the human acts on
// that token.
//
// A confirmation token is only worth as much as its construction:
//   - unsigned  → anyone forges one and the opt-in is theatre,
//   - expiry stored next to the token instead of INSIDE the signed payload
//                → the expiry is advisory and gets ignored,
//   - `===` on the signature → leaks the answer byte by byte to a prober,
//   - no secret configured → the tempting default is "skip verification",
//                which turns a missing env var into an open door,
//   - a SHORT secret → the HMAC is only as strong as its key. Accepting
//                `STOCK_ALERT_SIGNING_SECRET=x` means an attacker who guesses
//                or brute-forces one character can mint a valid token for any
//                address and POST it themselves, subscribing a victim who
//                never received mail at all. "Non-empty" is not a key policy.
//
// Hence: `v1.<payload>.<hmac>`, expiry inside the signed payload, timing-safe
// comparison, a MINIMUM KEY LENGTH, and FAIL-CLOSED when the secret is
// missing or too weak — in which case no tokens are issued and none are
// accepted. The tool then answers "opt-in is not available on this
// deployment" instead of quietly subscribing people.
//
// Env: STOCK_ALERT_SIGNING_SECRET (generate with `openssl rand -hex 32`).

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LineRef } from './adapter';

/** 48 h: long enough for a human to read mail on Monday, short enough to expire. */
export const OPT_IN_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Minimum accepted length for the signing key, in characters.
 *
 * 32 is what `openssl rand -hex 32` produces per 16 bytes of entropy — the
 * documented recipe yields 64, so the floor rejects sloppiness without
 * rejecting anything reasonable. It is a length check, not an entropy
 * measurement: 32 identical characters passes. It exists to catch the
 * `=changeme` / `=x` / `=secret` class of configuration, which is the class
 * that actually happens.
 */
export const MIN_SIGNING_SECRET_LENGTH = 32;

const VERSION = 'v1';

interface TokenPayload {
  /** email */
  e: string;
  /** product slug */
  s: string;
  /** optional variant sku */
  k?: string;
  /** expiry, epoch ms — INSIDE the signed payload, so it cannot be edited away */
  x: number;
}

function secret(): string | null {
  const s = (process.env.STOCK_ALERT_SIGNING_SECRET ?? '').trim();
  return s.length >= MIN_SIGNING_SECRET_LENGTH ? s : null;
}

/** Why opt-in is unavailable, when it is. For operator-facing messages only. */
export type SigningSecretState = 'ok' | 'missing' | 'too_short';

export function signingSecretState(): SigningSecretState {
  const raw = (process.env.STOCK_ALERT_SIGNING_SECRET ?? '').trim();
  if (raw.length === 0) return 'missing';
  return raw.length >= MIN_SIGNING_SECRET_LENGTH ? 'ok' : 'too_short';
}

/** Is double opt-in usable at all on this deployment? */
export function optInConfigured(): boolean {
  return secret() !== null;
}

/**
 * Where the human confirms — or null, which means NOTHING MAY BE SENT.
 *
 * There used to be a fallback to `https://example.com`, and it was the single
 * fail-OPEN in a flow where everything else fails closed: with the signing
 * secret set but no site URL, live mode happily mailed a stranger a link to a
 * domain the operator does not own, carrying a signed token with that
 * stranger's address inside it. A dead link is bad; a dead link on somebody
 * else's domain with your customer's address in the query string is worse.
 *
 * The URL must be absolute and http(s). A relative path cannot survive a trip
 * through an email client.
 */
export function confirmUrlBase(): string | null {
  const explicit = (process.env.STOCK_ALERT_CONFIRM_URL ?? '').trim();
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? '').trim();
  const candidate = explicit || (site ? `${site.replace(/\/$/, '')}/api/stock-alert/confirm` : '');
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return candidate.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payloadB64: string, key: string): string {
  return createHmac('sha256', key).update(payloadB64).digest('hex');
}

export interface IssuedToken {
  token: string;
  expires_at: string;
}

/**
 * Mint a confirmation token. Returns null when no signing secret is
 * configured — the caller MUST treat that as "cannot offer opt-in" and refuse,
 * never as "proceed without confirmation".
 */
export function issueOptInToken(
  email: string,
  ref: LineRef & { slug: string },
  now: number = Date.now(),
): IssuedToken | null {
  const key = secret();
  if (!key) return null;
  const payload: TokenPayload = {
    e: email,
    s: ref.slug,
    ...(ref.sku ? { k: ref.sku } : {}),
    x: now + OPT_IN_TTL_MS,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return {
    token: `${VERSION}.${payloadB64}.${sign(payloadB64, key)}`,
    expires_at: new Date(payload.x).toISOString(),
  };
}

export type OptInFailure = 'not_configured' | 'malformed' | 'bad_signature' | 'expired';

export type VerifiedToken =
  | { ok: true; email: string; slug: string; sku?: string; expires_at: string }
  | { ok: false; reason: OptInFailure };

/**
 * Verify a token. NEVER throws: a malformed string from the internet is an
 * expected input, not an exception, and a 500 would leak more than it hides.
 */
export function verifyOptInToken(token: string, now: number = Date.now()): VerifiedToken {
  const key = secret();
  if (!key) return { ok: false, reason: 'not_configured' };

  const parts = (token || '').split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' };
  const [, payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return { ok: false, reason: 'malformed' };

  const expected = sign(payloadB64, key);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Constant-time: a length check first (lengths are public), then the compare.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };

  let payload: TokenPayload;
  try {
    payload = JSON.parse(unb64url(payloadB64).toString('utf8')) as TokenPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload || typeof payload.e !== 'string' || typeof payload.s !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload.x !== 'number' || !Number.isFinite(payload.x)) {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.x <= now) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    email: payload.e,
    slug: payload.s,
    sku: typeof payload.k === 'string' ? payload.k : undefined,
    expires_at: new Date(payload.x).toISOString(),
  };
}

/**
 * What the outside world is told when verification fails.
 *
 * "no secret configured", "malformed" and "bad signature" deliberately share
 * ONE message: distinguishing them tells a prober whether the server is
 * misconfigured and whether their forgery had the right shape. "Expired" is
 * the exception — it is actionable for the human holding the link, and knowing
 * that a valid token existed at some point helps an attacker with nothing.
 */
export function optInFailureMessage(reason: OptInFailure): string {
  return reason === 'expired'
    ? 'This confirmation link has expired. Request the alert again to get a new one.'
    : 'This confirmation link is not valid.';
}
