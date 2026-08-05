#!/usr/bin/env node
// Standalone entrypoint: `npx storefront-mcp`.
//
// Default mode speaks MCP over **stdio** using the official
// @modelcontextprotocol/sdk — the transport MCP clients (Claude Desktop,
// Claude Code, the official MCP Registry) expect from an npx-runnable package.
// `--http [port]` serves the same protocol as plain JSON-RPC over HTTP on
// localhost instead (handy for curl), with the same contract as the Next.js
// route in src/app/api/mcp/route.ts — plus the opt-in confirmation page,
// because a package that can send confirmation emails has to be able to serve
// the link inside them.
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
import { getAdapters } from '../lib/adapters';
import { resolveCallerFromNode, trustedProxyHeader } from '../lib/client-ip';
import { confirmUrlBase, signingSecretState } from '../lib/optin';
import { confirmSubscriptionPage, renderConfirmPage, tokenFromBody } from '../lib/optin-page';
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
import { checkoutMode, stockAlertMode, unreservedCheckoutPolicy } from '../lib/write-mode';

/** Path the confirmation page is served from in --http mode. */
const CONFIRM_PATH = '/api/stock-alert/confirm';

const HELP = `storefront-mcp v${SERVER_VERSION} — e-commerce storefront MCP server

Usage:
  storefront-mcp                MCP over stdio (for Claude Desktop / Claude Code / MCP clients)
  storefront-mcp --http [port]  plain JSON-RPC over HTTP (default 127.0.0.1:8787).
                                Also serves ${CONFIRM_PATH} (GET renders, POST writes).
  storefront-mcp --host <addr>  bind address for --http (default 127.0.0.1)
  storefront-mcp --help | --version

Environment:
  CATALOG_ADAPTER   "memory" (default: toy catalog + fake back office, inventory,
                    checkout and alerts) | "woocommerce" (catalog only)
  MCP_SECRET        unlocks the sensitive back-office tools, when the adapter has any.
                    stdio: presence of the variable unlocks them (no header exists).
                    HTTP:  callers must send "Authorization: Bearer <MCP_SECRET>".
  MCP_SERVER_NAME / MCP_SERVER_DESCRIPTION   override the advertised identity.
  TRUSTED_PROXY_HEADER   name of the header YOUR edge writes with the client IP
                    (x-vercel-forwarded-for, cf-connecting-ip, ...). Unset means
                    forwarding headers are ignored, because a caller can write them.

Write tools (public but guarded — both DRY unless turned on by name):
  CHECKOUT_MODE     off | dry (default) | live   create_checkout
  STOCK_ALERT_MODE  off | dry (default) | live   subscribe_stock_alert
  CHECKOUT_UNRESERVED  refuse (default) | allow. In live mode, what to do when the
                    inventory adapter cannot HOLD units: refuse the order, or accept
                    that two simultaneous calls can sell the same stock twice.
  STOCK_ALERT_SIGNING_SECRET   HMAC key for double opt-in links, min 32 chars.
                    Without it no confirmation link can be issued and the alert
                    tool refuses (it never subscribes anyone without confirmation).
  STOCK_ALERT_CONFIRM_URL      public URL of the confirmation page. Required in
                    live mode: no URL, no email.
  STOCK_ALERT_PAGE_LOCALE      en (default) | es — language of that page.
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
  // A missing tool has two very different causes and the operator needs the
  // right one: "you switched it off" is not "your adapter cannot do it".
  // Capability is reported FIRST, because an operator told "kill switch" will
  // set the mode to dry, see the tool still missing, and go looking in the
  // wrong file.
  const describe = (name: string, mode: string, capable: boolean, missingCapability: string) => {
    if (has(name)) return `${name}=${mode}`;
    if (!capable) return `${name}=absent (${missingCapability})`;
    return `${name}=off (kill switch)`;
  };
  const { catalog, inventory, checkout, notify } = getAdapters();
  return [
    describe(
      'create_checkout',
      checkoutMode(),
      !!checkout && !!inventory && typeof catalog.getQuote === 'function',
      'needs checkout + inventory adapters and catalog.getQuote',
    ),
    describe('subscribe_stock_alert', stockAlertMode(), !!notify, 'needs notify adapter'),
  ].join(', ');
}

/**
 * Configuration that is not wrong yet but will be the moment someone flips a
 * switch. Printed once, at startup, where an operator can still act on it.
 */
function startupWarnings(): string[] {
  const warnings: string[] = [];
  const { inventory } = getAdapters();

  const secret = signingSecretState();
  if (stockAlertMode() === 'live') {
    if (secret === 'missing') {
      warnings.push(
        'STOCK_ALERT_MODE=live but STOCK_ALERT_SIGNING_SECRET is not set: the alert tool will ' +
          'refuse every call. Generate one with `openssl rand -hex 32`.',
      );
    } else if (secret === 'too_short') {
      warnings.push(
        'STOCK_ALERT_SIGNING_SECRET is shorter than 32 characters and is being treated as absent. ' +
          'A guessable signing key lets anyone mint a confirmation token for any address.',
      );
    }
    if (!confirmUrlBase()) {
      warnings.push(
        'STOCK_ALERT_MODE=live but no confirmation URL is configured (STOCK_ALERT_CONFIRM_URL or ' +
          `NEXT_PUBLIC_SITE_URL): the alert tool will refuse rather than mail a dead link. In ` +
          `--http mode this process serves that page at ${CONFIRM_PATH}.`,
      );
    }
  }

  if (checkoutMode() === 'live' && inventory && typeof inventory.reserve !== 'function') {
    warnings.push(
      unreservedCheckoutPolicy() === 'allow'
        ? 'CHECKOUT_MODE=live with CHECKOUT_UNRESERVED=allow and an inventory adapter that cannot ' +
          'reserve: concurrent calls CAN oversell. Every receipt says so.'
        : 'CHECKOUT_MODE=live but this inventory adapter cannot reserve units, so live orders will ' +
          'be refused. Implement InventoryAdapter.reserve, or set CHECKOUT_UNRESERVED=allow to ' +
          'accept the oversell risk deliberately.',
    );
  }

  return warnings;
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
      // One local process talking to one client on one machine: the caller IS
      // identified, and it is this process.
      const result = await callTool(name, (req.params.arguments ?? {}) as Record<string, unknown>, {
        clientKey: 'stdio',
        attributed: true,
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
  for (const w of startupWarnings()) log(`WARNING: ${w}`);
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

function runHttp(port: number, host: string): void {
  const server = createHttpServer(async (req, res) => {
    const sendJson = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const sendPage = (page: { status: number; headers: Record<string, string>; html: string }) => {
      res.writeHead(page.status, page.headers);
      res.end(page.html);
    };

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // ── The double opt-in confirmation page.
    //
    // It lives here, and not only in the Next.js app, because the npm package
    // ships lib + cli and nothing else. An operator who installs via npx, sets
    // a signing secret and goes live would otherwise be mailing real people a
    // link that nothing they installed can serve.
    if (path === CONFIRM_PATH) {
      if (req.method === 'GET') {
        sendPage(await renderConfirmPage(url.searchParams.get('token') ?? ''));
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req).catch(() => '');
        sendPage(await confirmSubscriptionPage(tokenFromBody(req.headers['content-type'] ?? '', body)));
        return;
      }
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Use GET to view the confirmation page and POST to confirm.');
      return;
    }

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
    // Same resolver as the Next.js route. On this transport there IS a socket,
    // so the peer address identifies the caller even with no proxy in front —
    // and forwarding headers are ignored unless the operator declared one,
    // because with no proxy they are just text the caller typed.
    const ctx = resolveCallerFromNode(req.headers, req.socket.remoteAddress);

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

  server.listen(port, host, () => {
    log(`HTTP ready on http://${host}:${port} — protocol ${PROTOCOL_VERSION}`);
    log(`opt-in confirmation page: http://${host}:${port}${CONFIRM_PATH}`);
    log(
      `adapter=${process.env.CATALOG_ADAPTER || 'memory'}, sensitive tools ` +
        (process.env.MCP_SECRET
          ? 'enabled with "Authorization: Bearer <MCP_SECRET>"'
          : 'blocked for everyone (MCP_SECRET not set — fail-closed)'),
    );
    const trusted = trustedProxyHeader();
    log(
      trusted
        ? `caller identity: "${trusted}" (declared via TRUSTED_PROXY_HEADER). Make sure only your ` +
          'edge can reach this port, or that header is just text a caller can write.'
        : 'caller identity: socket address (no TRUSTED_PROXY_HEADER set, so forwarding headers are ' +
          'ignored). Behind a proxy, set TRUSTED_PROXY_HEADER or every caller looks like the proxy.',
    );
    log(`write tools: ${writeToolStatus(visibleTools(false))}`);
    for (const w of startupWarnings()) log(`WARNING: ${w}`);
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

  const hostIdx = args.indexOf('--host');
  const host = hostIdx !== -1 && args[hostIdx + 1] && !args[hostIdx + 1].startsWith('-')
    ? args[hostIdx + 1]
    : '127.0.0.1';

  const httpIdx = args.indexOf('--http');
  if (httpIdx !== -1) {
    const portArg = args[httpIdx + 1];
    const port = portArg && /^\d+$/.test(portArg) ? Number(portArg) : 8787;
    if (port < 1 || port > 65535) {
      log(`invalid port: ${portArg}`);
      process.exit(1);
    }
    runHttp(port, host);
    return;
  }

  const known = new Set(['--http', '--host']);
  const unknown = args.filter((a, i) => a.startsWith('-') && !known.has(a) && args[i - 1] !== '--host');
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
