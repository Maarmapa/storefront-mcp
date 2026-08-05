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

import type {
  CheckoutDraft,
  CheckoutLine,
  LineRef,
  MoneyLine,
  Quote,
  ReservationResult,
} from './adapter';
import { getAdapters } from './adapters';
import { blocksWrite, poolKey, refKey, resolveAvailability } from './availability';
import { MAX_UNITS_PER_PRODUCT, normalizeCart } from './cart';
import { cleanEmail, mailboxKey } from './email';
import { RATE_LIMITED_CODE, ToolCallError } from './errors';
import { moneyEquals, roundMoney, sumMoney } from './money';
import { confirmUrlBase, issueOptInToken, OPT_IN_TTL_MS, optInConfigured } from './optin';
import {
  ALERT_EMAIL_QUOTA,
  OPT_IN_PENDING_WINDOW_MS,
  rateLimited,
  UNATTRIBUTED_WRITE_QUOTA,
  WRITE_TOOL_QUOTA,
} from './ratelimit';
import { checkoutMode, stockAlertMode, unreservedCheckoutPolicy } from './write-mode';

/** Who is calling, for quota purposes. Filled in by each transport. */
export interface CallContext {
  /** Resolved caller identity, or a shared key when callers are indistinguishable. */
  clientKey: string;
  /**
   * True when `clientKey` really identifies ONE caller and that caller cannot
   * choose it. False turns the per-caller quota into a process-wide ceiling —
   * and every message about the quota then says so, because a limit described
   * as per-caller when it is not teaches an agent the wrong retry strategy.
   */
  attributed: boolean;
}

export const DEFAULT_CONTEXT: CallContext = { clientKey: 'unattributed', attributed: false };

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
function quotaError(ctx: CallContext, max: number, retryAfterS: number): ToolCallError {
  const scope = ctx.attributed
    ? `${max} calls per minute per caller`
    : `${max} calls per minute for this server instance (this deployment cannot tell callers ` +
      `apart, so the ceiling is shared by everyone rather than per caller)`;
  return new ToolCallError(
    RATE_LIMITED_CODE,
    `Rate limit reached: ${scope}, SHARED between create_checkout and subscribe_stock_alert ` +
      `(the quota is common to both, not per tool). Retry in ${retryAfterS}s. Do not loop — ` +
      `retrying faster makes it worse.`,
  );
}

function spendSharedQuota(ctx: CallContext): void {
  const quota = ctx.attributed ? WRITE_TOOL_QUOTA : UNATTRIBUTED_WRITE_QUOTA;
  const key = ctx.attributed ? `write:${ctx.clientKey}` : 'write:unattributed';
  const v = rateLimited(key, quota.max, quota.windowMs);
  if (v.limited) throw quotaError(ctx, quota.max, v.retry_after_s);
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
 *     request, AND is reconciled: the quantity priced must be the quantity
 *     requested and unit_price × qty must equal line_total. A pricing source
 *     that quietly trims 40 units to 10 would otherwise create an order for 40
 *     charged as 10.
 *  2. LINES ARE CONSOLIDATED BEFORE ANY LIMIT OR STOCK CHECK — and consolidated
 *     BY UNIT POOL, not by spelling. Twenty lines of 50 for one SKU is a
 *     thousand units; so is one line by slug plus one line by SKU for the same
 *     product, which is the version that survives a naive dedupe.
 *  3. INVALID QUANTITIES ARE REJECTED, NEVER REPAIRED.
 *  4. FAIL-CLOSED AVAILABILITY. Not enough units, or units that cannot be
 *     verified, and nothing is created.
 *  5. UNITS ARE HELD BEFORE THE ORDER EXISTS, when the inventory adapter can
 *     hold them. Point 4 is a check, and a check describes the past: ten
 *     concurrent calls all read "4 left", all pass, and all create an order.
 *     Only an atomic reservation closes that, so live mode either reserves or
 *     refuses (see CHECKOUT_UNRESERVED).
 *  6. THE VERDICT SHIPS WITH ITS EVIDENCE. Every line comes back with
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
  if (mode === 'off' || !checkout || !inventory || !catalog.getQuote) {
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
    quote = await catalog.getQuote(cart.lines.map(l => ({ slug: l.slug, sku: l.sku, qty: l.qty })));
  } catch (e) {
    return {
      created: false,
      blocked: true,
      reason: 'pricing_unavailable',
      ...base,
      message: `The catalog could not price this cart: ${(e as Error).message}. Nothing was created.`,
    };
  }

  const currency = typeof quote.currency === 'string' && quote.currency.trim() ? quote.currency : '';
  if (!currency) {
    return {
      created: false,
      blocked: true,
      reason: 'pricing_unavailable',
      ...base,
      message: 'The catalog returned a quote with no currency. Nothing was created.',
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

  // ── POOLS: which lines consume the SAME pile of units.
  //
  // `{slug:'notebook-a4', qty:50}` and `{sku:'NB-A4', qty:50}` are two
  // spellings of one product in any store where a simple product has both a
  // page and a SKU. Keyed by spelling they are two lines of 50, each one
  // "fitting" inside 60 units and inside the 50-unit ceiling. Keyed by pool
  // they are 100 units of a product that has 60, which is what they are.
  interface Pool {
    id: string;
    qty: number;
    units: number | null;
    verified: boolean;
    reason?: string;
    lines: string[];
    refs: LineRef[];
  }
  const pools = new Map<string, Pool>();
  const poolIdByLine = new Map<string, string>();

  for (const l of cart.lines) {
    const avail = availByKey.get(l.key)!;
    const id = poolKey(avail);
    poolIdByLine.set(l.key, id);
    const existing = pools.get(id);
    if (!existing) {
      pools.set(id, {
        id,
        qty: l.qty,
        units: avail.units,
        verified: avail.verified,
        reason: avail.reason,
        lines: [l.key],
        refs: [{ slug: l.slug, sku: l.sku }],
      });
      continue;
    }
    existing.qty += l.qty;
    existing.lines.push(l.key);
    existing.refs.push({ slug: l.slug, sku: l.sku });
    // Rows for one pool should agree. When they do not, take the pessimistic
    // reading: an unverified row poisons the pool, and two different counts
    // resolve to the smaller one.
    if (!avail.verified) {
      existing.verified = false;
      existing.units = null;
      existing.reason = existing.reason ?? avail.reason;
    } else if (existing.verified && existing.units != null && avail.units != null) {
      existing.units = Math.min(existing.units, avail.units);
    }
  }

  const itemsOverUnitLimit: Array<{
    refs: LineRef[];
    qty_requested: number;
    limit: number;
    note?: string;
  }> = [];
  for (const pool of pools.values()) {
    if (pool.qty > MAX_UNITS_PER_PRODUCT) {
      itemsOverUnitLimit.push({
        refs: pool.refs,
        qty_requested: pool.qty,
        limit: MAX_UNITS_PER_PRODUCT,
        ...(pool.lines.length > 1
          ? { note: 'this total spans several lines that draw on the same stock' }
          : {}),
      });
    }
  }

  const unpooledLines = cart.lines.filter(l => !availByKey.get(l.key)?.pool).length;

  const lines = cart.lines.map(l => {
    const priced = pricedByKey.get(l.key);
    const avail = availByKey.get(l.key)!;
    const pool = pools.get(poolIdByLine.get(l.key)!)!;
    const sharesPool = pool.lines.length > 1;
    const blockers: string[] = [];

    if (pool.qty > MAX_UNITS_PER_PRODUCT) {
      blockers.push(
        `quantity ${pool.qty} for this product is over the per-product limit of ` +
          `${MAX_UNITS_PER_PRODUCT}` +
          (sharesPool
            ? ` (that is the total across the ${pool.lines.length} lines you sent that draw on the ` +
              `same stock, not one line)`
            : ' (this is the total for this product across every line you sent, not one line)'),
      );
    }

    if (!priced) {
      blockers.push(catalogRejection.get(l.key) ?? 'the catalog did not return a price for this line');
    } else {
      // ── RECONCILIATION. The catalog answered a question; check that it
      // answered the one that was asked. A quote is allowed to reject a line
      // ("out of stock", "unknown sku"), and it is allowed to clamp a sloppy
      // quantity — but a clamped quote must not become an order, because the
      // qty travels from the CART and the money travels from the QUOTE, and
      // nothing else in the pipeline compares them.
      if (!Number.isFinite(priced.unit_price) || priced.unit_price < 0) {
        blockers.push('the catalog returned an invalid unit price for this line');
      } else if (priced.qty !== l.qty) {
        blockers.push(
          `the catalog priced ${priced.qty} unit(s) but ${l.qty} were requested — a quote that ` +
            `silently changes the quantity cannot become an order. Re-send with a quantity the ` +
            `catalog will price in full.`,
        );
      } else if (!moneyEquals(priced.unit_price * priced.qty, priced.line_total, currency)) {
        blockers.push(
          `the catalog's line total (${priced.line_total}) does not match unit_price × qty ` +
            `(${roundMoney(priced.unit_price * priced.qty, currency)}). Nothing is created on a ` +
            `pricing disagreement.`,
        );
      }
    }

    if (blocksWrite(pool, pool.qty)) {
      blockers.push(
        pool.units == null
          ? `availability could not be verified (${pool.reason ?? 'unknown reason'}) — an unverifiable ` +
            `line blocks the order exactly like an out-of-stock one`
          : `only ${pool.units} unit(s) available and ${pool.qty} requested` +
            (sharesPool ? ' across the lines that share this stock' : ''),
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
      stock_available: pool.units,
      stock_verified: pool.verified,
      ...(pool.reason ? { stock_note: pool.reason } : {}),
      ...(sharesPool
        ? {
            shares_stock_with: pool.refs.filter(
              r => !(r.slug === l.slug && r.sku === l.sku),
            ),
            units_requested_from_this_stock: pool.qty,
          }
        : {}),
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

  const subtotal = sumMoney(
    lines.map(l => (l.unit_price == null ? 0 : l.unit_price * l.qty_requested)),
    currency,
  );

  const detail = {
    ...base,
    ...(itemsOverUnitLimit.length > 0 ? { items_over_unit_limit: itemsOverUnitLimit } : {}),
    ...(unpooledLines > 0
      ? {
          stock_identity_note:
            `${unpooledLines} line(s) came back from the inventory source without a stock-pool ` +
            'identity, so lines written as a slug and lines written as a sku could not be proven ' +
            'to be the same product. They were treated as separate stock. If your adapter can ' +
            'resolve that identity, return AvailabilityRow.pool.',
        }
      : {}),
  };

  if (emailInvalid) {
    return {
      created: false,
      blocked: true,
      reason: 'invalid_customer_email',
      ...detail,
      lines,
      message: 'customer_email is not a valid address. Nothing was created.',
    };
  }

  if (anyLineBlocked || anyInputRejected) {
    return {
      created: false,
      blocked: true,
      reason: anyLineBlocked ? 'guard_rails_blocked' : 'invalid_items_present',
      ...detail,
      lines,
      subtotal: null,
      currency,
      message:
        (mode === 'dry' ? 'DRY RUN, but read this as a real refusal: ' : '') +
        'nothing was created. Fix the lines flagged below and call again — the per-line ' +
        'stock_available figures tell you exactly what fits. Partial orders are never created.',
    };
  }

  const canReserve = typeof inventory.reserve === 'function';

  if (mode === 'dry') {
    return {
      created: false,
      blocked: false,
      ...detail,
      lines,
      subtotal,
      currency,
      would_create: {
        lines: lines.length,
        units: lines.reduce((s, l) => s + l.qty_requested, 0),
        subtotal,
        currency,
        stock_would_be_reserved: canReserve,
      },
      message:
        'DRY RUN — every guard rail ran and this cart PASSED, but nothing was created and no ' +
        'payment link exists. In live mode this call would create the order above. The operator ' +
        'turns it on with CHECKOUT_MODE=live.' +
        (canReserve
          ? ''
          : ' Note for the operator: this inventory adapter cannot reserve units, so live mode ' +
            'would refuse this order unless CHECKOUT_UNRESERVED=allow is set.'),
    };
  }

  // ── LIVE. Hold the units BEFORE the order exists, or refuse.
  //
  // Everything above is a check, and a check describes the past. Ten
  // concurrent calls each read "4 units left", each pass every guard rail, and
  // each create an order: 40 sold against 4, no rule broken. Only an atomic
  // decrement at the inventory source can prevent that, so a deployment whose
  // adapter cannot do it does not get to pretend otherwise.
  let reservationId: string | undefined;
  if (canReserve) {
    const reservationRef = `co_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    let result: ReservationResult;
    try {
      result = await inventory.reserve!({
        lines: cart.lines.map(l => ({ slug: l.slug, sku: l.sku, qty: l.qty })),
        ref: reservationRef,
      });
    } catch (e) {
      return {
        created: false,
        blocked: true,
        reason: 'reservation_unavailable',
        ...detail,
        lines,
        currency,
        message:
          `Nothing was created: the inventory source could not hold these units ` +
          `(${(e as Error).message}). Fail-closed by design — an order that cannot hold stock is ` +
          'an oversell waiting for the next concurrent call.',
      };
    }
    if (!result.ok) {
      return {
        created: false,
        blocked: true,
        reason: 'stock_conflict',
        ...detail,
        lines,
        currency,
        conflicts: result.conflicts,
        message:
          'Nothing was created: between the availability check and the hold, these units stopped ' +
          'being available — usually because another order took them. The conflicts list shows ' +
          'what is actually left. Adjust quantities and call again.',
      };
    }
    reservationId = result.reservation_id;
  } else if (unreservedCheckoutPolicy() === 'refuse') {
    return {
      created: false,
      blocked: true,
      reason: 'cannot_hold_stock',
      ...detail,
      lines,
      currency,
      message:
        'Nothing was created. This deployment has no way to HOLD units: its inventory adapter ' +
        'does not implement reserve(), so nothing stops two simultaneous calls from selling the ' +
        'same units twice. The availability check above passed, and it is not enough on its own. ' +
        'The operator either implements InventoryAdapter.reserve or accepts the risk explicitly ' +
        'with CHECKOUT_UNRESERVED=allow.',
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
        line_total: roundMoney((l.unit_price ?? 0) * l.qty_requested, currency),
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
    ...(reservationId ? { reservation_id: reservationId } : {}),
  };

  let receipt;
  try {
    receipt = await checkout.createCheckout(draft);
  } catch (e) {
    // The hold outlives the order that motivated it unless we say otherwise.
    if (reservationId && typeof inventory.release === 'function') {
      try {
        await inventory.release(reservationId);
      } catch {
        // Best effort: a leaked hold is a stock discrepancy, not a wrong sale,
        // and it must not mask the real error below.
      }
    }
    return {
      created: false,
      blocked: true,
      reason: 'checkout_failed',
      ...detail,
      lines,
      currency,
      message:
        `Nothing was created: the checkout backend refused the order (${(e as Error).message}).` +
        (reservationId ? ' The stock hold was released.' : ''),
    };
  }

  // The adapter owns tax, shipping and discounts, so its total is allowed to
  // differ from the line subtotal — but the agent is about to read a number
  // out loud to a person, so the difference is named rather than left as two
  // contradictory figures in one response.
  const charges: MoneyLine[] = receipt.charges ?? [];
  const totalCharged = Number.isFinite(receipt.total) ? receipt.total : subtotal;
  const totalDiffers = !moneyEquals(totalCharged, subtotal, currency);

  const totalNote = !totalDiffers
    ? ''
    : `The amount to pay (${totalCharged}) differs from the line subtotal (${subtotal}) because ` +
      'the checkout backend applied tax, shipping or a discount; quote amount_to_pay to the ' +
      'customer, not the subtotal. ' +
      (charges.length > 0
        ? 'The `charges` array explains the difference. '
        : 'It did not itemize the difference. ');

  const holdNote = reservationId
    ? 'The units are held for this order.'
    : 'NOTE: these units are NOT held — this deployment runs with CHECKOUT_UNRESERVED=allow, so ' +
      'a simultaneous order can take the same stock. Re-check before promising delivery.';

  return {
    created: true,
    blocked: false,
    ...detail,
    order: receipt,
    lines,
    subtotal,
    ...(charges.length > 0 ? { charges } : {}),
    amount_to_pay: totalCharged,
    currency,
    ...(reservationId ? { stock_reserved: true, reservation_id: reservationId } : {}),
    message:
      'Order created. Hand payment_url to the HUMAN — this server never charges anyone. ' +
      totalNote +
      holdNote,
  };
}

// ──────────────────────── subscribe_stock_alert ────────────────────────

/**
 * Start — and only start — a back-in-stock subscription.
 *
 * A public tool that emails an address chosen by the caller is a mail cannon
 * aimed at third parties: loop tools/call with {email: someone@company.com,
 * slug: <anything>} and you have thousands of perfectly legitimate-looking
 * messages leaving your domain, burning your sending reputation, hitting a
 * person who never contacted the store. Five filters stand in front of the
 * send, and the subscription itself never activates here:
 *
 *  1. PRECONDITION: the product must actually be unavailable. This is the only
 *     situation where the message means anything, and it doubles as a fix for
 *     the "it's back!" email a cron sends about a product that never left.
 *  2. DEDUPE on (recipient, product), evaluated at the point the email is
 *     sent, not at the point state is written — an idempotent INSERT protects
 *     nothing when the expensive, irreversible effect happens before it. Two
 *     questions, not one: "is this mailbox already subscribed" (which an
 *     attacker never triggers, because they never confirm) and "did we already
 *     mail this mailbox about this product and hear nothing back", which is
 *     the one that stops three identical calls sending three emails. If either
 *     lookup FAILS, nothing is sent.
 *  3. A QUOTA KEYED BY MAILBOX, independent of the caller quota. IPs rotate
 *     and, on serverless, split across instances; the mailbox being harmed
 *     does neither. And the key is the canonical mailbox, not the string:
 *     victim+1@, victim+2@ and v.i.c.t.i.m@ are one inbox with one allowance.
 *  4. A REAL CONFIRMATION URL. No site URL configured means no send — a link
 *     to a domain the operator does not own is not a confirmation flow, it is
 *     a stranger's address in someone else's query string.
 *  5. DOUBLE OPT-IN with a signed token. This tool never activates anything —
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
  const recipientKey = mailboxKey(email);
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

  // ── FILTER 2a: already confirmed? Fail-closed.
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
        'Back-in-stock alerts require confirmed opt-in, and this deployment has no usable signing ' +
        'secret (STOCK_ALERT_SIGNING_SECRET must be set and at least 32 characters), so no ' +
        'confirmation link can be issued. Nothing was sent and nothing was subscribed — the tool ' +
        'refuses rather than skipping confirmation.',
    };
  }

  // ── FILTER 4: a confirmation URL that actually exists. Checked BEFORE the
  // send, because a confirmation email whose link goes nowhere is worse than
  // no email: the person got mail they did not ask for and cannot even opt out
  // of the flow it started.
  const confirmBase = confirmUrlBase();
  if (!confirmBase) {
    return {
      sent: false,
      mode,
      error: 'confirm_url_unconfigured',
      message:
        'Nothing was sent. No confirmation page is configured (set STOCK_ALERT_CONFIRM_URL, or ' +
        'NEXT_PUBLIC_SITE_URL if you deploy the bundled confirmation route). Sending a ' +
        'confirmation link to a domain this deployment does not control would put the ' +
        "recipient's own address in a stranger's query string, so the tool refuses.",
    };
  }

  // ── FILTERS 2b + 3: pending-send dedupe and the per-mailbox quota.
  const quotaCheck = await checkRecipientQuota(notify, recipientKey, ref, mode === 'live');
  if (quotaCheck.blocked) return { ...quotaCheck.response, mode };

  if (mode === 'dry') {
    return {
      sent: false,
      mode: 'dry',
      would_send: {
        to: email,
        recipient_key: recipientKey,
        product: product.name,
        ...(sku ? { variant_sku: sku } : {}),
        precondition,
        confirmation_required: true,
        expires_in_hours: OPT_IN_TTL_MS / 3_600_000,
      },
      quota_enforcement: quotaCheck.enforcement,
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
    recipient_key: recipientKey,
    product_name: product.name,
    product_slug: slug,
    ...(sku ? { variant_sku: sku } : {}),
    product_url: product.url,
    confirm_url: `${confirmBase}?token=${encodeURIComponent(issued.token)}`,
    expires_at: issued.expires_at,
  });

  return {
    sent: true,
    mode: 'live',
    subscribed: false,
    confirmation_required: true,
    precondition,
    ...(sku ? { variant_sku: sku } : {}),
    expires_at: issued.expires_at,
    quota_enforcement: quotaCheck.enforcement,
    message:
      'One confirmation email was sent. The subscription does NOT exist yet and will not exist ' +
      'until the human opens that email and confirms. Do not promise the customer they are ' +
      'subscribed — tell them to check their inbox. The confirmation link is intentionally not ' +
      'returned here: it is for the person who owns that mailbox, not for you.',
  };
}

/**
 * The two mailbox-scoped filters, in one place because they answer the same
 * question from two distances: "has this inbox heard from us about this
 * product already?" and "has this inbox heard from us too much, about
 * anything?".
 *
 * `durable` means the NotifyAdapter answered from its own storage, so the
 * limit survives a cold start, a redeploy and N instances. `best_effort`
 * means it came from the in-process counter, which survives none of those —
 * and that word travels all the way into the tool response rather than being
 * a footnote in a README.
 */
async function checkRecipientQuota(
  notify: NonNullable<ReturnType<typeof getAdapters>['notify']>,
  recipientKey: string,
  ref: LineRef,
  consume: boolean,
): Promise<
  | { blocked: false; enforcement: 'durable' | 'best_effort' }
  | { blocked: true; enforcement: 'durable' | 'best_effort'; response: Record<string, unknown> }
> {
  if (typeof notify.countOptInEmails === 'function') {
    const now = Date.now();
    try {
      const pending = await notify.countOptInEmails(
        recipientKey,
        new Date(now - OPT_IN_PENDING_WINDOW_MS),
        ref,
      );
      if (pending > 0) {
        return {
          blocked: true,
          enforcement: 'durable',
          response: {
            sent: false,
            reason: 'confirmation_already_pending',
            quota_enforcement: 'durable',
            message:
              'No email was sent: a confirmation for this product was already sent to this mailbox ' +
              'recently and nobody has acted on it yet. Ask the human to check their inbox — ' +
              'including spam — rather than requesting another one.',
          },
        };
      }
      const recent = await notify.countOptInEmails(
        recipientKey,
        new Date(now - ALERT_EMAIL_QUOTA.windowMs),
      );
      if (recent >= ALERT_EMAIL_QUOTA.max) {
        return {
          blocked: true,
          enforcement: 'durable',
          response: {
            sent: false,
            error: 'recipient_quota_exceeded',
            quota_enforcement: 'durable',
            message:
              `This mailbox has already received ${ALERT_EMAIL_QUOTA.max} confirmation emails in ` +
              'the last hour. The quota is per RECIPIENT MAILBOX — changing caller, IP, session, ' +
              'plus-tag or dots in the address does not reset it.',
          },
        };
      }
      return { blocked: false, enforcement: 'durable' };
    } catch (e) {
      return {
        blocked: true,
        enforcement: 'durable',
        response: {
          sent: false,
          error: 'quota_check_unavailable',
          message:
            `Nothing was sent: the per-recipient quota could not be evaluated (${(e as Error).message}). ` +
            'Fail-closed by design — a backend that is down must never become permission to email a ' +
            'stranger.',
        },
      };
    }
  }

  // Fallback: the in-process counter. Honest about what it is.
  const verdict = rateLimited(
    `alert-email:${recipientKey}`,
    ALERT_EMAIL_QUOTA.max,
    ALERT_EMAIL_QUOTA.windowMs,
    { consume },
  );
  if (verdict.limited) {
    return {
      blocked: true,
      enforcement: 'best_effort',
      response: {
        sent: false,
        error: 'recipient_quota_exceeded',
        retry_after_s: verdict.retry_after_s,
        quota_enforcement: 'best_effort',
        message:
          `This mailbox has already received ${ALERT_EMAIL_QUOTA.max} confirmation emails in the ` +
          'last hour on this server instance. The quota is per RECIPIENT MAILBOX and does not ' +
          'reset by changing caller, plus-tag or dots — but it IS counted in memory here, so it ' +
          'does not hold across instances or restarts. Implement NotifyAdapter.countOptInEmails ' +
          'to make it a real ceiling.',
      },
    };
  }
  return { blocked: false, enforcement: 'best_effort' };
}
