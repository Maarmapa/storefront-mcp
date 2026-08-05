// In-memory adapter backed by a JSON catalog. Zero external dependencies:
// this is the adapter that lets anyone run the server two minutes after
// cloning the repo, and the reference implementation to copy when writing
// a real one.
//
// It implements ALL FIVE contracts from the same file (catalog, ops,
// inventory, checkout, notify), faking the back office with the sample data
// in the JSON. A real deployment would keep them in separate modules with
// separate credentials — the catalog is public, the rest is not.
//
// The one structural thing worth copying: every stock answer in this file —
// get_color_card, get_stock_bulk, get_quote and the write-path availability
// check — comes out of ONE function, `lookupUnits`, reading ONE section of
// the data. A write path that validates against a different source than the
// one it shows the customer is a bug waiting for a busy Friday.

import { randomBytes } from 'node:crypto';
import catalogData from '../../../examples/toy-catalog.json';
import type {
  AvailabilityRow,
  BrandSummary,
  CatalogAdapter,
  CheckoutAdapter,
  CheckoutDraft,
  CheckoutReceipt,
  ColorCard,
  InventoryAdapter,
  LineRef,
  NotifyAdapter,
  OpsAdapter,
  OptInEmail,
  OrderDetail,
  OrderSummary,
  Product,
  Quote,
  QuoteItem,
  SalesSummary,
  SearchHit,
  SearchResult,
  StockRow,
  TopProduct,
} from '../adapter';
import { refKey } from '../availability';

interface ToyProduct {
  slug: string;
  name: string;
  brand: string | null;
  category: string | null;
  price: number | null;
  availability: string;
  description?: string;
  image?: string | null;
}

interface ToyColor {
  code: string;
  name: string;
  sku: string | null;
  hex: string | null;
}

interface ToyCard {
  slug: string;
  brand_name: string;
  product_name: string;
  base_price: number | null;
  colors: ToyColor[];
}

interface ToyOrder {
  short_id: string;
  status: string;
  total: number;
  subtotal?: number;
  shipping?: number;
  items: Array<{ sku: string | null; name: string; qty: number; unit_price: number }>;
  created_at: string;
  paid_at?: string | null;
  dispatched_at?: string | null;
}

const data = catalogData as unknown as {
  store: { name: string; currency: string; domain: string };
  products: ToyProduct[];
  inventory: { by_sku: Record<string, number>; by_slug: Record<string, number> };
  colorCards: ToyCard[];
  promotions: string[];
  orders: ToyOrder[];
};

const CURRENCY = data.store.currency;
const BASE_URL = `https://${data.store.domain}`;

// ───────────────────────── the single stock source ─────────────────────────

/**
 * The only place in this adapter that answers "how many units?".
 *
 * Note what it does NOT do: it never falls back to 0 and never falls back to
 * "probably available". A SKU the catalog knows but the inventory table does
 * not is `units: null` — an unmapped variant, which is a real and common
 * state in stores whose catalog and inventory live in different systems.
 */
function lookupUnits(ref: LineRef): { units: number | null; verified: boolean; reason?: string } {
  if (ref.sku) {
    const units = data.inventory.by_sku[ref.sku];
    if (typeof units === 'number') return { units, verified: true };
    const inCatalog = data.colorCards.some(c => c.colors.some(col => col.sku === ref.sku));
    return {
      units: null,
      verified: false,
      reason: inCatalog
        ? 'variant exists in the catalog but is not mapped in the inventory system'
        : 'sku unknown to this store',
    };
  }
  if (ref.slug) {
    const units = data.inventory.by_slug[ref.slug];
    if (typeof units === 'number') return { units, verified: true };
    const inCatalog = data.products.some(p => p.slug === ref.slug);
    return {
      units: null,
      verified: false,
      reason: inCatalog
        ? 'product has no row in the stock snapshot'
        : 'slug unknown to this store',
    };
  }
  return { units: null, verified: false, reason: 'line has neither slug nor sku' };
}

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function toHit(p: ToyProduct): SearchHit {
  return {
    slug: p.slug,
    name: p.name,
    brand: p.brand,
    price: p.price,
    image: p.image ?? null,
    url: `${BASE_URL}/product/${p.slug}`,
  };
}

// ───────────────────────── catalog ─────────────────────────

export class MemoryCatalogAdapter implements CatalogAdapter {
  async searchProducts(query: string, limit: number): Promise<SearchResult> {
    const q = normalize(query).trim();
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { query, total: 0, results: [] };

    // Score by token coverage over name + brand + category + SKU-ish fields.
    const scored = data.products
      .map(p => {
        const hay = normalize(`${p.name} ${p.brand ?? ''} ${p.category ?? ''} ${p.slug}`);
        const matched = tokens.filter(t => hay.includes(t)).length;
        return { p, score: matched / tokens.length };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score);

    const results = scored.slice(0, limit).map(r => toHit(r.p));

    // If the query looks like a variant code, steer the agent to the chart:
    // a code is not a product, and only the color card knows its real stock.
    const looksLikeCode = data.colorCards.some(c =>
      c.colors.some(col => tokens.includes(normalize(col.code))),
    );
    return {
      query,
      total: scored.length,
      results,
      note: looksLikeCode
        ? 'The query contains a variant/color code. Use get_color_card to see per-variant stock.'
        : undefined,
    };
  }

  async getProduct(slug: string): Promise<Product | null> {
    const p = data.products.find(x => x.slug === slug);
    if (!p) return null;
    return {
      slug: p.slug,
      name: p.name,
      brand: p.brand,
      category: p.category,
      price: p.price,
      currency: CURRENCY,
      availability:
        p.availability === 'in_stock' || p.availability === 'out_of_stock'
          ? p.availability
          : 'unknown',
      description: p.description,
      image: p.image ?? null,
      url: `${BASE_URL}/product/${p.slug}`,
    };
  }

  async listBrands(): Promise<BrandSummary[]> {
    return data.colorCards.map(c => ({
      slug: c.slug,
      brand_name: c.brand_name,
      product_name: c.product_name,
      colors_total: c.colors.length,
      base_price: c.base_price,
      currency: CURRENCY,
      url: `${BASE_URL}/colors/${c.slug}`,
    }));
  }

  async getColorCard(brand: string): Promise<ColorCard | null> {
    const q = normalize(brand).trim();
    if (!q) return null;
    // Accept the exact slug, but also the brand name alone ("chromaflow"),
    // which is how people actually ask.
    const card =
      data.colorCards.find(c => c.slug === q) ??
      data.colorCards.find(c => normalize(c.brand_name) === q || c.slug.includes(q));
    if (!card) return null;
    return {
      slug: card.slug,
      brand_name: card.brand_name,
      product_name: card.product_name,
      base_price: card.base_price,
      currency: CURRENCY,
      url: `${BASE_URL}/colors/${card.slug}`,
      // The in-memory table is always reachable, so the CARD is verified even
      // when an individual variant inside it is not (see G09 in the demo data).
      stock_verified: true,
      colors: card.colors.map(c => {
        const { units } = lookupUnits({ sku: c.sku ?? undefined });
        return {
          code: c.code,
          name: c.name,
          sku: c.sku,
          hex: c.hex,
          stock: units,
          available: units == null ? null : units > 0,
        };
      }),
    };
  }

  async getPromotions(limit: number, brand?: string): Promise<{ total: number; promotions: SearchHit[] }> {
    let promos = data.products.filter(p => data.promotions.includes(p.slug));
    if (brand) {
      const b = normalize(brand);
      promos = promos.filter(p => normalize(p.brand ?? '').includes(b));
    }
    return { total: promos.length, promotions: promos.slice(0, limit).map(toHit) };
  }

  async getQuote(items: QuoteItem[], ref?: string): Promise<Quote> {
    const lines: Quote['items'] = [];
    const rejected: Quote['rejected'] = [];

    for (const it of items) {
      // A quote is a non-binding estimate, so clamping a sloppy qty here is
      // harmless. create_checkout does NOT get this liberty: it rejects an
      // invalid quantity outright, because there the number ends up on
      // something a human pays. See src/lib/cart.ts.
      const qty = Math.max(1, Math.floor(it.qty || 1));
      if (it.sku) {
        // A SKU points at a chart variant.
        let found = false;
        for (const card of data.colorCards) {
          const col = card.colors.find(c => c.sku === it.sku);
          if (col) {
            found = true;
            const { units } = lookupUnits({ sku: it.sku });
            if (units != null && units <= 0) {
              rejected.push({ sku: it.sku, reason: 'out of stock' });
            } else {
              const price = card.base_price ?? 0;
              lines.push({
                sku: it.sku,
                name: `${card.brand_name} ${card.product_name} ${col.code} ${col.name}`,
                qty,
                unit_price: price,
                line_total: Math.round(price * qty * 100) / 100,
              });
            }
            break;
          }
        }
        if (!found) rejected.push({ sku: it.sku, reason: 'sku not found' });
      } else if (it.slug) {
        const p = data.products.find(x => x.slug === it.slug);
        if (!p) {
          rejected.push({ slug: it.slug, reason: 'product not found' });
        } else if (p.availability === 'out_of_stock') {
          rejected.push({ slug: it.slug, reason: 'out of stock' });
        } else {
          const price = p.price ?? 0;
          lines.push({
            slug: p.slug,
            name: p.name,
            qty,
            unit_price: price,
            line_total: Math.round(price * qty * 100) / 100,
          });
        }
      } else {
        rejected.push({ reason: 'item needs slug or sku' });
      }
    }

    const subtotal = Math.round(lines.reduce((s, l) => s + l.line_total, 0) * 100) / 100;
    const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : '';
    return {
      items: lines,
      rejected,
      subtotal,
      currency: CURRENCY,
      payment_link: `${BASE_URL}/checkout?quote=demo${refParam}`,
      note: 'Quote only — nothing was charged. Hand the payment_link to the human.',
    };
  }
}

// ───────────────────────── ops (gated) ─────────────────────────

export class MemoryOpsAdapter implements OpsAdapter {
  async getStockBulk(skus: string[]): Promise<{ results: StockRow[] }> {
    const results: StockRow[] = skus.map(sku => {
      for (const card of data.colorCards) {
        const col = card.colors.find(c => c.sku === sku);
        if (col) {
          // Same source as the write path — and `stock_available` is simply
          // ABSENT when unverified, rather than reported as 0. A back-office
          // tool that shows a phantom zero gets a real product delisted.
          const { units, verified, reason } = lookupUnits({ sku });
          return {
            sku,
            found: true,
            name: `${card.brand_name} ${card.product_name} ${col.code}`,
            brand: card.brand_name,
            ...(units == null ? {} : { stock_available: units }),
            stock_verified: verified,
            ...(reason ? { reason } : {}),
            price: card.base_price,
          };
        }
      }
      return { sku, found: false };
    });
    return { results };
  }

  async getTopProducts(days: number, limit: number): Promise<{ days: number; top: TopProduct[] }> {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const agg = new Map<string, TopProduct>();
    for (const o of data.orders) {
      if (new Date(o.created_at).getTime() < since) continue;
      if (!['paid', 'dispatched', 'completed'].includes(o.status)) continue;
      for (const it of o.items) {
        const key = it.sku || it.name;
        const row = agg.get(key) ?? { name: it.name, sku: it.sku, qty: 0, revenue: 0 };
        row.qty += it.qty;
        row.revenue += it.qty * it.unit_price;
        agg.set(key, row);
      }
    }
    const top = [...agg.values()].sort((a, b) => b.qty - a.qty).slice(0, limit);
    return { days, top };
  }

  async getRecentOrders(limit: number, status?: string): Promise<{ orders: OrderSummary[] }> {
    let orders = [...data.orders].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    if (status) orders = orders.filter(o => o.status === status);
    return {
      orders: orders.slice(0, limit).map(o => ({
        short_id: o.short_id,
        status: o.status,
        total: o.total,
        items_count: o.items.length,
        created_at: o.created_at,
      })),
    };
  }

  async getOrderStatus(shortId: string): Promise<OrderDetail | null> {
    const o = data.orders.find(x => x.short_id === shortId);
    if (!o) return null;
    return {
      short_id: o.short_id,
      status: o.status,
      total: o.total,
      subtotal: o.subtotal,
      shipping: o.shipping,
      items: o.items.map(it => ({ name: it.name, qty: it.qty, unit_price: it.unit_price })),
      created_at: o.created_at,
      paid_at: o.paid_at ?? null,
      dispatched_at: o.dispatched_at ?? null,
    };
  }

  async getSalesSummary(days: number): Promise<SalesSummary> {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = data.orders.filter(
      o =>
        new Date(o.created_at).getTime() >= since &&
        ['paid', 'dispatched', 'completed'].includes(o.status),
    );
    const totalRevenue = Math.round(rows.reduce((s, o) => s + o.total, 0) * 100) / 100;
    const brandAgg = new Map<string, { revenue: number; units: number }>();
    for (const o of rows) {
      for (const it of o.items) {
        // Infer the brand from the first word of the name; a real adapter
        // should carry a proper brand field on each line item.
        const brand = it.name.split(' ')[0] || 'unknown';
        const row = brandAgg.get(brand) ?? { revenue: 0, units: 0 };
        row.revenue += it.qty * it.unit_price;
        row.units += it.qty;
        brandAgg.set(brand, row);
      }
    }
    const topBrands = [...brandAgg.entries()]
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .slice(0, 5)
      .map(([brand, v]) => ({
        brand,
        revenue: Math.round(v.revenue * 100) / 100,
        units_sold: v.units,
      }));
    return {
      period_days: days,
      orders: rows.length,
      total_revenue: totalRevenue,
      avg_ticket: rows.length > 0 ? Math.round((totalRevenue / rows.length) * 100) / 100 : 0,
      currency: CURRENCY,
      top_5_brands_by_revenue: topBrands,
    };
  }
}

// ───────────────────── inventory (drives the write guard) ─────────────────────

/**
 * The same table the read tools use, exposed as the write path's source of
 * truth. In a real store this is where you would query your ERP / POS / stock
 * snapshot — and, critically, subtract whatever is already committed
 * elsewhere (open reservations, unpaid holds, picking lists), because
 * "physically on the shelf" is not "sellable to this customer".
 */
export class MemoryInventoryAdapter implements InventoryAdapter {
  async getAvailability(refs: LineRef[]): Promise<AvailabilityRow[]> {
    return refs.map(ref => ({ ...ref, ...lookupUnits(ref) }));
  }
}

// ───────────────────────── checkout (demo, creates nothing real) ─────────────────────────

/** Where a real adapter would have a database. Resets when the process does. */
const createdOrders: Array<{ short_id: string; draft: CheckoutDraft; created_at: string }> = [];

export class MemoryCheckoutAdapter implements CheckoutAdapter {
  async createCheckout(draft: CheckoutDraft): Promise<CheckoutReceipt> {
    const short_id = `DM-${randomBytes(3).toString('hex').toUpperCase()}`;
    createdOrders.push({ short_id, draft, created_at: new Date().toISOString() });
    return {
      order_short_id: short_id,
      total: draft.subtotal,
      currency: draft.currency,
      payment_url: `${BASE_URL}/pay/${short_id}`,
      note:
        'DEMO ORDER — nothing was charged and no units were reserved. Note the second half ' +
        'of that sentence: in most stacks an order does NOT hold inventory, so the ' +
        'availability check in the protocol layer is the only thing between an agent loop ' +
        'and an oversell. If your backend can reserve, reserve here.',
    };
  }
}

/** Demo/inspection helper — not part of the CheckoutAdapter contract. */
export function demoCreatedOrders(): ReadonlyArray<{ short_id: string; created_at: string }> {
  return createdOrders.map(o => ({ short_id: o.short_id, created_at: o.created_at }));
}

// ───────────────────────── back-in-stock alerts (double opt-in) ─────────────────────────

const confirmedSubscriptions = new Set<string>();
const outbox: OptInEmail[] = [];

function subKey(email: string, ref: LineRef): string {
  return `${email.toLowerCase()}|${refKey(ref)}`;
}

export class MemoryNotifyAdapter implements NotifyAdapter {
  async isSubscribed(email: string, ref: LineRef): Promise<boolean> {
    return confirmedSubscriptions.has(subKey(email, ref));
  }

  async sendOptInEmail(msg: OptInEmail): Promise<void> {
    outbox.push(msg);
    // A real adapter calls its email provider here. Stderr keeps the demo
    // honest: you can watch exactly one message leave, and see that a repeat
    // call produces none.
    process.stderr.write(
      `[storefront-mcp] DEMO opt-in email → ${msg.email} | ${msg.product_name} | confirm: ${msg.confirm_url}\n`,
    );
  }

  async confirmSubscription(email: string, ref: LineRef): Promise<{ created: boolean }> {
    // Idempotent on purpose: humans double-click, browsers re-POST, and a
    // second confirmation is a success, not an error. A SQL implementation
    // does the same by treating a unique-constraint violation as OK and
    // propagating every other error.
    const key = subKey(email, ref);
    if (confirmedSubscriptions.has(key)) return { created: false };
    confirmedSubscriptions.add(key);
    return { created: true };
  }
}

/** Demo/inspection helper — not part of the NotifyAdapter contract. */
export function demoOutbox(): ReadonlyArray<OptInEmail> {
  return outbox;
}
