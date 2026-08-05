// Adapter contracts: the seam between the MCP protocol layer and YOUR data.
//
// The route (src/app/api/mcp/route.ts) never touches a database, a file or an
// HTTP API directly. It only talks to these interfaces:
//
//   - CatalogAdapter   → public storefront data. Anything here is visible to
//     ANY anonymous agent on the internet. Treat it like your public website.
//   - OpsAdapter       → back-office data (revenue, orders, exact stock).
//     Only reachable with a valid Bearer token (env MCP_SECRET).
//   - InventoryAdapter → how many units you can actually sell right now, and
//     (optionally but importantly) how to HOLD them.
//   - CheckoutAdapter  → creates a real order.
//   - NotifyAdapter    → back-in-stock subscriptions (double opt-in).
//
// Everything except CatalogAdapter is OPTIONAL, and so are four of the six
// catalog methods. Optionality is not politeness: a method you do not
// implement removes the matching tool from tools/list, so no agent is ever
// offered a tool this deployment has no honest way to answer.
//
// To plug in your own store, implement CatalogAdapter (two required methods)
// and register it in src/lib/adapters/index.ts.

// ───────────────────────── catalog types ─────────────────────────

export interface Product {
  slug: string;
  name: string;
  brand: string | null;
  category: string | null;
  price: number | null;
  currency: string;
  availability: 'in_stock' | 'out_of_stock' | 'unknown';
  description?: string;
  image?: string | null;
  /** Canonical public URL of the product page, if you have one. */
  url?: string;
}

export interface SearchHit {
  slug: string;
  name: string;
  brand: string | null;
  price: number | null;
  image?: string | null;
  url?: string;
}

export interface SearchResult {
  query: string;
  total: number;
  results: SearchHit[];
  /**
   * Optional free-text note for the agent, e.g. "results may be incomplete:
   * the search backend did not answer in time". Degrade, don't lie.
   */
  note?: string;
}

/**
 * A VARIANT CHART: one product line whose real inventory lives per-variant.
 *
 * The axis is whatever your catalog actually varies on — color, shade, size,
 * grit, roast, capacity, edition. The type is deliberately neutral about
 * which: `code` + `name` + `sku` describe any of them, and `swatch_hex` is an
 * OPTIONAL display hint for the charts that happen to be color charts.
 *
 * This is the kind of tool a generic platform MCP will never generate for
 * you, because it needs your domain knowledge: which codes exist, how they
 * map to SKUs, what stock each one has right now. If your catalog has no such
 * axis, do not implement it — `list_variant_charts` and `get_variant_chart`
 * then simply do not exist on your deployment.
 */
export interface VariantChart {
  slug: string;
  brand_name: string;
  product_name: string;
  base_price: number | null;
  currency: string;
  url?: string;
  /** false when the stock backend could not be reached: variants then carry stock: null. */
  stock_verified: boolean;
  /** What this chart varies on, for the agent's benefit: "color", "size", "grit"... */
  axis?: string;
  variants: Variant[];
}

export interface Variant {
  code: string;
  name: string;
  sku: string | null;
  /** OPTIONAL display hint, only meaningful for color-like axes. */
  swatch_hex?: string | null;
  /** null = unknown (unmapped variant or stock backend down). Never invent a number. */
  stock: number | null;
  available: boolean | null;
}

export interface VariantChartSummary {
  slug: string;
  brand_name: string;
  product_name: string;
  variants_total: number;
  base_price: number | null;
  currency: string;
  axis?: string;
  url?: string;
}

export interface QuoteItem {
  slug?: string;
  sku?: string;
  qty: number;
}

/**
 * One non-line amount on a total: tax, shipping, a discount, a surcharge.
 *
 * It exists because a money contract with only `subtotal` quietly assumes
 * tax-inclusive pricing and free shipping — true for some stores, false for
 * most of the EU and the US. Amounts are signed: a discount is negative.
 */
export interface MoneyLine {
  kind: 'tax' | 'shipping' | 'discount' | 'surcharge' | 'other';
  label: string;
  /** Signed, in the same currency as the rest of the document. */
  amount: number;
}

export interface Quote {
  items: Array<{
    slug?: string;
    sku?: string;
    name: string;
    /**
     * The quantity actually priced. MUST equal the qty that was requested for
     * this line: the checkout path reconciles the two and refuses when they
     * differ, because a quote that silently trims 40 units to 10 and reports
     * the price of 10 is how an order for 40 gets charged as 10.
     */
    qty: number;
    unit_price: number;
    /** MUST equal unit_price × qty at the currency's precision. Reconciled too. */
    line_total: number;
  }>;
  /** Items that could not be resolved, are out of stock, or asked for an unquotable qty. */
  rejected: Array<{ slug?: string; sku?: string; reason: string }>;
  /** Sum of line_total. Taxes/shipping/discounts do NOT belong here. */
  subtotal: number;
  currency: string;
  /** Tax, shipping, discounts. Omit when your prices really are final. */
  charges?: MoneyLine[];
  /** subtotal + charges. Omit when it equals subtotal. */
  total?: number;
  /**
   * Link the agent hands to the HUMAN to complete payment. The MCP server
   * never charges anyone: it quotes, the human pays through your normal flow.
   */
  payment_link?: string;
  note?: string;
}

// ───────────────────── commerce types (the write side) ─────────────────────

/**
 * How one line of a cart points at something sellable. `sku` wins when both
 * are present: a SKU is a specific variant, a slug is a product page.
 */
export interface LineRef {
  slug?: string;
  sku?: string;
}

/**
 * Real availability for one line — the answer to "how many units can I sell
 * RIGHT NOW", which is a different question from the catalog's `availability`
 * ("is this published and purchasable?"). In almost every e-commerce stack
 * those two questions are answered by two different systems (CMS/catalog vs.
 * ERP/POS/inventory), and confusing them is how a storefront oversells.
 *
 * Three states, not two:
 *   - { units: 12, verified: true }  → 12 units, checked.
 *   - { units: 0,  verified: true }  → sold out, checked.
 *   - { units: null, verified: false } → NOT VERIFIABLE. Unmapped variant, no
 *     row in the stock snapshot, backend down... The write path treats this
 *     exactly like sold out: before charging someone, "I don't know" and
 *     "there is none" are worth the same.
 *
 * `units: null` is never a fallback zero and never an optimistic guess.
 */
export interface AvailabilityRow extends LineRef {
  /** Sellable units right now. `null` means NOT VERIFIABLE — never invent a number. */
  units: number | null;
  verified: boolean;
  /** Why it could not be verified. Travels all the way to the agent. */
  reason?: string;
  /**
   * IDENTITY OF THE UNIT POOL this line draws from — the answer to "which
   * physical pile of stock does this consume?".
   *
   * Why the contract needs it: a plain product has a page AND a SKU over ONE
   * pile of units. `{slug:'notebook-a4'}` and `{sku:'NB-A4'}` are two
   * spellings of the same thing, so a server that treats them as two lines
   * checks 50 units against 60 twice and sells 100. Only the adapter can
   * resolve that identity — it is the only component that knows which slug
   * and which SKU are backed by the same row.
   *
   * Return a stable string per pile (an internal product/variant id is
   * ideal). Lines whose pool matches are summed before any limit or
   * availability check. Omit it ONLY when every ref you serve is already
   * canonical; when it is absent the caller falls back to the ref itself and
   * cannot catch cross-spelling collisions.
   */
  pool?: string;
}

/** One priced line of an order. Prices are computed server-side, always. */
export interface CheckoutLine extends LineRef {
  name: string;
  qty: number;
  unit_price: number;
  line_total: number;
}

/**
 * A request to HOLD units while an order is created.
 *
 * `ref` is an idempotency key: the protocol layer generates one per
 * create_checkout attempt and never reuses it, so a retried reservation is
 * the same reservation rather than a second hold.
 */
export interface ReservationRequest {
  lines: Array<LineRef & { qty: number }>;
  ref: string;
}

export type ReservationResult =
  | { ok: true; reservation_id: string }
  | {
      ok: false;
      /** Which lines could not be held, and how many were actually left. */
      conflicts: Array<LineRef & { requested: number; available: number | null; reason?: string }>;
    };

/**
 * OPTIONAL. The single source of truth for "how many units are there".
 *
 * It must be the SAME source the read tools use (get_variant_chart,
 * get_stock_bulk); a write path that checks a different source than the one it
 * shows the customer is a bug waiting for a busy Friday.
 *
 * Contract:
 *   - return one row per requested ref (order does not matter, the caller
 *     matches by slug/sku),
 *   - never invent numbers: unknown → `units: null, verified: false, reason`,
 *   - throwing is allowed; the caller degrades every line to "not verifiable"
 *     rather than assuming anything.
 */
export interface InventoryAdapter {
  getAvailability(refs: LineRef[]): Promise<AvailabilityRow[]>;

  /**
   * OPTIONAL, and the difference between a checkout that can oversell and one
   * that cannot.
   *
   * READ THIS BEFORE SKIPPING IT. `getAvailability` answers a question about
   * the past: it says what was true when it ran. Ten concurrent calls all read
   * "4 units left", all pass the check, and all create an order — 40 units
   * sold against 4, with every guard rail green. Nothing in a stateless check
   * can prevent that, because the check does not CHANGE anything. Only an
   * atomic decrement can.
   *
   * Implement it as one atomic operation against your stock source:
   *   UPDATE stock SET reserved = reserved + :qty
   *   WHERE id = :id AND (on_hand - reserved) >= :qty
   * and report `ok:false` with the conflicting lines when it does not apply to
   * every line. All-or-nothing: a partial hold is a cart nobody asked for.
   *
   * When this method is absent, `create_checkout` refuses to create live
   * orders unless the operator explicitly accepts the risk (see
   * CHECKOUT_UNRESERVED in src/lib/write-mode.ts). Dry mode always works.
   */
  reserve?(req: ReservationRequest): Promise<ReservationResult>;

  /**
   * OPTIONAL, and required for `reserve` to be safe: release a hold when the
   * order that motivated it could not be created. Without it a failed
   * checkout leaks units until your reservations expire.
   */
  release?(reservationId: string): Promise<void>;
}

/**
 * What the protocol layer hands to a CheckoutAdapter. By the time this exists,
 * the guard rails already ran: quantities are valid integers, duplicate lines
 * are consolidated (including across slug/sku spellings of the same pool),
 * every line was priced from the catalog and reconciled against its quote,
 * every line was verified against the inventory source, and — when the
 * inventory adapter can reserve — the units are already held.
 *
 * The adapter does NOT re-decide any of that. It persists the order, applies
 * whatever tax/shipping/discount its backend owns, and returns a payment link.
 */
export interface CheckoutDraft {
  lines: CheckoutLine[];
  /** Sum of line_total, computed server-side from the catalog. */
  subtotal: number;
  currency: string;
  /**
   * Caller-supplied and therefore UNVERIFIED: an agent typed it, not
   * necessarily the human who owns the mailbox. Store it on the order if you
   * must, but do not send it automated mail from here — see NotifyAdapter.
   */
  customer_email?: string;
  note?: string;
  ref?: string;
  /** Present when the inventory adapter held the units for this draft. */
  reservation_id?: string;
}

export interface CheckoutReceipt {
  /** Short public id (e.g. "AB-3F2K9") — never the internal DB id. */
  order_short_id: string;
  /**
   * What the human will actually be asked to pay. It MAY differ from
   * draft.subtotal — that is the whole point of the field — but when it does,
   * say why in `charges`, because the tool response shows both numbers to an
   * agent that will read them out loud to a person.
   */
  total: number;
  currency: string;
  /** Echo of the line subtotal you were given, if you want it in the receipt. */
  subtotal?: number;
  /** Tax, shipping, discounts: whatever explains total − subtotal. */
  charges?: MoneyLine[];
  /** Link the agent hands to the HUMAN so they can pay. */
  payment_url?: string | null;
  note?: string;
}

/**
 * OPTIONAL. Creates a real order. Implementing this is what turns the server
 * from read-only into something that can cost you money, so it is gated
 * three times: the tool only exists when this adapter AND an InventoryAdapter
 * are present, it only takes effect when CHECKOUT_MODE=live, and in live mode
 * it only runs when the units could be reserved (or the operator explicitly
 * accepted unreserved checkout).
 */
export interface CheckoutAdapter {
  createCheckout(draft: CheckoutDraft): Promise<CheckoutReceipt>;
}

/** The one message a caller-supplied address is allowed to receive. */
export interface OptInEmail {
  /** The address as typed (trimmed and lowercased). This is what you mail. */
  email: string;
  /**
   * Canonical identity of the MAILBOX behind that address — plus-tags removed
   * and, for providers that ignore them, dots removed. Persist this alongside
   * the send: it is the key `countOptInEmails` is asked about, and the reason
   * `victim+1@`, `victim+2@` and `v.i.c.t.i.m@` cannot each get their own
   * quota.
   */
  recipient_key: string;
  product_name: string;
  product_slug: string;
  /** Present when the alert is for one specific variant rather than the line. */
  variant_sku?: string;
  product_url?: string;
  /** Page where the human confirms. The page writes nothing on GET. */
  confirm_url: string;
  expires_at: string;
}

/**
 * OPTIONAL. Back-in-stock alerts, double opt-in only.
 *
 * The subscription NEVER becomes active from a tool call: the tool can, at
 * most, send one confirmation email to the address the caller typed. A public
 * tool that emails an address chosen by the caller is a mail cannon pointed at
 * third parties, so the protocol layer wraps this adapter in preconditions
 * (product must be out of stock, dedupe, per-recipient quota) before a single
 * message goes out.
 *
 * Contract:
 *   - `isSubscribed` may throw; the caller then refuses to send (fail-closed).
 *     A backend that is down must never become permission to emit email.
 *   - `confirmSubscription` must be idempotent: a human double-clicking the
 *     confirm button is a success, not an error.
 */
export interface NotifyAdapter {
  isSubscribed(email: string, ref: LineRef): Promise<boolean>;
  sendOptInEmail(msg: OptInEmail): Promise<void>;
  confirmSubscription(email: string, ref: LineRef): Promise<{ created: boolean }>;

  /**
   * OPTIONAL, and the only way the per-recipient quota is worth the name.
   *
   * How many opt-in emails have gone to this mailbox since `since`? Count
   * rows in YOUR storage, keyed by `recipient_key` (see OptInEmail) — that
   * makes the quota survive a cold start, a redeploy and N instances, which
   * an in-process counter does not.
   *
   * Pass `ref` to ask the narrower question "…about this product", which the
   * caller uses to avoid re-sending a confirmation nobody has acted on yet.
   *
   * May throw: the caller fails closed and sends nothing.
   *
   * Without it, the quota falls back to the in-memory limiter in
   * src/lib/ratelimit.ts, which is friction and not a ceiling — and the tool
   * response says so out loud instead of promising a limit it cannot hold.
   */
  countOptInEmails?(recipientKey: string, since: Date, ref?: LineRef): Promise<number>;
}

// ───────────────────────── ops types (gated) ─────────────────────────

export interface StockRow {
  sku: string;
  found: boolean;
  name?: string;
  brand?: string | null;
  /** Omitted entirely when the count could not be verified — never a phantom 0. */
  stock_available?: number;
  stock_verified?: boolean;
  /** Why the count is missing, when it is. */
  reason?: string;
  price?: number | null;
}

export interface TopProduct {
  name: string;
  sku: string | null;
  qty: number;
  revenue: number;
}

export interface OrderSummary {
  /** Short public id (e.g. "AB-3F2K9") — never the internal DB id. */
  short_id: string;
  status: string;
  total: number;
  items_count: number;
  created_at: string;
}

export interface OrderDetail extends Omit<OrderSummary, 'items_count'> {
  subtotal?: number;
  shipping?: number;
  /**
   * Line items WITHOUT customer PII. Name/qty/price only: no emails,
   * no addresses, no phone numbers. Keep it that way even behind auth.
   */
  items: Array<{ name?: string; qty?: number; unit_price?: number }>;
  paid_at?: string | null;
  dispatched_at?: string | null;
}

export interface SalesSummary {
  period_days: number;
  orders: number;
  total_revenue: number;
  avg_ticket: number;
  currency: string;
  top_5_brands_by_revenue: Array<{ brand: string; revenue: number; units_sold: number }>;
}

// ───────────────────────── the two contracts ─────────────────────────

/**
 * Public storefront. Everything here is world-readable by design.
 *
 * Only the first two methods are required. The rest are capabilities: each
 * one you leave out removes its tool from tools/list, which is why there is
 * no reason to write a stub that returns `[]` or `null` — a stub turns "this
 * store has no variant charts" into "this store has a variant chart tool that
 * never finds anything", and an agent cannot tell those apart.
 */
export interface CatalogAdapter {
  searchProducts(query: string, limit: number): Promise<SearchResult>;
  getProduct(slug: string): Promise<Product | null>;

  /** OPTIONAL → enables `get_promotions`. */
  getPromotions?(limit: number, brand?: string): Promise<{ total: number; promotions: SearchHit[] }>;

  /**
   * OPTIONAL → enables `get_quote`.
   *
   * Two rules the checkout path depends on:
   *   - echo the `slug`/`sku` you were given on each priced line,
   *   - price the qty you were ASKED for, or reject the line. Never quote a
   *     different quantity than the one requested; create_checkout compares
   *     them and refuses the whole cart when they disagree.
   */
  getQuote?(items: QuoteItem[], ref?: string): Promise<Quote>;

  /** OPTIONAL → enables `list_variant_charts` (announced together with the next one). */
  listVariantCharts?(): Promise<VariantChartSummary[]>;

  /** OPTIONAL → enables `get_variant_chart`. Return null when the slug does not resolve. */
  getVariantChart?(chart: string): Promise<VariantChart | null>;
}

/**
 * Back office. OPTIONAL: a deployment without an OpsAdapter does not announce
 * the five sensitive tools at all — not even to an authenticated caller,
 * because a tool that can only answer "not configured" is noise with a token
 * in front of it. Implementations MUST anonymize customer PII (see
 * OrderDetail).
 */
export interface OpsAdapter {
  getStockBulk(skus: string[]): Promise<{ results: StockRow[] }>;
  getTopProducts(days: number, limit: number): Promise<{ days: number; top: TopProduct[] }>;
  getRecentOrders(limit: number, status?: string): Promise<{ orders: OrderSummary[] }>;
  getOrderStatus(shortId: string): Promise<OrderDetail | null>;
  getSalesSummary(days: number): Promise<SalesSummary>;
}

/**
 * What a deployment actually provides. Only `catalog` is required.
 *
 * Every optional field is a capability, and capabilities decide which tools
 * exist at all — not a config flag that lies about what the server can do:
 *
 *   ops       → the 5 back-office tools are announced (to authorized callers).
 *   inventory → availability can be verified.
 *   checkout  → `create_checkout` is announced, but ONLY together with
 *               `inventory`: without an inventory source every call would be
 *               blocked by the fail-closed rule, and announcing a tool that
 *               can never succeed is worse than not announcing it.
 *   notify    → `subscribe_stock_alert` is announced.
 */
export interface StorefrontAdapters {
  catalog: CatalogAdapter;
  ops?: OpsAdapter;
  inventory?: InventoryAdapter;
  checkout?: CheckoutAdapter;
  notify?: NotifyAdapter;
}
