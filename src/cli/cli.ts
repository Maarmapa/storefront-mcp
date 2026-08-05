#!/usr/bin/env node
// Standalone entrypoint: `npx storefront-mcp`.
//
// Default mode speaks MCP over **stdio** using the official
// @modelcontextprotocol/sdk — the transport MCP clients (Claude Desktop,
// Claude Code, the official MCP Registry) expect from an npx-runnable package.
// `--http [port]` serves the same protocol as plain JSON-RPC over HTTP on
// localhost instead (handy for curl), with the same contract as the Next.js
// route in src/app/api/mcp/route.ts.
//
// This file is TRANSPORT ONLY. Tool definitions, the privilege boundary and
// dispatch all come from src/lib — the exact same code the Next route runs.
//
// Privilege boundary per transport:
//   - stdio: there is no Authorization header. The process env IS the trust
//     boundary: whoever can set MCP_SECRET in the env owns the machine the
//     server runs on. So sensitive tools unlock when MCP_SECRET is set (any
//     non-empty value) and stay invisible/blocked when it is not.
//   - HTTP (--http, and the Next route): remote callers are untrusted, so the
//     real check applies — `Authorization: Bearer <MCP_SECRET>`, constant-time
//     compared, fail-closed when the env var is unset.

import { createServer as createHttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { clientIpFromNodeHeaders } from '../lib/client-ip';
import {
  callTool,
  discoveryDescriptor,
  getServerDescription,
  getServerName,
  handleRequest,
  isAuthorizedHeader,
  PROTOCOL_VERSION,
  rpcError,
  SERVER_VERSION,
  ToolCallError,
  UnknownToolError,
  visibleTools,
  type JsonRpcRequest,
} from '../lib/protocol';
import { SENSITIVE_TOOLS } from '../lib/tools';
import { checkoutMode, stockAlertMode } from '../lib/write-mode';

const HELP = `storefront-mcp v${SERVER_VERSION} — e-commerce storefront MCP server

Usage:
  storefront-mcp              MCP over stdio (for Claude Desktop / Claude Code / MCP clients)
  storefront-mcp --http [port]  plain JSON-RPC over HTTP on localhost (default port 8787)
  storefront-mcp --help | --version

Environment:
  CATALOG_ADAPTER   "memory" (default: toy catalog + fake back office, inventory,
                    checkout and alerts) | "woocommerce" (catalog only)
  MCP_SECRET        unlocks the 5 sensitive back-office tools.
                    stdio: presence of the variable unlocks them (no header exists).
                    HTTP:  callers must send "Authorization: Bearer <MCP_SECRET>".
  MCP_SERVER_NAME / MCP_SERVER_DESCRIPTION   override the advertised identity.

Write tools (public but guarded — both DRY unless turned on by name):
  CHECKOUT_MODE     off | dry (default) | live   create_checkout
  STOCK_ALERT_MODE  off | dry (default) | live   subscribe_stock_alert
  STOCK_ALERT_SIGNING_SECRET   HMAC key for double opt-in links. Without it no
                    confirmation link can be issued and the alert tool refuses
                    (it never subscribes anyone without confirmation).
  STOCK_ALERT_CONFIRM_URL      where the confirmation page lives.
  A write tool is only announced when the active adapter can honor it.
`;

// stdout is the protocol channel in stdio mode — humans get stderr.
function log(msg: string): void {
  process.stderr.write(`[storefront-mcp] ${msg}\n`);
}

/**
 * Say out loud, at startup, whether the write tools exist and whether they do
 * anything. An operator should never have to call a tool to find out if it is
 * armed.
 */
function writeToolStatus(tools: Array<{ name: string }>): string {
  const has = (n: string) => tools.some(t => t.name === n);
  const parts: string[] = [];
  parts.push(
    has('create_checkout')
      ? `create_checkout=${checkoutMode()}`
      : 'create_checkout=absent (needs checkout+inventory adapters)',
  );
  parts.push(
    has('subscribe_stock_alert')
      ? `subscribe_stock_alert=${stockAlertMode()}`
      : 'subscribe_stock_alert=absent (needs notify adapter)',
  );
  return parts.join(', ');
}

// ───────────────────────── stdio mode (default) ─────────────────────────

async function runStdio(): Promise<void> {
  // The env is the trust boundary on stdio: see the header comment.
  const authorized = !!process.env.MCP_SECRET;

  const server = new Server(
    { name: getServerName(), version: SERVER_VERSION, description: getServerDescription() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // Same boundary as the HTTP route: unauthorized callers never even see
    // the sensitive tools.
    tools: visibleTools(authorized) as unknown as Tool[],
  }));

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const name = req.params.name;
    if (SENSITIVE_TOOLS.has(name) && !authorized) {
      throw new McpError(-32001, `Tool '${name}' requires authentication (set MCP_SECRET in the env)`);
    }
    try {
      // One local process on one machine: every stdio call shares a quota key.
      const result = await callTool(name, (req.params.arguments ?? {}) as Record<string, unknown>, {
        clientKey: 'stdio',
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      if (e instanceof UnknownToolError) throw new McpError(ErrorCode.MethodNotFound, e.message);
      if (e instanceof ToolCallError) throw new McpError(e.code, e.message);
      throw new McpError(ErrorCode.InternalError, `Tool error: ${(e as Error).message}`);
    }
  });

  await server.connect(new StdioServerTransport());
  const tools = visibleTools(authorized);
  log(
    `stdio ready — adapter=${process.env.CATALOG_ADAPTER || 'memory'}, ` +
      `tools=${tools.length} (sensitive ${authorized ? 'unlocked via MCP_SECRET' : 'hidden: MCP_SECRET not set'}` +
      `; write tools: ${writeToolStatus(tools)})`,
  );
}

// ───────────────────────── --http mode ─────────────────────────

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB is plenty for JSON-RPC

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function runHttp(port: number): void {
  const server = createHttpServer(async (req, res) => {
    const sendJson = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET') {
      sendJson(200, discoveryDescriptor('http'));
      return;
    }
    if (req.method !== 'POST') {
      sendJson(405, rpcError(null, -32600, 'Use POST for JSON-RPC (GET returns the descriptor)'));
      return;
    }

    let body: JsonRpcRequest | JsonRpcRequest[];
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(400, rpcError(null, -32700, 'Parse error'));
      return;
    }

    // Real Bearer auth here — HTTP callers are untrusted, exactly like the
    // Next.js route.
    const authorized = isAuthorizedHeader(req.headers.authorization);
    // Same resolver as the Next.js route: platform headers first, otherwise
    // the LAST x-forwarded-for hop.
    const ctx = { clientKey: clientIpFromNodeHeaders(req.headers) };

    if (Array.isArray(body)) {
      const responses = (
        await Promise.all(body.map(b => handleRequest(b, authorized, ctx)))
      ).filter(r => r !== null);
      sendJson(200, responses);
      return;
    }
    const result = await handleRequest(body, authorized, ctx);
    if (result === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(200, result);
  });

  server.listen(port, '127.0.0.1', () => {
    log(`HTTP ready on http://127.0.0.1:${port} — protocol ${PROTOCOL_VERSION}`);
    log(
      `adapter=${process.env.CATALOG_ADAPTER || 'memory'}, sensitive tools ` +
        (process.env.MCP_SECRET
          ? 'enabled with "Authorization: Bearer <MCP_SECRET>"'
          : 'blocked for everyone (MCP_SECRET not set — fail-closed)'),
    );
  });
}

// ───────────────────────── arg parsing ─────────────────────────

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const httpIdx = args.indexOf('--http');
  if (httpIdx !== -1) {
    const portArg = args[httpIdx + 1];
    const port = portArg && /^\d+$/.test(portArg) ? Number(portArg) : 8787;
    if (port < 1 || port > 65535) {
      log(`invalid port: ${portArg}`);
      process.exit(1);
    }
    runHttp(port);
    return;
  }

  const unknown = args.filter(a => a.startsWith('-'));
  if (unknown.length > 0) {
    log(`unknown option: ${unknown[0]}`);
    process.stdout.write(HELP);
    process.exit(1);
  }

  runStdio().catch(e => {
    log(`fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}

main();
