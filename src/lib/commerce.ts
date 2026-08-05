// The two write tools: create_checkout and subscribe_stock_alert.
//
// Everything in this file exists because a write tool exposed to an anonymous
// agent is not "a read tool that also saves". It can spend a human's money and
// it can send mail to a stranger, at machine speed, in a loop, with nobody
// watching. The guard rails below are therefore NOT toggles: the ones that
// protect a third party cannot be configured away, only the *effect* can be
// switched off entirely (dry mode).
//
// Order of operations is itself a guard rail and is the same in both tools:
//   validate input → canonicalize → check preconditions → decide → only then act.
// Anything that runs after the effect has already happened is documentation,
// not protection.

import type { CheckoutDraft, CheckoutLine, LineRef, Quote } from './adapter';
import { getAdapters } from './adapters';
import { blocksWrite, refKey, resolveAvailability } from './availability';
import { MAX_UNITS_PER_PRODUCT, normalizeCart } from './cart';
import { RATE_LIMITED_CODE, ToolCallError } from './errors';
import { issueOptInToken, OPT_IN_TTL_MS, optInConfigured } from './optin';
import { ALERT_EMAIL_QUOTA, rateLimited, WRITE_TOOL_QUOTA } from './ratelimit';
import { checkoutMode, stockAlertMode } from './write-mode';

/** Who is calling, for quota purposes. Filled in by each transport. */
export interface CallContext {
  /** Resolved client address, or "stdio" for the local transport. */
  clientKey: string;
}

export const DEFAULT_CONTEXT: CallContext = { clientKey: 'unknown' };

/**
 * Truthful quota error. The bucket is SHARED by both write tools, so the
 * message names both and says the word "shared".
 *
 * The alternative — "max 5 calls/min to 'create_checkout'" while the counter
 * is really shared — teaches an agent that alternating tools resets the quota.
 * It then hits the wall early, concludes the server is flaky, and retries: the
 * rate limit generating the traffic it exists to stop. For an MCP server, the
 * error string is part of the API surface, not an afterthought for humans.
 */
function sharedQuotaError(retryAfterS: number): ToolCallError {
  return new ToolCallError(
    RATE_LIMITED_CODE,
    `Rate limit reached: ${WRITE_TOOL_QUOTA.max} calls per minute per caller, SHARED between ` +
      `create_checkout and subscribe_stock_alert (the quota is common to both, not per tool). ` +
      `Retry in ${retryAfterS}s. Do not loop — the limit is per caller, so retrying faster makes it worse.`,
  );
}

function spendSharedQuota(ctx: CallContext): void {
  const v = rateLimited(`write:${ctx.clientKey}`, WRITE_TOOL_QUOTA.max, WRITE_TOOL_QUOTA.windowMs);
  if (v.limited) throw sharedQuotaError(v.retry_after_s);
}

/** Deliberately boring. Address *validation* is not address *verification*. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null;
}

// ───────────────────────────── create_checkout ─────────────────────────────

/**
 * Turn a list of {slug|sku, qty} into a real order — or, far more often,
 * into a precise explanation of why it refuses to.
 *
 * The invariants, none of which are configurable:
 *
 *  1. PRICES ARE NEVER ACCEPTED FROM THE CALLER. The input schema has no price
 *     field at all; every unit price and total comes from the catalog on this
 *     request. A schema that accepts a price accepts a discount.
 *  2. LINES ARE CONSOLIDATED BEFORE ANY LIMIT OR STOCK CHECK. Twenty lines of
 *     50 for one SKU is a thousand units, and every per-line check waves it
 *     through.
 *  3. INVALID QUANTITIES ARE REJECTED, NEVER REPAIRED.
 *  4. FAIL-CLOSED AVAILABILITY. Not enough units, or units that cannot be
 *     verified, and nothing is created. Since an order typically does not
 *     reserve stock, this check is the only thing standing between an agent
 *     loop and an oversell.
 *  5. THE VERDICT SHIPS WITH ITS EVIDENCE. Every line comes back with
 *     stock_available and stock_verified, because the tool that reports exact
 *     stock (get_stock_bulk) is token-gated and the public agent cannot call
 *     it. If your privilege boundary denies the agent the diagnostic tool,
 *     the write tool owes it the diagnosis.
 */
export async function createCheckoutTool(
  args: Record<string, unknown>,
  ctx: CallContext,
): Promise<unknown> {
  const { catalog, checkout, inventory } = getAdapters();
  const mode = checkoutMode();

  // Should be unreachable (the tool is not announced), but a caller can always
  // guess a name — so the capability check runs before anything else.
  if (mode === 'off' || !checkout || !inventory) {
    throw new ToolCallError(-32601, 'create_checkout is not available on this deployment');
  }

  spendSharedQuota(ctx);

  const cart = normalizeCart(args.items);
  const emailRaw = args.customer_email;
  const customerEmail = emailRaw == null ? null : cleanEmail(emailRaw);
  const emailInvalid = emailRaw != null && customerEmail === null;

  const base = {
    mode,
    currency_note: 'Every price in this response was computed server-side from the catalog.',
    availability_note:
      'stock_available / stock_verified are included on every line on purpose: exact stock is a ' +
      'token-gated tool, so a public agent cannot check it itself. stock_verified:false means the ' +
      'count is UNKNOWN, and unknown blocks the order exactly like zero does.',
    items_invalid_qty: cart.items_invalid_qty,
    items_missing_ref: cart.items_missing_ref,
    consolidated: cart.consolidated,
  };

  if (cart.too_many_input_items) {
    return {
      created: false,
      blocked: true,
      reason: 'too_many_input_items',
      ...base,
      detail: cart.too_many_input_items,
    };
  }
  if (cart.too_many_products) {
    return {
      created: false,
      blocked: true,
      reason: 'too_many_distinct_products',
      ...base,
      detail: cart.too_many_products,
      message:
        `After consolidating duplicates the cart still has ${cart.too_many_products.distinct} distinct ` +
        `products; the limit is ${cart.too_many_products.limit}. Split the order.`,
    };
  }
  if (cart.lines.length === 0) {
    return {
      created: false,
      blocked: true,
      reason: 'no_valid_items',
      ...base,
      message:
        'No usable line survived validation. Quantities must be integers greater than 0 and each ' +
        'item needs a slug or a sku. Nothing was corrected for you on purpose.',
    };
  }

  const refs: LineRef[] = cart.lines.map(l => (l.sku ? { sku: l.sku, slug: l.slug } : { slug: l.slug }));

  // ── PRICES: the catalog answers "what does it cost". Note that this is the
  // ── ONLY question it answers here. It knows nothing about units.
  let quote: Quote;
  try {
    quote = await catalog.getQuote(
      cart.lines.map(l => ({ slug: l.slug, sku: l.sku, qty: l.qty })),
    );
  } catch (e) {
    return {
      created: false,
      blocked: true,
      reason: 'pricing_unavailable',
      ...base,
      message: `The catalog could not price this cart: ${(e as Error).message}. Nothing was created.`,
    };
  }

  const pricedByKey = new Map<string, Quote['items'][number]>();
  for (const line of quote.items) pricedByKey.set(refKey(line), line);
  const catalogRejection = new Map<string, string>();
  for (const r of quote.rejected) catalogRejection.set(refKey(r), r.reason);

  // ── AVAILABILITY: a different system answering a different question. This
  // ── is the step whose absence turns a checkout tool into an oversell tool.
  const availability = await resolveAvailability(inventory, refs);
  const availByKey = new Map(availability.map(a => [refKey(a), a]));

  const lines = cart.lines.map(l => {
    const priced = pricedByKey.get(l.key);
    const avail = availByKey.get(l.key)!;
    const blockers: string[] = [];

    if (l.qty > MAX_UNITS_PER_PRODUCT) {
      blockers.push(
        `consolidated quantity ${l.qty} is over the per-product limit of ${MAX_UNITS_PER_PRODUCT} ` +
          `(this is the total for this product across every line you sent, not one line)`,
      );
    }
    if (!priced) {
      blockers.push(catalogRejection.get(l.key) ?? 'the catalog did not return a price for this line');
    }
    if (blocksWrite(avail, l.qty)) {
      blockers.push(
        avail.units == null
          ? `availability could not be verified (${avail.reason ?? 'unknown reason'}) — an unverifiable ` +
            `line blocks the order exactly like an out-of-stock one`
          : `only ${avail.units} unit(s) available and ${l.qty} requested`,
      );
    }

    return {
      slug: l.slug,
      sku: l.sku,
      name: priced?.name ?? null,
      qty_requested: l.qty,
      ...(l.merged_from > 1 ? { merged_from_input_lines: l.merged_from } : {}),
      unit_price: priced?.unit_price ?? null,
      line_total: priced?.line_total ?? null,
      stock_available: avail.units,
      stock_verified: avail.verified,
      ...(avail.reason ? { stock_note: avail.reason } : {}),
      blocked: blockers.length > 0,
      ...(blockers.length > 0 ? { blockers } : {}),
    };
  });

  // A single bad input poisons the whole call. Creating an order for "the
  // items that happened to be fine" hands a human a cart they never asked
  // for; the caller has to see the problem and re-send.
  const anyLineBlocked = lines.some(l => l.blocked);
  const anyInputRejected =
    cart.items_invalid_qty.length > 0 || cart.items_missing_ref.length > 0;

  const subtotal = Math.round(lines.reduce((s, l) => s + (l.line_total ?? 0), 0) * 100) / 100;
  const currency = quote.currency;

  if (emailInvalid) {
    return {
      created: false,
      blocked: true,
      reason: 'invalid_customer_email',
      ...base,
      lines,
      message: 'customer_email is not a valid address. Nothing was created.',
    };
  }

  if (anyLineBlocked || anyInputRejected) {
    return {
      created: false,
      blocked: true,
      reason: anyLineBlocked ? 'guard_rails_blocked' : 'invalid_items_present',
      ...base,
      lines,
      subtotal: null,
      currency,
      message:
        (mode === 'dry'
          ? 'DRY RUN, but read this as a real refusal: '
          : '') +
        'nothing was created. Fix the lines flagged below and call again — the per-line ' +
        'stock_available figures tell you exactly what fits. Partial orders are never created.',
    };
  }

  if (mode === 'dry') {
    return {
      created: false,
      blocked: false,
      ...base,
      lines,
      subtotal,
      currency,
      would_create: {
        lines: lines.length,
        units: lines.reduce((s, l) => s + l.qty_requested, 0),
        subtotal,
        currency,
      },
      message:
        'DRY RUN — every guard rail ran and this cart PASSED, but nothing was created and no ' +
        'payment link exists. In live mode this call would create the order above. The operator ' +
        'turns it on with CHECKOUT_MODE=live.',
    };
  }

  const draft: CheckoutDraft = {
    lines: lines.map(
      (l): CheckoutLine => ({
        slug: l.slug,
        sku: l.sku,
        name: l.name ?? l.sku ?? l.slug ?? 'item',
        qty: l.qty_requested,
        unit_price: l.unit_price ?? 0,
        line_total: l.line_total ?? 0,
      }),
    ),
    subtotal,
    currency,
    // Passed through for the order record only. NO automated mail is sent to
    // it from here: this address was typed by the agent, not by the person who
    // owns the mailbox, and mailing it would re-open the exact cannon that
    // subscribe_stock_alert closes. The customer gets mail when they PAY —
    // triggered by the payment provider's webhook, which is the first moment
    // there is evidence the human exists and wanted this.
    ...(customerEmail ? { customer_email: customerEmail } : {}),
    ...(typeof args.note === 'string' ? { note: args.note.slice(0, 500) } : {}),
    ...(typeof args.ref === 'string' ? { ref: args.ref.slice(0, 120) } : {}),
  };

  const receipt = await checkout.createCheckout(draft);
  return {
    created: true,
    blocked: false,
    ...base,
    order: receipt,
    lines,
    subtotal,
    currency,
    message:
      'Order created. Hand payment_url to the HUMAN — this server never charges anyone. ' +
      'Availability was verified at creation time and, in most stacks, an order does not hold ' +
      'stock: if the human takes a day to pay, re-check before promising delivery.',
  };
}

// ──────────────────────── subscribe_stock_alert ────────────────────────

function confirmBaseUrl(): string {
  const explicit = process.env.STOCK_ALERT_CONFIRM_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const site = (process.env.NEXT_PUBLIC_SITE_URL || 'https://example.com').replace(/\/$/, '');
  return `${site}/api/stock-alert/confirm`;
}

/**
 * Start — and only start — a back-in-stock subscription.
 *
 * A public tool that emails an address chosen by the caller is a mail cannon
 * aimed at third parties: loop tools/call with {email: someone@company.com,
 * slug: <anything>} and you have thousands of perfectly legitimate-looking
 * messages leaving your domain, burning your sending reputation, hitting a
 * person who never contacted the store. Four filters stand in front of the
 * send, and the subscription itself never activates here:
 *
 *  1. PRECONDITION: the product must actually be unavailable. This is the only
 *     situation where the message means anything, and it doubles as a fix for
 *     the "it's back!" email a cron sends about a product that never left.
 *  2. DEDUPE on (recipient, product), evaluated at the point the email is
 *     sent, not at the point state is written — an idempotent INSERT protects
 *     nothing when the expensive, irreversible effect happens before it. If
 *     the dedupe lookup FAILS, nothing is sent: a backend that is down must
 *     never become permission to emit.
 *  3. A QUOTA KEYED BY RECIPIENT, independent of the caller quota. IPs rotate
 *     and, on serverless, split across instances; the mailbox being harmed
 *     does neither. Key the limit to the resource you are protecting.
 *  4. DOUBLE OPT-IN with a signed token. This tool never activates anything —
 *     at most one confirmation email goes out, and a human has to act on it.
 *
 * The token and the confirmation URL are deliberately NOT in the response.
 * They travel only inside the email, because an agent holding the token could
 * confirm on the human's behalf, which would make the whole flow theatre.
 */
export async function subscribeStockAlertTool(
  args: Record<string, unknown>,
  ctx: CallContext,
): Promise<unknown> {
  const { catalog, notify, inventory } = getAdapters();
  const mode = stockAlertMode();

  if (mode === 'off' || !notify) {
    throw new ToolCallError(-32601, 'subscribe_stock_alert is not available on this deployment');
  }

  spendSharedQuota(ctx);

  const email = cleanEmail(args.email);
  if (!email) {
    return { sent: false, mode, error: 'invalid_email', message: 'A valid email address is required.' };
  }
  const slug = typeof args.slug === 'string' ? args.slug.trim() : '';
  if (!slug) {
    return { sent: false, mode, error: 'slug_required', message: 'slug is required.' };
  }
  const sku = typeof args.sku === 'string' && args.sku.trim() ? args.sku.trim() : undefined;
  const ref: LineRef & { slug: string } = sku ? { slug, sku } : { slug };

  const product = await catalog.getProduct(slug);
  if (!product) {
    return { sent: false, mode, error: 'product_not_found', slug };
  }

  // ── FILTER 1: the product must be unavailable.
  const [avail] = await resolveAvailability(inventory, [ref]);
  let precondition: string;
  if (avail.verified && avail.units != null) {
    if (avail.units > 0) {
      return {
        sent: false,
        mode,
        error: 'product_in_stock',
        units_available: avail.units,
        url: product.url,
        message:
          'No alert was created and no email was sent: this product is in stock right now. ' +
          'Send the human to the URL above instead.',
      };
    }
    precondition = 'out_of_stock_verified';
  } else if (product.availability === 'out_of_stock') {
    // Stock is unverifiable, but the catalog says out of stock on its own.
    // Two independent sources would be better; one is the minimum.
    precondition = 'out_of_stock_per_catalog';
  } else {
    return {
      sent: false,
      mode,
      error: 'availability_unconfirmed',
      stock_note: avail.reason,
      message:
        'Nothing was sent. Availability could not be verified and the catalog does not list this ' +
        'product as out of stock either — with no source confirming it is unavailable, an alert ' +
        'would be mail to a stranger about a product that is on sale.',
    };
  }

  // ── FILTER 2: dedupe, fail-closed.
  let already: boolean;
  try {
    already = await notify.isSubscribed(email, ref);
  } catch (e) {
    return {
      sent: false,
      mode,
      error: 'dedupe_check_unavailable',
      message:
        `Nothing was sent: the subscription backend could not be queried (${(e as Error).message}), ` +
        'so a duplicate cannot be ruled out. Fail-closed by design.',
    };
  }
  if (already) {
    return {
      sent: false,
      mode,
      reason: 'already_subscribed',
      message: 'This address is already subscribed to this product. No email was sent.',
    };
  }

  // Double opt-in is mandatory, so a missing signing secret disables the tool
  // rather than downgrading it to "subscribe directly".
  if (!optInConfigured()) {
    return {
      sent: false,
      mode,
      error: 'opt_in_unavailable',
      message:
        'Back-in-stock alerts require confirmed opt-in, and this deployment has no signing secret ' +
        'configured (STOCK_ALERT_SIGNING_SECRET), so no confirmation link can be issued. Nothing ' +
        'was sent and nothing was subscribed — the tool refuses rather than skipping confirmation.',
    };
  }

  // ── FILTER 3: per-recipient quota. Spent only when a message really leaves,
  // so a dry run cannot silently burn a stranger's allowance.
  const quota = rateLimited(
    `alert-email:${email}`,
    ALERT_EMAIL_QUOTA.max,
    ALERT_EMAIL_QUOTA.windowMs,
    { consume: mode === 'live' },
  );
  if (quota.limited) {
    return {
      sent: false,
      mode,
      error: 'recipient_quota_exceeded',
      retry_after_s: quota.retry_after_s,
      message:
        `This address has already received ${ALERT_EMAIL_QUOTA.max} confirmation emails in the last ` +
        'hour. The quota is per RECIPIENT, not per caller — changing address, IP or session does not reset it.',
    };
  }

  if (mode === 'dry') {
    return {
      sent: false,
      mode: 'dry',
      would_send: {
        to: email,
        product: product.name,
        precondition,
        confirmation_required: true,
        expires_in_hours: OPT_IN_TTL_MS / 3_600_000,
      },
      message:
        'DRY RUN — every filter ran and passed, but no email left and nothing was subscribed. In ' +
        'live mode this would send ONE confirmation email; the subscription would still only exist ' +
        'after the human confirms it. The operator turns it on with STOCK_ALERT_MODE=live.',
    };
  }

  const issued = issueOptInToken(email, ref);
  if (!issued) {
    return { sent: false, mode, error: 'opt_in_unavailable', message: 'No confirmation link could be issued.' };
  }

  await notify.sendOptInEmail({
    email,
    product_name: product.name,
    product_url: product.url,
    confirm_url: `${confirmBaseUrl()}?token=${encodeURIComponent(issued.token)}`,
    expires_at: issued.expires_at,
  });

  return {
    sent: true,
    mode: 'live',
    subscribed: false,
    confirmation_required: true,
    precondition,
    expires_at: issued.expires_at,
    message:
      'One confirmation email was sent. The subscription does NOT exist yet and will not exist ' +
      'until the human opens that email and confirms. Do not promise the customer they are ' +
      'subscribed — tell them to check their inbox. The confirmation link is intentionally not ' +
      'returned here: it is for the person who owns that mailbox, not for you.',
  };
}
