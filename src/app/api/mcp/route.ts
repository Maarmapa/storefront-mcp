// MCP server (Model Context Protocol) over Streamable HTTP transport for a
// generic e-commerce storefront. Next.js App Router route: drop this folder
// into app/api/mcp/ and any MCP client (Claude Desktop, Claude Code, custom
// GPTs, agent frameworks) can connect and query your catalog.
//
// Protocol: JSON-RPC 2.0 messages, single POST endpoint.
// Reference: https://modelcontextprotocol.io/specification
//
// This file is PROTOCOL ONLY. It owns:
//   - JSON-RPC framing (initialize / tools/list / tools/call / ping / batch),
//   - the public-vs-sensitive privilege boundary (Bearer MCP_SECRET),
//   - dispatching each tool to the active adapter.
// Everything data-related lives behind the adapter interfaces in
// src/lib/adapter.ts. Swap the adapter, keep the protocol.

import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { QuoteItem } from '@/lib/adapter';
import { getAdapters } from '@/lib/adapters';
import { SENSITIVE_TOOLS, TOOLS } from '@/lib/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * Hard ceiling for the whole route. Without it, one hung upstream dependency
 * keeps the serverless function alive until the platform default while the
 * MCP client waits. Adapters should keep their own, shorter per-call budgets;
 * this is the net for the one that escapes.
 */
export const maxDuration = 15;

const PROTOCOL_VERSION = '2025-06-18';

const SERVER_NAME = process.env.MCP_SERVER_NAME || 'storefront-mcp';
const SERVER_DESCRIPTION =
  process.env.MCP_SERVER_DESCRIPTION ||
  'Storefront catalog over MCP: products, variant charts, promotions, quotes.';
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://example.com').replace(/\/$/, '');

// ───────────────────────── JSON-RPC plumbing ─────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Constant-time comparison so the secret cannot be guessed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ───────────────────────── tool dispatch ─────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
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

class UnknownToolError extends Error {
  constructor(public toolName: string) {
    super(`Unknown tool: ${toolName}`);
  }
}

// ───────────────────────── JSON-RPC handler ─────────────────────────

async function handleRequest(req: JsonRpcRequest, authorized: boolean) {
  switch (req.method) {
    case 'initialize':
      return rpcResult(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: SERVER_NAME,
          version: '1.0.0',
          description: SERVER_DESCRIPTION,
        },
      });

    case 'notifications/initialized':
      return null; // notification: no response

    case 'tools/list':
      // The privilege boundary, part 1: unauthenticated callers don't even
      // SEE the sensitive tools. The shop window is public; the back office
      // is not on the map.
      return rpcResult(req.id, {
        tools: authorized ? TOOLS : TOOLS.filter(t => !SENSITIVE_TOOLS.has(t.name)),
      });

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

export async function POST(req: NextRequest) {
  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, 'Parse error'), { status: 400 });
  }

  // Optional auth: catalog tools are public; SENSITIVE_TOOLS require
  // `Authorization: Bearer <MCP_SECRET>`. Fail-closed: when MCP_SECRET is not
  // set in the environment, the sensitive tools are blocked for EVERYONE —
  // there is no "no secret configured, so everything is open" mode.
  const secret = process.env.MCP_SECRET;
  const header = req.headers.get('authorization') || '';
  const authorized = !!secret && safeEqual(header, `Bearer ${secret}`);

  if (Array.isArray(body)) {
    const responses = (
      await Promise.all(body.map(b => handleRequest(b, authorized)))
    ).filter(r => r !== null);
    return NextResponse.json(responses);
  }
  const result = await handleRequest(body, authorized);
  if (result === null) return new Response(null, { status: 202 });
  return NextResponse.json(result);
}

// Discovery: GET returns metadata so clients (and curious humans) can verify
// the endpoint without speaking JSON-RPC. Only public tool names are listed.
export async function GET() {
  return NextResponse.json({
    name: SERVER_NAME,
    version: '1.0.0',
    description: SERVER_DESCRIPTION,
    protocolVersion: PROTOCOL_VERSION,
    transport: 'streamable-http',
    docs: `${SITE_URL}/llms.txt`,
    tools: TOOLS.filter(t => !SENSITIVE_TOOLS.has(t.name)).map(t => t.name),
  });
}
