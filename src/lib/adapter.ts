// Adapter contracts: the seam between the MCP protocol layer and YOUR data.
//
// The route (src/app/api/mcp/route.ts) never touches a database, a file or an
// HTTP API directly. It only talks to these two interfaces:
//
//   - CatalogAdapter → public storefront data. Anything here is visible to
//     ANY anonymous agent on the internet. Treat it like your public website.
//   - OpsAdapter     → back-office data (revenue, orders, exact stock).
//     Only reachable with a valid Bearer token (env MCP_SECRET).
//
// To plug in your own store, implement CatalogAdapter (and optionally
// OpsAdapter) and register it in src/lib/adapters/index.ts.

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

export interface StorefrontAdapters {
  catalog: CatalogAdapter;
  ops?: OpsAdapter;
}
