// WooCommerce adapter SKELETON, built on the public Store API
// (https://developer.woocommerce.com/docs/apis/store-api/).
//
// The Store API is unauthenticated and read-only for catalog data, which maps
// perfectly onto CatalogAdapter: everything it can see is already public on
// your storefront. It intentionally does NOT implement OpsAdapter — order and
// revenue data require the authenticated WC REST API (consumer key/secret)
// and you should think twice before wiring that in at all.
//
// Env vars:
//   WOO_BASE_URL   e.g. https://shop.example.com  (no trailing slash)
//   STORE_CURRENCY e.g. USD | EUR | CLP           (default USD)

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
