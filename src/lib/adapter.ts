// Adapter contracts: the seam between the MCP protocol layer and YOUR data.
//
// The route (src/app/api/mcp/route.ts) never touches a database, a file or an
// HTTP API directly. It only talks to these interfaces:
//
//   - CatalogAdapter   → public storefront data. Anything here is visible to
//     ANY anonymous agent on the internet. Treat it like your public website.
//   - OpsAdapter       → back-office data (revenue, orders, exact stock).
//     Only reachable with a valid Bearer token (env MCP_SECRET).
//   - InventoryAdapter → how many units you can actually sell right now.
//   - CheckoutAdapter  → creates a real order.
//   - NotifyAdapter    → back-in-stock subscriptions (double opt-in).
//
// The last three are OPTIONAL and drive the write tools. A deployment that
// does not implement them does not break: the corresponding tools are simply
// never announced in tools/list (see visibleTools in src/lib/protocol.ts).
//
// To plug in your own store, implement CatalogAdapter (and optionally the
// rest) and register it in src/lib/adapters/index.ts.

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
 * A "variant chart": one product line whose real inventory lives per-variant
 * (per color, per size, per grit...). This is the kind of tool a generic
 * platform MCP will never generate for you, because it needs your domain
 * knowledge: which codes exist, how they map to SKUs, what stock each one
 * has right now.
 */
export interface ColorCard {
  slug: string;
  brand_name: string;
  product_name: string;
  base_price: number | null;
  currency: string;
  url?: string;
  /** false when the stock backend could not be reached: variants then carry stock: null. */
  stock_verified: boolean;
  colors: ColorVariant[];
}

export interface ColorVariant {
  code: string;
  name: string;
  sku: string | null;
  hex: string | null;
  /** null = unknown (unmapped variant or stock backend down). Never invent a number. */
  stock: number | null;
  available: boolean | null;
}

export interface BrandSummary {
  slug: string;
  brand_name: string;
  product_name: string;
  colors_total: number;
  base_price: number | null;
  currency: string;
  url?: string;
}

export interface QuoteItem {
  slug?: string;
  sku?: string;
  qty: number;
}

export interface Quote {
  items: Array<{
    slug?: string;
    sku?: string;
    name: string;
    qty: number;
    unit_price: number;
    line_total: number;
  }>;
  /** Items that could not be resolved or are out of stock. */
  rejected: Array<{ slug?: string; sku?: string; reason: string }>;
  subtotal: number;
  currency: string;
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
}

/**
 * OPTIONAL. The single source of truth for "how many units are there".
 *
 * It must be the SAME source the read tools use (get_color_card,
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
}

/** One priced line of an order. Prices are computed server-side, always. */
export interface CheckoutLine extends LineRef {
  name: string;
  qty: number;
  unit_price: number;
  line_total: number;
}

/**
 * What the protocol layer hands to a CheckoutAdapter. By the time this exists,
 * the guard rails already ran: quantities are valid integers, duplicate lines
 * are consolidated, every line was priced from the catalog, and every line was
 * verified against the inventory source. The adapter does NOT re-decide any of
 * that — it persists the order and returns a payment link.
 */
export interface CheckoutDraft {
  lines: CheckoutLine[];
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
}

export interface CheckoutReceipt {
  /** Short public id (e.g. "AB-3F2K9") — never the internal DB id. */
  order_short_id: string;
  total: number;
  currency: string;
  /** Link the agent hands to the HUMAN so they can pay. */
  payment_url?: string | null;
  note?: string;
}

/**
 * OPTIONAL. Creates a real order. Implementing this is what turns the server
 * from read-only into something that can cost you money, so it is gated twice:
 * the tool only exists when this adapter AND an InventoryAdapter are present,
 * and it only takes effect when CHECKOUT_MODE=live.
 *
 * Note for implementers: an order typically does NOT reserve stock. If that is
 * true for you, the availability check in the protocol layer is the only thing
 * standing between an agent loop and overselling.
 */
export interface CheckoutAdapter {
  createCheckout(draft: CheckoutDraft): Promise<CheckoutReceipt>;
}

/** The one message a caller-supplied address is allowed to receive. */
export interface OptInEmail {
  email: string;
  product_name: string;
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
}

// ───────────────────────── ops types (gated) ─────────────────────────

export interface StockRow {
  sku: string;
  found: boolean;
  name?: string;
  brand?: string | null;
  stock_available?: number;
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

/** Public storefront. Everything here is world-readable by design. */
export interface CatalogAdapter {
  searchProducts(query: string, limit: number): Promise<SearchResult>;
  getProduct(slug: string): Promise<Product | null>;
  listBrands(): Promise<BrandSummary[]>;
  /** Return null when the slug does not resolve to a known chart. */
  getColorCard(brand: string): Promise<ColorCard | null>;
  getPromotions(limit: number, brand?: string): Promise<{ total: number; promotions: SearchHit[] }>;
  getQuote(items: QuoteItem[], ref?: string): Promise<Quote>;
}

/**
 * Back office. OPTIONAL: if your deployment does not provide an OpsAdapter,
 * the sensitive tools respond with an error even to authenticated callers.
 * Implementations MUST anonymize customer PII (see OrderDetail).
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
 *   ops       → the 5 back-office tools answer (they still need the token).
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
