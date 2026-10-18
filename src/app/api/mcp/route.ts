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
import { resolveCallerFromHeaders } from '@/lib/client-ip';
import { acceptsEventStream, discoveryDescriptor, handleHttpBody, isAuthorizedHeader, rpcError } from '@/lib/protocol';

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
  let body: unknown;
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

  // Caller identity for the write-tool quota. Resolved by the shared module in
  // src/lib/client-ip.ts so this route and the CLI cannot disagree.
  //
  // A Fetch-style handler has no socket to ask, so on this transport the ONLY
  // trustworthy identity is a header the operator has explicitly declared
  // (TRUSTED_PROXY_HEADER=x-vercel-forwarded-for on Vercel, cf-connecting-ip
  // behind Cloudflare, and so on). Without that declaration the caller is
  // deliberately unattributed and the quota becomes an instance-wide ceiling —
  // guessing at a forwarding header nobody promised to write is how a rate
  // limit turns into decoration.
  const ctx = resolveCallerFromHeaders(req.headers);

  // Shape check, 2026-07-28 header validation (MCP-Protocol-Version,
  // Mcp-Method, Mcp-Name), dispatch and HTTP status: one function, shared
  // with the CLI's --http mode so the two transports cannot disagree.
  const reply = await handleHttpBody(body, name => req.headers.get(name) ?? undefined, authorized, ctx);
  if (reply === null) return new Response(null, { status: 202 });
  return NextResponse.json(reply.payload, { status: reply.status });
}

// Discovery: GET returns metadata so clients (and curious humans) can verify
// the endpoint without speaking JSON-RPC. Only public tool names are listed.
export async function GET(req: NextRequest) {
  // A 2025-revision client asking for text/event-stream is opening the
  // server→client stream; this route opens none, and the transport's answer
  // for that is 405. Anyone else gets the discovery descriptor.
  if (acceptsEventStream(req.headers.get('accept'))) {
    return NextResponse.json(
      rpcError(null, -32600, 'This server opens no server-to-client stream; POST JSON-RPC requests instead'),
      { status: 405, headers: { allow: 'POST' } },
    );
  }
  return NextResponse.json(discoveryDescriptor('streamable-http'));
}
