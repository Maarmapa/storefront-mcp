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
//
// NOTHING HERE IS A FIXED LIST. Every definition is produced from what the
// active adapter can actually do, because "a tool that cannot be honest is not
// announced" has to apply to the read tools too. A `list_variant_charts` that
// returns `[]` on every call because the adapter has a stub is not a working
// tool; it is a dead end an agent will walk into, twice.

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

/**
 * The two tools every catalog can answer. They correspond to the two required
 * methods of CatalogAdapter.
 */
export const CORE_TOOLS: ToolDef[] = [
  {
    name: 'search_products',
    description:
      'Search purchasable products in the catalog by name, brand or SKU. Returns slug, name, ' +
      'brand, price and product URL for each hit. If the query looks like a variant code ' +
      '(e.g. "E00", "101"), prefer get_variant_chart when this server offers it: a code is a ' +
      'variant of a chart, not a product.',
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
];

/** Which optional catalog capabilities this deployment has. */
export interface CatalogCapabilities {
  promotions: boolean;
  quote: boolean;
  variantCharts: boolean;
}

/** The optional read tools, announced only when the adapter implements them. */
export function catalogToolDefs(caps: CatalogCapabilities): ToolDef[] {
  const defs: ToolDef[] = [];

  if (caps.variantCharts) {
    defs.push(
      {
        name: 'get_variant_chart',
        description:
          'Return one product line\'s full variant chart: every variant with its code, name, SKU ' +
          'and — when the stock backend answers — real per-variant availability. The chart axis ' +
          'is whatever this catalog varies on (color, size, grit...). stock:null means unknown, ' +
          'never assume it is available.',
        inputSchema: {
          type: 'object',
          properties: {
            chart: {
              type: 'string',
              description: 'Chart slug or plain brand name, e.g. "chromaflow-classic" or "chromaflow"',
            },
          },
          required: ['chart'],
        },
      },
      {
        name: 'list_variant_charts',
        description:
          'List the variant charts this store publishes (slug, brand, product line, number of ' +
          'variants, base price). Use it to discover what get_variant_chart accepts.',
        inputSchema: { type: 'object', properties: {} },
      },
    );
  }

  if (caps.promotions) {
    defs.push({
      name: 'get_promotions',
      description: 'List products currently on sale. Returns up to 100.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max results (default 50, max 100)' },
          brand: { type: 'string', description: 'Optional brand filter' },
        },
      },
    });
  }

  if (caps.quote) {
    defs.push({
      name: 'get_quote',
      description:
        'Build a quote for a list of items and return the total plus a payment_link to hand to ' +
        'the human. It never charges anything: quote only, the human pays through the normal ' +
        'checkout. Quantities it cannot price in full come back in `rejected` with a reason — it ' +
        'does not quietly quote a smaller quantity than you asked for.',
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
    });
  }

  return defs;
}

// ───────────────────── sensitive tools (Bearer MCP_SECRET) ─────────────────────

/**
 * The back-office tools. Announced only when an OpsAdapter exists AND the
 * caller is authorized — the token gates who may see them, the adapter gates
 * whether they exist. A deployment with no OpsAdapter used to announce all
 * five to any authorized caller and then answer every one of them with
 * `{error: 'ops adapter not configured'}`, which is the same dead end the
 * capability gating on the write tools was built to avoid.
 */
export const OPS_TOOLS: ToolDef[] = [
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

/**
 * One sentence, two cases, both true. Which one applies to a given request
 * depends on whether the deployment can attribute callers (see
 * src/lib/client-ip.ts), so the description names both and the -32005 error
 * says which one just fired. Describing only the flattering case is how an
 * agent learns a retry strategy that does not match the server.
 */
const SHARED_QUOTA_NOTE =
  'Rate limit: 5 calls/minute per caller where this deployment can identify callers (a trusted ' +
  'proxy header or a direct connection); where it cannot, a single ceiling of 60 calls/minute ' +
  'for the whole server instance applies instead. Either way the bucket is SHARED with the other ' +
  'write tool — create_checkout and subscribe_stock_alert draw from one counter, and it does not ' +
  'reset by alternating them.';

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
        'from the catalog on this request, and a quote that prices a different quantity than the ' +
        'one requested blocks the order instead of becoming it. Lines for the same product are ' +
        'merged before any limit or stock check — including lines written as a slug and lines ' +
        'written as a sku when they are the same stock — so send them however you like. A qty ' +
        'that is not an integer greater than 0 is rejected, never rounded or defaulted. ' +
        'Availability is verified against the inventory system and the order is created ONLY if ' +
        'every line has enough verified units: if stock is short OR cannot be verified, nothing ' +
        'is created. The response always reports stock_available and stock_verified per line — ' +
        'use those numbers to adjust quantities and retry, do not guess. When the total to pay ' +
        'differs from the line subtotal (tax, shipping, a discount), quote amount_to_pay to the ' +
        'customer. ' +
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
        'confirmed as unavailable, when that address is already subscribed to that product, when a ' +
        'confirmation for it was already sent to that mailbox and nobody has acted on it, and when ' +
        'the mailbox has already received 3 confirmation emails in the last hour — that last quota ' +
        'is per RECIPIENT MAILBOX (plus-tags and dots do not create a new allowance) and does not ' +
        'reset by changing caller. The response field quota_enforcement says whether that ceiling ' +
        'is durable on this deployment or best-effort in memory. ' +
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
export const SENSITIVE_TOOLS: ReadonlySet<string> = new Set(OPS_TOOLS.map(t => t.name));
