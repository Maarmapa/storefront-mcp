// MCP tool definitions (the part the LLM actually reads) and the privilege
// boundary between public and sensitive tools.
//
// Writing descriptions: start with a verb, say WHAT the tool returns, and
// mention when a *different* tool is the better fit — agents route on these
// strings, so a vague description costs you real sales conversations.
//
// For write tools the description carries two more things, and both are load
// bearing: the CURRENT MODE (dry or live — an agent should not have to call a
// tool to find out whether it does anything) and the true shape of the rate
// limit. A limit described as per-tool when it is shared is paid for in
// retries, not in confusion.

import { checkoutMode, modeBanner, stockAlertMode } from './write-mode';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOLS: ToolDef[] = [
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
];

// ───────────────────────── write tools (public, guarded) ─────────────────────────

/**
 * The write tools are PUBLIC — that is the entire point, an anonymous agent is
 * supposed to be able to buy — so they carry their protection in behavior
 * rather than in a token. They are announced only when the deployment has the
 * capability to honor them (see visibleTools in protocol.ts).
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'create_checkout',
  'subscribe_stock_alert',
]);

const SHARED_QUOTA_NOTE =
  'Rate limit: 5 calls/minute per caller, SHARED with the other write tool (create_checkout and ' +
  'subscribe_stock_alert draw from one bucket, it does not reset by alternating them).';

export interface WriteCapabilities {
  checkout: boolean;
  stockAlert: boolean;
}

/** Build the write-tool definitions for the current capabilities and modes. */
export function writeToolDefs(caps: WriteCapabilities): ToolDef[] {
  const defs: ToolDef[] = [];

  if (caps.checkout) {
    defs.push({
      name: 'create_checkout',
      description:
        'Create an order from a list of items and return a payment link for the HUMAN to pay. ' +
        'This server never charges anyone. ' +
        modeBanner(checkoutMode(), 'create a real order') +
        ' Prices are NOT accepted from you: every unit price and total is computed server-side ' +
        'from the catalog on this request. Duplicate lines for the same product are merged before ' +
        'any limit or stock check, so send them however you like. A qty that is not an integer ' +
        'greater than 0 is rejected, never rounded or defaulted. Availability is verified against ' +
        'the inventory system line by line and the order is created ONLY if every line has enough ' +
        'verified units: if stock is short OR cannot be verified, nothing is created. The response ' +
        'always reports stock_available and stock_verified per line — use those numbers to adjust ' +
        'quantities and retry, do not guess. ' +
        SHARED_QUOTA_NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description:
              'Items to order. Each needs a slug (a product) or a sku (a specific variant), plus ' +
              'qty as an integer > 0. There is deliberately no price field.',
            items: {
              type: 'object',
              properties: {
                slug: { type: 'string' },
                sku: { type: 'string' },
                qty: { type: 'number', description: 'Integer greater than 0' },
              },
            },
          },
          customer_email: {
            type: 'string',
            description:
              "Optional. Stored on the order only; no automated mail is sent to it from this tool.",
          },
          note: { type: 'string', description: 'Optional note for the order (max 500 chars)' },
          ref: { type: 'string', description: 'Optional referral key for conversion tracking' },
        },
        required: ['items'],
      },
    });
  }

  if (caps.stockAlert) {
    defs.push({
      name: 'subscribe_stock_alert',
      description:
        'Start a back-in-stock alert for one product. ' +
        modeBanner(stockAlertMode(), 'send one confirmation email') +
        ' This tool NEVER activates a subscription: at most it sends ONE confirmation email to the ' +
        'address given, and the subscription exists only after the human confirms it, so tell the ' +
        'customer to check their inbox rather than telling them they are subscribed. It refuses ' +
        'when the product is actually in stock (buy it instead), when availability cannot be ' +
        'confirmed as unavailable, when that address is already subscribed to that product, and ' +
        'when the address has already received 3 confirmation emails in the last hour — that last ' +
        'quota is per RECIPIENT and does not reset by changing caller. ' +
        SHARED_QUOTA_NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          email: {
            type: 'string',
            description:
              'Address of the person who wants the alert. Ask the human for it; do not invent one ' +
              'and do not reuse an address from another context.',
          },
          slug: { type: 'string', description: 'Exact product slug' },
          sku: { type: 'string', description: 'Optional: alert on one specific variant of that product' },
        },
        required: ['email', 'slug'],
      },
    });
  }

  return defs;
}

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
