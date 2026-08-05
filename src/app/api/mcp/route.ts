// MCP server (Model Context Protocol) over Streamable HTTP transport for a
// generic e-commerce storefront. Next.js App Router route: drop this folder
// into app/api/mcp/ and any MCP client (Claude Desktop, Claude Code, custom
// GPTs, agent frameworks) can connect and query your catalog.
//
// Protocol: JSON-RPC 2.0 messages, single POST endpoint.
// Reference: https://modelcontextprotocol.io/specification
//
// This file is TRANSPORT ONLY: HTTP parsing plus the Bearer check. The whole
// protocol core (JSON-RPC framing, the public-vs-sensitive privilege boundary,
// tool dispatch) lives in src/lib/protocol.ts and is shared verbatim with the
// standalone CLI (`npx storefront-mcp`). Everything data-related lives behind
// the adapter interfaces in src/lib/adapter.ts. Swap the adapter, keep the
// protocol.

import { NextRequest, NextResponse } from 'next/server';
import {
  discoveryDescriptor,
  handleRequest,
  isAuthorizedHeader,
  rpcError,
  type JsonRpcRequest,
} from '@/lib/protocol';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * Hard ceiling for the whole route. Without it, one hung upstream dependency
 * keeps the serverless function alive until the platform default while the
 * MCP client waits. Adapters should keep their own, shorter per-call budgets;
 * this is the net for the one that escapes.
 */
export const maxDuration = 15;

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
  const authorized = isAuthorizedHeader(req.headers.get('authorization'));

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
  return NextResponse.json(discoveryDescriptor('streamable-http'));
}
