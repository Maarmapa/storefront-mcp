// MCP tool definitions (the part the LLM actually reads) and the privilege
// boundary between public and sensitive tools.
//
// Writing descriptions: start with a verb, say WHAT the tool returns, and
// mention when a *different* tool is the better fit — agents route on these
// strings, so a vague description costs you real sales conversations.

export const TOOLS = [
  {
    name: 'search_products',
    description:
      'Search purchasable products in the catalog by name, brand or SKU. Returns slug, name, ' +
      'brand, price and product URL for each hit. If the query looks like a color/variant code ' +
      '(e.g. "E00", "101"), prefer get_color_card: a code is a variant of a chart, not a product.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text to search (e.g. "sketch marker warm gray")' },
        limit: { type: 'number', description: 'Max results (default 8, max 25)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product',
    description:
      'Return full detail for one product by its exact slug: name, price, availability, ' +
      'description, image and canonical URL.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Exact product slug, e.g. "classic-marker-set-12"' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'get_color_card',
    description:
      'Return a brand variant chart (color card): every variant with code, name, SKU and — when ' +
      'the stock backend answers — real per-variant availability. stock:null means unknown, ' +
      'never assume it is available.',
    inputSchema: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Chart slug or plain brand name, e.g. "chromaflow-classic" or "chromaflow"' },
      },
      required: ['brand'],
    },
  },
  {
    name: 'list_brands',
    description: 'List available variant charts (slug, brand, product line, number of variants, base price).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_promotions',
    description: 'List products currently on sale. Returns up to 100.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 50, max 100)' },
        brand: { type: 'string', description: 'Optional brand filter' },
      },
    },
  },
  {
    name: 'get_quote',
    description:
      'Build a quote for a list of items and return the total plus a payment_link to hand to ' +
      'the human. It never charges anything: quote only, the human pays through the normal checkout.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Items to quote: each with slug (a product) or sku (a specific variant), plus qty.',
          items: {
            type: 'object',
            properties: {
              slug: { type: 'string' },
              sku: { type: 'string' },
              qty: { type: 'number' },
            },
          },
        },
        ref: { type: 'string', description: 'Optional referral key for conversion tracking' },
      },
      required: ['items'],
    },
  },
  // ───────── sensitive tools (Bearer MCP_SECRET required) ─────────
  {
    name: 'get_stock_bulk',
    description: 'Real-time stock for multiple SKUs in one call. Ideal to verify availability before quoting.',
    inputSchema: {
      type: 'object',
      properties: {
        skus: { type: 'array', items: { type: 'string' }, description: 'SKU list (max 50)' },
      },
      required: ['skus'],
    },
  },
  {
    name: 'get_top_products',
    description: 'Best-selling products over the last N days. Returns name, SKU, units sold and revenue.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Window in days (default 30, max 365)' },
        limit: { type: 'number', description: 'Top N (default 10, max 50)' },
      },
    },
  },
  {
    name: 'get_recent_orders',
    description:
      'Latest orders, read-only and anonymized: short_id, total, status, date, item count. ' +
      'Never exposes customer PII.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max orders (default 20, max 100)' },
        status: { type: 'string', description: 'Filter: pending | paid | dispatched | cancelled' },
      },
    },
  },
  {
    name: 'get_order_status',
    description:
      'Status of one order by its public short_id (the id shown at checkout). ' +
      'Returns status, dates, items and total — no customer PII.',
    inputSchema: {
      type: 'object',
      properties: {
        short_id: { type: 'string', description: 'Public short id of the order (e.g. "AB-3F2K9")' },
      },
      required: ['short_id'],
    },
  },
  {
    name: 'get_sales_summary',
    description: 'Sales summary for a period: total revenue, order count, average ticket, top 5 brands by revenue.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Window in days back from today (default 30, max 365)' },
      },
    },
  },
] as const;

/**
 * The privilege boundary. Tools in this set expose back-office data (revenue,
 * orders, exact stock) and require `Authorization: Bearer <MCP_SECRET>`.
 *
 * With a missing or invalid secret:
 *   - tools/list returns ONLY the public tools (sensitive ones are invisible),
 *   - calling a sensitive tool returns JSON-RPC error -32001.
 *
 * The catalog tools stay public on purpose: an agent may browse the shop
 * window; it never sees the operation.
 */
export const SENSITIVE_TOOLS: ReadonlySet<string> = new Set([
  'get_stock_bulk',
  'get_top_products',
  'get_recent_orders',
  'get_order_status',
  'get_sales_summary',
]);
