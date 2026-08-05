// WooCommerce adapter SKELETON, built on the public Store API
// (https://developer.woocommerce.com/docs/apis/store-api/).
//
// The Store API is unauthenticated and read-only for catalog data, which maps
// perfectly onto CatalogAdapter: everything it can see is already public on
// your storefront. It intentionally does NOT implement OpsAdapter — order and
// revenue data require the authenticated WC REST API (consumer key/secret)
// and you should think twice before wiring that in at all.
//
// It also does NOT implement InventoryAdapter, CheckoutAdapter or
// NotifyAdapter, and that is a decision rather than an omission. Consequence,
// by design: with CATALOG_ADAPTER=woocommerce the write tools are never
// announced. An agent talking to this adapter cannot create an order, because
// nothing here can answer "how many units are there" — and a checkout tool
// without an inventory source is an oversell tool with extra steps.
//
// The TODO blocks at the bottom of this file describe what each contract needs
// from a WooCommerce install. They are intentionally not half-implemented:
// guessing at somebody else's stock semantics is precisely the failure this
// template is about.
//
// Env vars:
//   WOO_BASE_URL   e.g. https://shop.example.com  (no trailing slash)
//   STORE_CURRENCY e.g. USD | EUR                 (default USD)

import type {
  BrandSummary,
  CatalogAdapter,
  ColorCard,
  Product,
  Quote,
  QuoteItem,
  SearchHit,
  SearchResult,
} from '../adapter';

const BASE = (process.env.WOO_BASE_URL || '').replace(/\/$/, '');
const CURRENCY = process.env.STORE_CURRENCY || 'USD';

/** Per-request budget: an agent-facing tool must answer or fail fast, never hang. */
const FETCH_TIMEOUT_MS = 5000;

interface WooStoreProduct {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  description?: string;
  short_description?: string;
  sku?: string;
  prices?: { price: string; currency_minor_unit: number; currency_code: string };
  is_in_stock?: boolean;
  images?: Array<{ src: string }>;
  categories?: Array<{ name: string; slug: string }>;
  brands?: Array<{ name: string; slug: string }>;
  on_sale?: boolean;
}

async function wooFetch<T>(pathname: string): Promise<T> {
  if (!BASE) throw new Error('WOO_BASE_URL is not set');
  const res = await fetch(`${BASE}/wp-json/wc/store/v1${pathname}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Store API ${res.status} for ${pathname}`);
  return (await res.json()) as T;
}

function minorToMajor(p?: WooStoreProduct['prices']): number | null {
  if (!p) return null;
  const n = Number(p.price);
  if (!Number.isFinite(n)) return null;
  return n / Math.pow(10, p.currency_minor_unit ?? 2);
}

function toHit(p: WooStoreProduct): SearchHit {
  return {
    slug: p.slug,
    name: p.name,
    brand: p.brands?.[0]?.name ?? null,
    price: minorToMajor(p.prices),
    image: p.images?.[0]?.src ?? null,
    url: p.permalink,
  };
}

export class WooCommerceCatalogAdapter implements CatalogAdapter {
  async searchProducts(query: string, limit: number): Promise<SearchResult> {
    try {
      const items = await wooFetch<WooStoreProduct[]>(
        `/products?search=${encodeURIComponent(query)}&per_page=${limit}`,
      );
      return { query, total: items.length, results: items.map(toHit) };
    } catch (e) {
      // Degrade, don't lie: an empty result with a note beats a hung agent.
      return {
        query,
        total: 0,
        results: [],
        note: `search backend unavailable: ${(e as Error).message}`,
      };
    }
  }

  async getProduct(slug: string): Promise<Product | null> {
    const items = await wooFetch<WooStoreProduct[]>(`/products?slug=${encodeURIComponent(slug)}`);
    const p = items[0];
    if (!p) return null;
    return {
      slug: p.slug,
      name: p.name,
      brand: p.brands?.[0]?.name ?? null,
      category: p.categories?.[0]?.slug ?? null,
      price: minorToMajor(p.prices),
      currency: p.prices?.currency_code ?? CURRENCY,
      availability: p.is_in_stock == null ? 'unknown' : p.is_in_stock ? 'in_stock' : 'out_of_stock',
      description: p.short_description || p.description,
      image: p.images?.[0]?.src ?? null,
      url: p.permalink,
    };
  }

  async listBrands(): Promise<BrandSummary[]> {
    // TODO: WooCommerce has no native "color card" concept. Options:
    //  a) map product attribute taxonomies (pa_color) per brand into charts,
    //  b) keep a static JSON in your repo mapping brand → variants (what the
    //     original implementation behind this template does),
    //  c) return [] and drop get_color_card/list_brands from TOOLS.
    return [];
  }

  async getColorCard(_brand: string): Promise<ColorCard | null> {
    // TODO: resolve the chart (see listBrands) and, if you track per-variant
    // stock somewhere (ERP, POS, a stock snapshot table), join it here.
    // Contract reminder: when the stock source cannot be reached, return the
    // chart with stock_verified:false and stock:null on every color — never
    // invent availability for a variant you did not verify.
    return null;
  }

  async getPromotions(limit: number, brand?: string): Promise<{ total: number; promotions: SearchHit[] }> {
    const items = await wooFetch<WooStoreProduct[]>(`/products?on_sale=true&per_page=${limit}`);
    let promos = items;
    if (brand) {
      const b = brand.toLowerCase();
      promos = promos.filter(p => (p.brands?.[0]?.name ?? '').toLowerCase().includes(b));
    }
    return { total: promos.length, promotions: promos.map(toHit) };
  }

  async getQuote(items: QuoteItem[], _ref?: string): Promise<Quote> {
    // TODO: three viable strategies, in increasing order of effort:
    //  1) Resolve each slug via getProduct(), sum prices, and return your
    //     cart URL as payment_link (e.g. `${BASE}/cart/?add-to-cart=<id>`).
    //  2) Use the Store API cart endpoints (POST /cart/add-item) with a
    //     Cart-Token to build a real cart server-side.
    //  3) Call your own checkout/quote endpoint if you already have one.
    // Keep the invariant: this tool NEVER charges. It quotes and returns a
    // link for the human to pay.
    const rejected = items.map(it => ({
      slug: it.slug,
      sku: it.sku,
      reason: 'get_quote not implemented for the WooCommerce adapter yet',
    }));
    return {
      items: [],
      rejected,
      subtotal: 0,
      currency: CURRENCY,
      note: 'TODO: implement getQuote (see comments in woocommerce.ts).',
    };
  }
}

// ───────────────────── TODO: the write-side contracts ─────────────────────
//
// Nothing below is implemented. Each block says what the contract needs and
// which WooCommerce-specific decision only you can make. Implement one, export
// it, and register it in src/lib/adapters/index.ts — the matching tool starts
// being announced the moment the capability exists.
//
// ── InventoryAdapter (implement this FIRST; create_checkout requires it) ──
//
// Needs: units sellable RIGHT NOW per slug/sku, plus an honest "I don't know".
//
//   - `is_in_stock` from the Store API is a BOOLEAN, not a count. It cannot
//     satisfy this contract on its own: it answers "purchasable?", and this
//     contract answers "how many?". Do not map true → some large number.
//   - `stock_quantity` exists on the authenticated WC REST API
//     (/wp-json/wc/v3/products), but only when "Manage stock" is enabled on
//     that product or variation. When stock management is OFF, the correct
//     answer is `{units: null, verified: false, reason: 'stock management is
//     disabled for this product'}` — NOT a number you inferred.
//   - Variations live at /products/<id>/variations and have their own
//     stock_quantity; a parent-level number is meaningless for a variant SKU.
//   - Whatever source you pick, SUBTRACT what is already committed elsewhere
//     (unpaid orders on hold, picking lists, another sales channel). "On the
//     shelf" is not "sellable to this customer", and the gap between the two
//     is where overselling lives.
//   - It is fine to throw on a backend failure: resolveAvailability() turns a
//     throw into every line being unverifiable, which blocks writes. Returning
//     zeros or optimistic guesses is the only wrong answer.
//
// ── CheckoutAdapter ──
//
// Needs: persist an order from an ALREADY-VALIDATED draft and return a payment
// link. Do not re-decide quantities or re-price: the protocol layer priced
// every line from the catalog and verified every line against inventory.
//
//   - Option A: Store API cart endpoints (POST /cart/add-item with a
//     Cart-Token, then hand the human /checkout). No admin credentials.
//   - Option B: authenticated WC REST API POST /orders with status
//     "pending"/"on-hold", then return the order's payment URL.
//   - Note whether your setup reserves stock at order creation. In stock
//     WooCommerce, "hold stock (minutes)" only applies to unpaid orders with
//     stock management on; assume NO reservation unless you verified it, and
//     say so in the receipt note.
//   - Emails: send to the OPERATOR at a fixed address you configure. The
//     customer_email on the draft was typed by an agent, so the customer's
//     own confirmation belongs on the payment webhook, where there is finally
//     evidence that the human exists and wanted this.
//
// ── NotifyAdapter ──
//
// Needs: isSubscribed / sendOptInEmail / confirmSubscription.
//
//   - Store subscriptions in your own table with a UNIQUE index on
//     (email, product_ref), and treat a unique-violation on insert as SUCCESS
//     so confirmation stays idempotent.
//   - `isSubscribed` must be allowed to throw rather than returning false on
//     error: the caller fails closed and sends nothing, which is the point.
//   - sendOptInEmail is the only message this flow may send to a
//     caller-supplied address. wp_mail() will work; a real ESP is better,
//     because you will want delivery logs the day someone asks why they got
//     mail from your shop.
//   - Set STOCK_ALERT_CONFIRM_URL to the page that serves the confirmation
//     (see src/app/api/stock-alert/confirm/route.ts) and keep the rule that
//     page enforces: GET renders, POST writes.
