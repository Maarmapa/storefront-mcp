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
// THE SAME RULE APPLIES TO READ TOOLS, and it did not used to. This file once
// carried three stubs — `listBrands` returning `[]`, `getColorCard` returning
// `null`, `getQuote` rejecting every line — because the CatalogAdapter
// interface demanded six methods. The effect was that a WooCommerce
// deployment announced three tools to every anonymous agent that could never
// answer anything: a chart list that is always empty, a chart lookup that
// always says "not found", a quote that always rejects. "A tool that cannot be
// honest is not announced" has to cover those too, so the interface now
// requires two methods and the stubs are gone. What this adapter announces is
// exactly what it can do: search_products, get_product, get_promotions.
//
// The TODO blocks at the bottom of this file describe what each unimplemented
// contract needs from a WooCommerce install. They are intentionally not
// half-implemented: guessing at somebody else's stock semantics is precisely
// the failure this template is about.
//
// Env vars:
//   WOO_BASE_URL   e.g. https://shop.example.com  (no trailing slash)
//   STORE_CURRENCY e.g. USD | EUR                 (default USD)

import type {
  CatalogAdapter,
  Product,
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

  async getPromotions(limit: number, brand?: string): Promise<{ total: number; promotions: SearchHit[] }> {
    const items = await wooFetch<WooStoreProduct[]>(`/products?on_sale=true&per_page=${limit}`);
    let promos = items;
    if (brand) {
      const b = brand.toLowerCase();
      promos = promos.filter(p => (p.brands?.[0]?.name ?? '').toLowerCase().includes(b));
    }
    return { total: promos.length, promotions: promos.map(toHit) };
  }
}

// ───────────────────── TODO: the contracts left open ─────────────────────
//
// Nothing below is implemented. Each block says what the contract needs and
// which WooCommerce-specific decision only you can make. Implement one, export
// it, and register it in src/lib/adapters/index.ts — the matching tool starts
// being announced the moment the capability exists. Until then the tool does
// not exist, which is the honest answer and costs you nothing.
//
// ── CatalogAdapter.getQuote (enables `get_quote`) ──
//
// Three viable strategies, in increasing order of effort:
//   1) Resolve each slug via getProduct(), sum prices, and return your cart
//      URL as payment_link (e.g. `${BASE}/cart/?add-to-cart=<id>`).
//   2) Use the Store API cart endpoints (POST /cart/add-item) with a
//      Cart-Token to build a real cart server-side.
//   3) Call your own checkout/quote endpoint if you already have one.
// Keep three invariants: this tool NEVER charges; echo the slug/sku you were
// given on every priced line; and price the quantity you were ASKED for or
// reject the line — create_checkout compares the two and refuses the cart when
// they differ, because that gap is how an order for 40 units gets charged as
// 10. Put tax and shipping in `charges`, not in the line prices.
//
// ── CatalogAdapter.listVariantCharts + getVariantChart ──
//
// Announced together, or not at all. WooCommerce has no native "variant chart"
// concept, so this is a modelling decision:
//   a) map product attribute taxonomies (pa_color, pa_size...) per product
//      line into charts,
//   b) keep a static JSON in your repo mapping a line → its variants,
//   c) do not implement them, which is a perfectly good answer for a catalog
//      that does not vary on a single axis.
// If you do implement them and you track per-variant stock somewhere (ERP,
// POS, a stock snapshot table), join it in getVariantChart. Contract reminder:
// when the stock source cannot be reached, return the chart with
// stock_verified:false and stock:null on every variant — never invent
// availability for a variant you did not verify.
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
//   - Return `pool` on every row: the identity of the pile of units the line
//     draws from. A simple WooCommerce product is one product id with a page
//     AND a SKU over ONE stock row, so both spellings must return the same
//     pool (e.g. `wc:product:1234`) and a variation returns its variation id.
//     Without it, a cart with the slug on one line and the SKU on another is
//     checked twice against the same units and passes twice.
//   - `reserve` / `release` are optional in TypeScript and NOT optional in
//     practice: without them live checkout refuses (see CHECKOUT_UNRESERVED).
//     In WooCommerce, "Hold stock (minutes)" only applies to unpaid orders
//     with stock management on, and it is applied by the order flow rather
//     than exposed as an API — so the usual implementation is your own holds
//     table with a single conditional UPDATE, checked and decremented in one
//     statement, plus a sweeper for expired holds.
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
//   - The draft carries `reservation_id` when the units were held. Attach it
//     to the order so your release/expiry logic can find it.
//   - Tax and shipping are YOURS. Put them in `charges` on the receipt and set
//     `total` to what the customer will actually pay; the tool response shows
//     the line subtotal and that total side by side, and an unexplained gap
//     between them is a number an agent will read out loud to a person.
//   - Emails: nothing in this template mails the operator. If you want an
//     order notification, send it from HERE, to an address in your own env —
//     never to `draft.customer_email`, which an agent typed.
//
// ── NotifyAdapter ──
//
// Needs: isSubscribed / sendOptInEmail / confirmSubscription, and you want
// countOptInEmails.
//
//   - Store subscriptions in your own table with a UNIQUE index on
//     (email, product_ref), and treat a unique-violation on insert as SUCCESS
//     so confirmation stays idempotent.
//   - `isSubscribed` must be allowed to throw rather than returning false on
//     error: the caller fails closed and sends nothing, which is the point.
//   - sendOptInEmail is the only message this flow may send to a
//     caller-supplied address. wp_mail() will work; a real ESP is better,
//     because you will want delivery logs the day someone asks why they got
//     mail from your shop. Persist `recipient_key` with every send.
//   - countOptInEmails is what makes "3 emails per hour per recipient" a real
//     ceiling instead of a per-instance hope: one indexed COUNT over that
//     table. Skip it and the tool says so in its own response.
//   - Set STOCK_ALERT_CONFIRM_URL to the page that serves the confirmation
//     (the bundled Next route, or `storefront-mcp --http`, which serves the
//     same handlers) and keep the rule that page enforces: GET renders, POST
//     writes.
