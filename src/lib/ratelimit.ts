// An in-process rate limiter, and an honest description of what it is not.
//
// ─────────────────────────── READ THIS FIRST ───────────────────────────
// This is a Map in the memory of ONE process. On serverless (Vercel, Lambda,
// Cloud Run) that means:
//
//   - N warm instances = N independent quotas. A "5 per minute" limit is
//     really "5 per minute per instance", and you do not control N.
//   - A cold start resets the counter to zero.
//   - It disappears entirely on redeploy.
//
// So it is FRICTION AGAINST AN AGENT LOOP, not a WAF and not an abuse control.
// It is here because a retrying agent is the common failure mode (cheap to
// stop, no infrastructure needed), and because writing it down beats the
// alternative: a team that believes it has a ceiling and does not.
//
// The limits that actually hold are the ones attached to the EFFECT, not to
// the request counter, because they are business invariants that survive any
// number of instances:
//
//   - fail-closed availability: no verified units, no order (src/lib/commerce.ts),
//   - out-of-stock precondition before any email goes out,
//   - dedupe on (recipient, product) at the point the email is sent,
//   - double opt-in: nothing is persisted without a human POST,
//   - per-tool kill switch, dry by default (src/lib/write-mode.ts).
//
// To make the counter real, replace the store below with Redis/KV/Durable
// Objects. `rateLimited` is deliberately a tiny synchronous port with a single
// call site shape so the swap is mechanical — that is the extension point.
// ───────────────────────────────────────────────────────────────────────

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Keep the Map from growing without bound in a long-lived process. */
function prune(now: number): void {
  if (buckets.size < 5000) return;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

export interface RateVerdict {
  limited: boolean;
  /** Calls left in the current window AFTER this call. */
  remaining: number;
  retry_after_s: number;
}

/**
 * Generic fixed-window counter.
 *
 * Key it by the RESOURCE YOU ARE PROTECTING, not by whatever is convenient to
 * read off the request. A quota keyed by IP protects nobody when the thing
 * being harmed is a stranger's mailbox: IPs rotate, mailboxes do not. That is
 * why this takes an arbitrary key instead of hard-coding the client address —
 * the email-alert path keys by recipient, the checkout path keys by caller.
 *
 * @param consume set false to look without spending (used by dry runs, which
 *                must not silently burn a quota that protects a third party).
 */
export function rateLimited(
  key: string,
  max: number,
  windowMs: number,
  opts: { consume?: boolean } = {},
): RateVerdict {
  const consume = opts.consume !== false;
  const now = Date.now();
  prune(now);

  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    if (consume) buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { limited: false, remaining: max - 1, retry_after_s: 0 };
  }
  if (b.count >= max) {
    return {
      limited: true,
      remaining: 0,
      retry_after_s: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
    };
  }
  if (consume) b.count += 1;
  return { limited: false, remaining: max - b.count, retry_after_s: 0 };
}

/** Test/ops helper: forget every counter. Never called by the protocol layer. */
export function resetRateLimits(): void {
  buckets.clear();
}

// ───────────────────────── the quotas this server uses ─────────────────────────

/**
 * ONE bucket SHARED by every write tool, keyed by caller.
 *
 * Shared on purpose (a loop is a loop regardless of which tool it hammers),
 * and said out loud on purpose: the error message names both tools and the
 * tool descriptions repeat it. A limit whose semantics are described wrong is
 * paid for in retries — an agent that believes the quota is per-tool will
 * alternate them, hit the wall early, conclude the server is flaky and loop.
 * For an MCP server, tool descriptions and error strings ARE the API.
 */
export const WRITE_TOOL_QUOTA = { max: 5, windowMs: 60_000 };

/**
 * Per-RECIPIENT quota for the confirmation email, evaluated independently of
 * the caller quota above. The scarce resource being protected here is somebody
 * else's inbox and your sending domain's reputation, and neither of those is
 * keyed by IP.
 */
export const ALERT_EMAIL_QUOTA = { max: 3, windowMs: 60 * 60_000 };
