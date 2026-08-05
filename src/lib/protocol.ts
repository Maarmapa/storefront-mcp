// Framework-free MCP protocol core: JSON-RPC framing, the public-vs-sensitive
// privilege boundary, and tool dispatch to the active adapter.
//
// Two transports share this module and MUST stay behaviorally identical:
//   - src/app/api/mcp/route.ts  → Next.js Streamable HTTP route (Bearer auth),
//   - bin via src/cli/cli.ts    → standalone stdio / plain-HTTP server.
//
// It owns everything protocol-shaped; everything data-shaped lives behind the
// adapter interfaces in src/lib/adapter.ts. Swap the adapter, keep the protocol.

import { timingSafeEqual } from 'node:crypto';
import type { QuoteItem } from './adapter';
import { getAdapters } from './adapters';
import { SENSITIVE_TOOLS, TOOLS } from './tools';

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_VERSION = '1.0.0';

export function getServerName(): string {
  return process.env.MCP_SERVER_NAME || 'storefront-mcp';
}

export function getServerDescription(): string {
  return (
    process.env.MCP_SERVER_DESCRIPTION ||
    'Storefront catalog over MCP: products, variant charts, promotions, quotes.'
  );
}

// ───────────────────────── JSON-RPC plumbing ─────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export function rpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export function rpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Constant-time comparison so the secret cannot be guessed byte by byte. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * The privilege boundary for HTTP transports. Fail-closed: when MCP_SECRET is
 * not set in the environment, the sensitive tools are blocked for EVERYONE —
 * there is no "no secret configured, so everything is open" mode.
 */
export function isAuthorizedHeader(authorizationHeader: string | null | undefined): boolean {
  const secret = process.env.MCP_SECRET;
  return !!secret && safeEqual(authorizationHeader || '', `Bearer ${secret}`);
}

// ───────────────────────── tool dispatch ─────────────────────────

export class UnknownToolError extends Error {
  constructor(public toolName: string) {
    super(`Unknown tool: ${toolName}`);
  }
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { catalog, ops } = getAdapters();

  switch (name) {
    case 'search_products': {
      const query = String(args.query ?? '');
      const limit = Math.min(Number(args.limit) || 8, 25);
      return catalog.searchProducts(query, limit);
    }
    case 'get_product': {
      const slug = String(args.slug ?? '');
      const p = await catalog.getProduct(slug);
      return p ?? { error: 'product not found', slug };
    }
    case 'get_color_card': {
      const brand = String(args.brand ?? '');
      const card = await catalog.getColorCard(brand);
      if (!card) {
        const available = await catalog.listBrands();
        return { error: 'brand not found', brand, available: available.map(b => b.slug) };
      }
      return card;
    }
    case 'list_brands':
      return { brands: await catalog.listBrands() };
    case 'get_promotions': {
      const limit = Math.min(Number(args.limit) || 50, 100);
      const brand = args.brand ? String(args.brand) : undefined;
      return catalog.getPromotions(limit, brand);
    }
    case 'get_quote': {
      const items = Array.isArray(args.items) ? (args.items as QuoteItem[]) : [];
      if (items.length === 0) return { error: 'items required' };
      const ref = args.ref ? String(args.ref) : undefined;
      return catalog.getQuote(items, ref);
    }

    // ───────── sensitive tools: auth already checked by the caller ─────────
    case 'get_stock_bulk': {
      if (!ops) return { error: 'ops adapter not configured on this deployment' };
      const skus = Array.isArray(args.skus) ? (args.skus as string[]).slice(0, 50) : [];
      if (skus.length === 0) return { error: 'skus required' };
      return ops.getStockBulk(skus);
    }
    case 'get_top_products': {
      if (!ops) return { error: 'ops adapter not configured on this deployment' };
      const days = Math.min(Number(args.days) || 30, 365);
      const limit = Math.min(Number(args.limit) || 10, 50);
      return ops.getTopProducts(days, limit);
    }
    case 'get_recent_orders': {
      if (!ops) return { error: 'ops adapter not configured on this deployment' };
      const limit = Math.min(Number(args.limit) || 20, 100);
      const status = args.status ? String(args.status) : undefined;
      return ops.getRecentOrders(limit, status);
    }
    case 'get_order_status': {
      if (!ops) return { error: 'ops adapter not configured on this deployment' };
      const shortId = String(args.short_id ?? '').trim();
      if (!shortId) return { error: 'short_id required' };
      const o = await ops.getOrderStatus(shortId);
      return o ? { found: true, ...o } : { found: false, short_id: shortId };
    }
    case 'get_sales_summary': {
      if (!ops) return { error: 'ops adapter not configured on this deployment' };
      const days = Math.min(Number(args.days) || 30, 365);
      return ops.getSalesSummary(days);
    }

    default:
      throw new UnknownToolError(name);
  }
}

/** The tools visible to a caller at a given privilege level. */
export function visibleTools(authorized: boolean) {
  return authorized ? TOOLS : TOOLS.filter(t => !SENSITIVE_TOOLS.has(t.name));
}

// ───────────────────────── JSON-RPC handler ─────────────────────────

export async function handleRequest(req: JsonRpcRequest, authorized: boolean) {
  switch (req.method) {
    case 'initialize':
      return rpcResult(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: getServerName(),
          version: SERVER_VERSION,
          description: getServerDescription(),
        },
      });

    case 'notifications/initialized':
      return null; // notification: no response

    case 'tools/list':
      // The privilege boundary, part 1: unauthenticated callers don't even
      // SEE the sensitive tools. The shop window is public; the back office
      // is not on the map.
      return rpcResult(req.id, { tools: visibleTools(authorized) });

    case 'tools/call': {
      const params = (req.params || {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = params.name ?? '';
      // The privilege boundary, part 2: even if a caller guesses a sensitive
      // tool's name, the call is rejected before any adapter code runs.
      if (SENSITIVE_TOOLS.has(name) && !authorized) {
        return rpcError(req.id, -32001, `Tool '${name}' requires authentication (Bearer MCP_SECRET)`);
      }
      try {
        const result = await callTool(name, params.arguments ?? {});
        return rpcResult(req.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        if (e instanceof UnknownToolError) return rpcError(req.id, -32601, e.message);
        return rpcError(req.id, -32603, `Tool error: ${(e as Error).message}`);
      }
    }

    case 'ping':
      return rpcResult(req.id, {});

    default:
      return rpcError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

/** GET discovery descriptor shared by the Next route and the CLI HTTP mode. */
export function discoveryDescriptor(transport: 'streamable-http' | 'http') {
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || 'https://example.com').replace(/\/$/, '');
  return {
    name: getServerName(),
    version: SERVER_VERSION,
    description: getServerDescription(),
    protocolVersion: PROTOCOL_VERSION,
    transport,
    docs: `${siteUrl}/llms.txt`,
    tools: visibleTools(false).map(t => t.name),
  };
}
