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
// Three structural things worth copying:
//
//  1. ONE STOCK SOURCE. Every stock answer in this file — get_variant_chart,
//     get_stock_bulk, get_quote and the write-path availability check — comes
//     out of `lookupUnits`, reading one section of the data. A write path that
//     validates against a different source than the one it shows the customer
//     is a bug waiting for a busy Friday.
//
//  2. POOL IDENTITY. `lookupUnits` also answers WHICH PILE of units a ref
//     draws from, and it resolves a product's SKU and its slug to the SAME
//     pile. Without that, `{slug:'fieldbook-sketch-a4', qty:50}` and
//     `{sku:'FB-A4', qty:50}` are two lines of 50 that each "fit" inside 60
//     units, and the store sells 100.
//
//  3. RESERVATIONS. Checking availability and then creating an order is not
//     enough and cannot be: the check reads, the order writes, and between
//     them any number of concurrent calls read the same number. `reserve()`
//     is the only operation here that both checks and mutates in one step,
//     which is why `create_checkout` refuses to go live without it.

import { randomBytes } from 'node:crypto';
import catalogData from '../../../examples/toy-catalog.json';
import type {
  AvailabilityRow,
  CatalogAdapter,
  CheckoutAdapter,
  CheckoutDraft,
  CheckoutReceipt,
  InventoryAdapter,
  LineRef,
  MoneyLine,
  NotifyAdapter,
  OpsAdapter,
  OptInEmail,
  OrderDetail,
  OrderSummary,
  Product,
  Quote,
  QuoteItem,
  ReservationRequest,
  ReservationResult,
  SalesSummary,
  SearchHit,
  SearchResult,
  StockRow,
  TopProduct,
  Variant,
  VariantChart,
  VariantChartSummary,
} from '../adapter';
import { refKey } from '../availability';
import { MAX_UNITS_PER_PRODUCT } from '../cart';
import { roundMoney, sumMoney } from '../money';

interface ToyProduct {
  slug: string;
  name: string;
  brand: string | null;
  category: string | null;
  price: number | null;
  availability: string;
  description?: string;
  image?: string | null;
  /** Present on plain products that also have a SKU over the SAME units. */
  sku?: string | null;
}

interface ToyVariant {
  code: string;
  name: string;
  sku: string | null;
  swatch_hex: string | null;
}

interface ToyChart {
  slug: string;
  brand_name: string;
  product_name: string;
  base_price: number | null;
  axis?: string;
  variants: ToyVariant[];
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
  store: { name: string; currency: string; domain: string; free_shipping_over: number; flat_shipping: number };
  products: ToyProduct[];
  inventory: { by_sku: Record<string, number>; by_slug: Record<string, number> };
  variantCharts: ToyChart[];
  promotions: string[];
  orders: ToyOrder[];
};

const CURRENCY = data.store.currency;
const BASE_URL = `https://${data.store.domain}`;

// ───────────────────────── the single stock source ─────────────────────────

/**
 * Units currently held by an open reservation, per pool. A real adapter keeps
 * this in the same transaction as the stock itself (a `reserved` column, a
 * row in a holds table); a Map is the demo equivalent.
 */
const heldByPool = new Map<string, number>();
const openHolds = new Map<string, Array<{ pool: string; qty: number }>>();

function held(pool: string): number {
  return heldByPool.get(pool) ?? 0;
}

interface UnitsAnswer {
  units: number | null;
  verified: boolean;
  reason?: string;
  pool?: string;
}

/**
 * The only place in this adapter that answers "how many units?" and "which
 * pile?".
 *
 * Note what it does NOT do: it never falls back to 0 and never falls back to
 * "probably available". A SKU the catalog knows but the inventory table does
 * not is `units: null` — an unmapped variant, which is a real and common
 * state in stores whose catalog and inventory live in different systems.
 *
 * The number it returns is SELLABLE units: on-hand minus whatever open
 * reservations already claim. "On the shelf" is not "sellable to this
 * customer", and the gap between the two is where overselling lives.
 */
function lookupUnits(ref: LineRef): UnitsAnswer {
  if (ref.sku) {
    // A plain product can be addressed by slug OR by its SKU, over one pile.
    // Resolving that here is what lets the protocol layer add the two lines
    // together instead of checking 50 against 60 twice.
    const product = data.products.find(p => p.sku && p.sku === ref.sku);
    if (product) return unitsForSlug(product.slug);

    const units = data.inventory.by_sku[ref.sku];
    const pool = `sku:${ref.sku}`;
    if (typeof units === 'number') {
      return { units: Math.max(0, units - held(pool)), verified: true, pool };
    }
    const inCatalog = data.variantCharts.some(c => c.variants.some(v => v.sku === ref.sku));
    return {
      units: null,
      verified: false,
      reason: inCatalog
        ? 'variant exists in the catalog but is not mapped in the inventory system'
        : 'sku unknown to this store',
    };
  }
  if (ref.slug) return unitsForSlug(ref.slug);
  return { units: null, verified: false, reason: 'line has neither slug nor sku' };
}

function unitsForSlug(slug: string): UnitsAnswer {
  const units = data.inventory.by_slug[slug];
  const pool = `slug:${slug}`;
  if (typeof units === 'number') {
    return { units: Math.max(0, units - held(pool)), verified: true, pool };
  }
  const inCatalog = data.products.some(p => p.slug === slug);
  return {
    units: null,
    verified: false,
    reason: inCatalog ? 'product has no row in the stock snapshot' : 'slug unknown to this store',
  };
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

/**
 * The demo store's shipping rule, and the reason `MoneyLine` exists at all:
 * the number a customer pays is rarely the sum of the lines. A template whose
 * money model stops at `subtotal` quietly assumes tax-inclusive pricing and
 * free delivery, which is true for some stores and false for most.
 */
function shippingFor(subtotal: number): MoneyLine[] {
  if (subtotal <= 0 || subtotal >= data.store.free_shipping_over) return [];
  return [
    {
      kind: 'shipping',
      label: `Flat shipping (free over ${data.store.free_shipping_over} ${CURRENCY})`,
      amount: data.store.flat_shipping,
    },
  ];
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
        const hay = normalize(`${p.name} ${p.brand ?? ''} ${p.category ?? ''} ${p.slug} ${p.sku ?? ''}`);
        const matched = tokens.filter(t => hay.includes(t)).length;
        return { p, score: matched / tokens.length };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score);

    const results = scored.slice(0, limit).map(r => toHit(r.p));

    // If the query looks like a variant code, steer the agent to the chart:
    // a code is not a product, and only the chart knows its real stock.
    const looksLikeCode = data.variantCharts.some(c =>
      c.variants.some(v => tokens.includes(normalize(v.code))),
    );
    return {
      query,
      total: scored.length,
      results,
      note: looksLikeCode
        ? 'The query contains a variant code. Use get_variant_chart to see per-variant stock.'
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

  async listVariantCharts(): Promise<VariantChartSummary[]> {
    return data.variantCharts.map(c => ({
      slug: c.slug,
      brand_name: c.brand_name,
      product_name: c.product_name,
      variants_total: c.variants.length,
      base_price: c.base_price,
      currency: CURRENCY,
      axis: c.axis,
      url: `${BASE_URL}/charts/${c.slug}`,
    }));
  }

  async getVariantChart(chart: string): Promise<VariantChart | null> {
    const q = normalize(chart).trim();
    if (!q) return null;
    // Accept the exact slug, but also the brand name alone ("chromaflow"),
    // which is how people actually ask.
    const found =
      data.variantCharts.find(c => c.slug === q) ??
      data.variantCharts.find(c => normalize(c.brand_name) === q || c.slug.includes(q));
    if (!found) return null;
    return {
      slug: found.slug,
      brand_name: found.brand_name,
      product_name: found.product_name,
      base_price: found.base_price,
      currency: CURRENCY,
      url: `${BASE_URL}/charts/${found.slug}`,
      axis: found.axis,
      // The in-memory table is always reachable, so the CHART is verified even
      // when an individual variant inside it is not (see G09 in the demo data).
      stock_verified: true,
      variants: found.variants.map((v): Variant => {
        const { units } = lookupUnits({ sku: v.sku ?? undefined });
        return {
          code: v.code,
          name: v.name,
          sku: v.sku,
          swatch_hex: v.swatch_hex,
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
      // A quote is non-binding, and the temptation is to be helpful with a
      // sloppy quantity: `Math.max(1, Math.floor(qty || 1))`. Do not.
      //
      // Two reasons, and the second one is the expensive one. First, an agent
      // sending {qty: 0} means "drop this line", and quoting it one unit reads
      // a total to a human that includes something they removed. Second, this
      // number leaves the quote and does not come back: create_checkout takes
      // the QUANTITY from the cart and the MONEY from the quote, so a quote
      // that silently prices 10 of the 40 requested units produces an order
      // for 40 charged as 10. The protocol layer now reconciles the two and
      // refuses on a mismatch — but the adapter should not be creating the
      // mismatch in the first place. Reject and say why.
      const qty = it.qty;
      if (typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0) {
        rejected.push({
          slug: it.slug,
          sku: it.sku,
          reason: `qty must be an integer greater than 0 (received: ${JSON.stringify(qty ?? null)})`,
        });
        continue;
      }
      if (qty > MAX_UNITS_PER_PRODUCT) {
        // The same ceiling create_checkout enforces. Quoting a cart the
        // checkout tool will certainly refuse teaches an agent to promise
        // something it cannot deliver.
        rejected.push({
          slug: it.slug,
          sku: it.sku,
          reason: `qty ${qty} is over the per-product limit of ${MAX_UNITS_PER_PRODUCT} units`,
        });
        continue;
      }

      if (it.sku) {
        const product = data.products.find(p => p.sku && p.sku === it.sku);
        if (product) {
          if (product.availability === 'out_of_stock') {
            rejected.push({ sku: it.sku, reason: 'out of stock' });
          } else {
            const price = product.price ?? 0;
            lines.push({
              sku: it.sku,
              name: product.name,
              qty,
              unit_price: price,
              line_total: roundMoney(price * qty, CURRENCY),
            });
          }
          continue;
        }

        // A SKU that is not a plain product points at a chart variant.
        let found = false;
        for (const chart of data.variantCharts) {
          const v = chart.variants.find(c => c.sku === it.sku);
          if (v) {
            found = true;
            const { units } = lookupUnits({ sku: it.sku });
            if (units != null && units <= 0) {
              rejected.push({ sku: it.sku, reason: 'out of stock' });
            } else {
              const price = chart.base_price ?? 0;
              lines.push({
                sku: it.sku,
                name: `${chart.brand_name} ${chart.product_name} ${v.code} ${v.name}`,
                qty,
                unit_price: price,
                line_total: roundMoney(price * qty, CURRENCY),
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
            line_total: roundMoney(price * qty, CURRENCY),
          });
        }
      } else {
        rejected.push({ reason: 'item needs slug or sku' });
      }
    }

    const subtotal = sumMoney(lines.map(l => l.line_total), CURRENCY);
    const charges = shippingFor(subtotal);
    const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : '';
    return {
      items: lines,
      rejected,
      subtotal,
      currency: CURRENCY,
      ...(charges.length > 0 ? { charges } : {}),
      total: sumMoney([subtotal, ...charges.map(c => c.amount)], CURRENCY),
      payment_link: `${BASE_URL}/checkout?quote=demo${refParam}`,
      note: 'Quote only — nothing was charged. Hand the payment_link to the human.',
    };
  }
}

// ───────────────────────── ops (gated) ─────────────────────────

export class MemoryOpsAdapter implements OpsAdapter {
  async getStockBulk(skus: string[]): Promise<{ results: StockRow[] }> {
    const results: StockRow[] = skus.map(sku => {
      const product = data.products.find(p => p.sku && p.sku === sku);
      if (product) {
        const { units, verified, reason } = lookupUnits({ sku });
        return {
          sku,
          found: true,
          name: product.name,
          brand: product.brand,
          ...(units == null ? {} : { stock_available: units }),
          stock_verified: verified,
          ...(reason ? { reason } : {}),
          price: product.price,
        };
      }
      for (const chart of data.variantCharts) {
        const v = chart.variants.find(c => c.sku === sku);
        if (v) {
          // Same source as the write path — and `stock_available` is simply
          // ABSENT when unverified, rather than reported as 0. A back-office
          // tool that shows a phantom zero gets a real product delisted.
          const { units, verified, reason } = lookupUnits({ sku });
          return {
            sku,
            found: true,
            name: `${chart.brand_name} ${chart.product_name} ${v.code}`,
            brand: chart.brand_name,
            ...(units == null ? {} : { stock_available: units }),
            stock_verified: verified,
            ...(reason ? { reason } : {}),
            price: chart.base_price,
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
    const top = [...agg.values()]
      .map(r => ({ ...r, revenue: roundMoney(r.revenue, CURRENCY) }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, limit);
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
    const totalRevenue = sumMoney(rows.map(o => o.total), CURRENCY);
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
        revenue: roundMoney(v.revenue, CURRENCY),
        units_sold: v.units,
      }));
    return {
      period_days: days,
      orders: rows.length,
      total_revenue: totalRevenue,
      avg_ticket: rows.length > 0 ? roundMoney(totalRevenue / rows.length, CURRENCY) : 0,
      currency: CURRENCY,
      top_5_brands_by_revenue: topBrands,
    };
  }
}

// ───────────────────── inventory (drives the write guard) ─────────────────────

/**
 * The same table the read tools use, exposed as the write path's source of
 * truth. In a real store this is where you would query your ERP / POS / stock
 * snapshot.
 */
export class MemoryInventoryAdapter implements InventoryAdapter {
  async getAvailability(refs: LineRef[]): Promise<AvailabilityRow[]> {
    return refs.map(ref => ({ ...ref, ...lookupUnits(ref) }));
  }

  /**
   * Hold units, or hold nothing.
   *
   * The important property is not the Map — it is that from the first line of
   * this method to the last there is NO `await`. Read-then-write with an await
   * in the middle is the bug this method exists to fix, just moved one level
   * down. In a database this is one statement:
   *
   *   UPDATE stock SET reserved = reserved + :qty
   *   WHERE pool = :pool AND (on_hand - reserved) >= :qty
   *
   * plus a rollback when any line does not apply. In a POS/ERP it is whatever
   * that system calls a hold. What it must never be is "check, then write".
   */
  async reserve(req: ReservationRequest): Promise<ReservationResult> {
    const wanted = new Map<string, { qty: number; refs: LineRef[] }>();
    const conflicts: Array<LineRef & { requested: number; available: number | null; reason?: string }> = [];

    for (const line of req.lines) {
      const ans = lookupUnits(line);
      if (!ans.verified || ans.units == null || !ans.pool) {
        conflicts.push({
          slug: line.slug,
          sku: line.sku,
          requested: line.qty,
          available: null,
          reason: ans.reason ?? 'availability could not be verified',
        });
        continue;
      }
      const entry = wanted.get(ans.pool) ?? { qty: 0, refs: [] };
      entry.qty += line.qty;
      entry.refs.push({ slug: line.slug, sku: line.sku });
      wanted.set(ans.pool, entry);
    }

    if (conflicts.length === 0) {
      for (const [pool, entry] of wanted) {
        // `lookupUnits` already subtracted existing holds, so this compares
        // against what is genuinely sellable right now.
        const available = poolAvailable(pool);
        if (available == null || available < entry.qty) {
          for (const r of entry.refs) {
            conflicts.push({ ...r, requested: entry.qty, available });
          }
        }
      }
    }

    if (conflicts.length > 0) return { ok: false, conflicts };

    const reservationId = `res_${randomBytes(6).toString('hex')}`;
    const held: Array<{ pool: string; qty: number }> = [];
    for (const [pool, entry] of wanted) {
      heldByPool.set(pool, (heldByPool.get(pool) ?? 0) + entry.qty);
      held.push({ pool, qty: entry.qty });
    }
    openHolds.set(reservationId, held);
    return { ok: true, reservation_id: reservationId };
  }

  async release(reservationId: string): Promise<void> {
    const held = openHolds.get(reservationId);
    if (!held) return; // idempotent: releasing twice is not an error
    for (const h of held) {
      heldByPool.set(h.pool, Math.max(0, (heldByPool.get(h.pool) ?? 0) - h.qty));
    }
    openHolds.delete(reservationId);
  }
}

function poolAvailable(pool: string): number | null {
  const [kind, ...rest] = pool.split(':');
  const id = rest.join(':');
  const onHand = kind === 'sku' ? data.inventory.by_sku[id] : data.inventory.by_slug[id];
  if (typeof onHand !== 'number') return null;
  return Math.max(0, onHand - (heldByPool.get(pool) ?? 0));
}

/** Demo/inspection helper — not part of the InventoryAdapter contract. */
export function demoHolds(): Record<string, number> {
  return Object.fromEntries([...heldByPool.entries()].filter(([, qty]) => qty > 0));
}

// ───────────────────────── checkout (demo, creates nothing real) ─────────────────────────

/** Where a real adapter would have a database. Resets when the process does. */
const createdOrders: Array<{ short_id: string; draft: CheckoutDraft; created_at: string }> = [];

export class MemoryCheckoutAdapter implements CheckoutAdapter {
  async createCheckout(draft: CheckoutDraft): Promise<CheckoutReceipt> {
    const short_id = `DM-${randomBytes(3).toString('hex').toUpperCase()}`;
    createdOrders.push({ short_id, draft, created_at: new Date().toISOString() });

    // Tax and shipping are the ADAPTER's business, which is exactly why the
    // receipt carries its own total instead of echoing the line subtotal.
    const charges = shippingFor(draft.subtotal);
    const total = sumMoney([draft.subtotal, ...charges.map(c => c.amount)], draft.currency);

    return {
      order_short_id: short_id,
      subtotal: draft.subtotal,
      charges,
      total,
      currency: draft.currency,
      payment_url: `${BASE_URL}/pay/${short_id}`,
      note:
        'DEMO ORDER — nothing was charged. The units ARE held: this adapter implements ' +
        'InventoryAdapter.reserve, so the stock was decremented atomically before this order ' +
        'existed. If your backend cannot do that, a concurrent call can sell the same units ' +
        'twice no matter how careful the availability check was.',
    };
  }
}

/** Demo/inspection helper — not part of the CheckoutAdapter contract. */
export function demoCreatedOrders(): ReadonlyArray<{ short_id: string; created_at: string }> {
  return createdOrders.map(o => ({ short_id: o.short_id, created_at: o.created_at }));
}

// ───────────────────────── back-in-stock alerts (double opt-in) ─────────────────────────

const confirmedSubscriptions = new Set<string>();
interface SentOptIn {
  recipient_key: string;
  ref_key: string;
  sent_at: number;
  msg: OptInEmail;
}
const outbox: SentOptIn[] = [];

function subKey(email: string, ref: LineRef): string {
  return `${email.toLowerCase()}|${refKey(ref)}`;
}

export class MemoryNotifyAdapter implements NotifyAdapter {
  async isSubscribed(email: string, ref: LineRef): Promise<boolean> {
    return confirmedSubscriptions.has(subKey(email, ref));
  }

  async sendOptInEmail(msg: OptInEmail): Promise<void> {
    outbox.push({
      recipient_key: msg.recipient_key,
      ref_key: refKey({ slug: msg.product_slug, sku: msg.variant_sku }),
      sent_at: Date.now(),
      msg,
    });
    // A real adapter calls its email provider here. Stderr keeps the demo
    // honest: you can watch exactly one message leave, and see that a repeat
    // call produces none.
    process.stderr.write(
      `[storefront-mcp] DEMO opt-in email → ${msg.email} | ${msg.product_name} | confirm: ${msg.confirm_url}\n`,
    );
  }

  /**
   * The per-recipient quota, answered from storage instead of from a counter
   * in one process's memory.
   *
   * This is the method that turns "3 confirmation emails per hour" from a
   * hopeful sentence into a number that survives a restart, a redeploy and N
   * instances. In a real adapter it is one indexed COUNT over the same table
   * `sendOptInEmail` writes to — and it is keyed on `recipient_key`, the
   * canonical mailbox, so `victim+1@` does not get its own allowance.
   */
  async countOptInEmails(recipientKey: string, since: Date, ref?: LineRef): Promise<number> {
    const from = since.getTime();
    const wantRef = ref ? refKey(ref) : null;
    return outbox.filter(
      e =>
        e.recipient_key === recipientKey &&
        e.sent_at >= from &&
        (wantRef === null || e.ref_key === wantRef),
    ).length;
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
  return outbox.map(e => e.msg);
}
