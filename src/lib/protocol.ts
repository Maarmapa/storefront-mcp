// Framework-free MCP protocol core: JSON-RPC framing, the public-vs-sensitive
// privilege boundary, and tool dispatch to the active adapter.
//
// Two transports share this module and MUST stay behaviorally identical:
//   - src/app/api/mcp/route.ts  → Next.js Streamable HTTP route (Bearer auth),
//   - bin via src/cli/cli.ts    → standalone stdio / plain-HTTP server.
//
// It owns everything protocol-shaped; everything data-shaped lives behind the
// adapter interfaces in src/lib/adapter.ts. Swap the adapter, keep the protocol.
//
// ONE LIST, TWO USES. `visibleTools()` decides what tools/list announces and
// `callTool()` refuses anything that list would not contain. That is not
// tidiness: when the two are computed separately they drift, and the drift is
// visible from outside — a server that announces a tool and then answers it
// with `{error: "not configured"}` while a different unannounced tool gets
// -32601 is telling an agent two incompatible stories about the same
// situation. Announcement and dispatch answer "does this tool exist here?"
// exactly once, from the same function.

import { timingSafeEqual } from 'node:crypto';
import type { QuoteItem } from './adapter';
import { getAdapters } from './adapters';
import {
  createCheckoutTool,
  DEFAULT_CONTEXT,
  subscribeStockAlertTool,
  type CallContext,
} from './commerce';
import { ToolCallError } from './errors';
import {
  catalogToolDefs,
  CORE_TOOLS,
  OPS_TOOLS,
  SENSITIVE_TOOLS,
  writeToolDefs,
  type ToolDef,
} from './tools';
import {
  readSkillResource,
  SKILL_URI,
  SKILLS_EXTENSION,
  skillEntry,
  skillResourceList,
  type SkillContext,
} from './skills';
import { checkoutMode, stockAlertMode } from './write-mode';

export type { CallContext } from './commerce';
export { ToolCallError } from './errors';

/**
 * Protocol versions. `LATEST` is what server/discover offers first; the legacy
 * `initialize` handshake answers with the client's version when it is one of
 * these and with `PROTOCOL_VERSION` otherwise. 2026-07-28 is stateless (no
 * initialize), carries the version in every request's `_meta`, and is the
 * revision the Skills extension is specified against — a client that speaks
 * only older revisions still gets tools, resources and the skill file, it
 * just cannot call skills/list.
 */
export const PROTOCOL_VERSION = '2025-06-18';
export const LATEST_PROTOCOL_VERSION = '2026-07-28';
/** Every revision this server serves: the stateless one via server/discover, the others via initialize. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
/**
 * The revisions that still have a handshake. `initialize` never answers with
 * 2026-07-28: that revision has no initialize, so echoing it would promise a
 * lifecycle that does not exist. The default is what the official SDK answers
 * on stdio to a version it does not know, so both transports agree.
 */
export const HANDSHAKE_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18'];
export const HANDSHAKE_DEFAULT_VERSION = '2025-11-25';
/** Freshness hint on list results (2026-07-28 `CacheableResult`). */
export const LIST_TTL_MS = 300_000;
/**
 * Shorter for the skill text itself: it states whether the write tools are
 * live or dry on this deployment, and a cached copy that outlives a mode
 * switch would tell an agent the wrong thing about what its call does.
 */
export const RESOURCE_TTL_MS = 60_000;
/** What a host that does not speak the Skills extension reads instead. */
export const SERVER_INSTRUCTIONS =
  `This server publishes how to use it as a skill at ${SKILL_URI}. ` +
  `If your host can read resources, read it (resources/read) before calling tools: it says how to ` +
  `shop here and where an agent's permission ends. If it cannot, the tool descriptions suffice.`;

/** Per-request protocol fields of the 2026-07-28 revision (RequestMeta / ResultMeta). */
export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
/**
 * The advertised server version. It MUST match `version` in package.json and
 * both `version` fields in server.json — clients see this one, npm sees the
 * second, and the MCP Registry sees the third. Bump the three together.
 */
export const SERVER_VERSION = '2.1.0';

export function getServerName(): string {
  // One line, no control characters, bounded. The name is shown by hosts and
  // rendered into the SKILL.md heading; an env var with newlines must not be
  // able to inject headings or instructions into either.
  const raw = (process.env.MCP_SERVER_NAME || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return raw.slice(0, 80) || 'storefront-mcp';
}

export function getServerDescription(): string {
  return (
    process.env.MCP_SERVER_DESCRIPTION ||
    'Storefront over MCP: products, variant charts, promotions, quotes, guarded checkout and back-in-stock alerts.'
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

export function rpcError(id: string | number | null | undefined, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } };
}

/**
 * A well-formed JSON-RPC 2.0 request or notification, as MCP constrains it:
 * `jsonrpc: "2.0"`, a string `method`, `params` an object when present, and
 * an `id` that is a string or an integer when present (MCP forbids `null`).
 * Anything else — `null`, a number, an array, a response object — is answered
 * with -32600, never executed.
 */
export function isJsonRpcRequest(x: unknown): x is JsonRpcRequest {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const r = x as Record<string, unknown>;
  if (r.jsonrpc !== '2.0' || typeof r.method !== 'string') return false;
  if ('params' in r && r.params !== undefined && (!r.params || typeof r.params !== 'object' || Array.isArray(r.params))) return false;
  if ('id' in r && !(typeof r.id === 'string' || (typeof r.id === 'number' && Number.isInteger(r.id)))) return false;
  return true;
}

/** A request without `id` is a notification: it gets no response and, here, nothing to execute. */
export function isNotification(req: JsonRpcRequest): boolean {
  return !('id' in req);
}

/** `Accept: text/event-stream` on GET is a 2025-revision client opening the server→client stream. */
export function acceptsEventStream(accept: string | string[] | null | undefined): boolean {
  const a = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  return /\btext\/event-stream\b/i.test(a);
}

/** Every RPC method dispatch answers; anything else is "method not found". */
export const IMPLEMENTED_METHODS: ReadonlySet<string> = new Set([
  'server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call',
  'resources/list', 'resources/templates/list', 'resources/read', 'skills/list', 'skills/get', 'ping',
]);

/** The list methods this server answers. None of them ever issues `nextCursor`. */
export const LIST_METHODS: ReadonlySet<string> = new Set(['tools/list', 'resources/list', 'resources/templates/list', 'skills/list']);
export const CURSOR_MESSAGE =
  'Invalid params: this server returns every list in one page and never issues a cursor; do not send one';
export function hasCursor(params: unknown): boolean {
  return !!params && typeof params === 'object' && (params as { cursor?: unknown }).cursor !== undefined;
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

// ───────────────────────── capabilities → tools ─────────────────────────

/**
 * The tools that exist on this deployment at a given privilege level.
 *
 * Three filters, deliberately not conflated:
 *
 *   - CAPABILITY decides whether a tool exists at all. Every optional adapter
 *     method is one: no `getQuote`, no `get_quote`; no OpsAdapter, no
 *     back-office tools; no `CheckoutAdapter` + `InventoryAdapter` + pricing,
 *     no `create_checkout`. An adapter that implements nothing optional keeps
 *     working unchanged and its agents simply never see the rest.
 *   - PRIVILEGE decides whether the sensitive tools are visible to THIS caller
 *     (Bearer MCP_SECRET).
 *   - The per-tool kill switch (mode "off") removes a write tool without
 *     touching adapter code.
 */
export function visibleTools(authorized: boolean): ToolDef[] {
  const { catalog, ops, inventory, checkout, notify } = getAdapters();

  const read = catalogToolDefs({
    promotions: typeof catalog.getPromotions === 'function',
    quote: typeof catalog.getQuote === 'function',
    // Both chart tools stand or fall together: listing charts you cannot open
    // is as useless as opening charts nobody can find.
    variantCharts:
      typeof catalog.getVariantChart === 'function' && typeof catalog.listVariantCharts === 'function',
  });

  const write = writeToolDefs({
    // create_checkout needs to price (catalog), to count (inventory) and to
    // persist (checkout). Missing any one of the three and every call would
    // end in a refusal.
    checkout:
      !!checkout && !!inventory && typeof catalog.getQuote === 'function' && checkoutMode() !== 'off',
    stockAlert: !!notify && stockAlertMode() !== 'off',
  });

  const sensitive = ops && authorized ? OPS_TOOLS : [];

  return [...CORE_TOOLS, ...read, ...write, ...sensitive];
}

/** Names of every tool this deployment can honor, ignoring privilege. */
function existingToolNames(): Set<string> {
  return new Set(visibleTools(true).map(t => t.name));
}

/**
 * What the skill text (src/lib/skills.ts) depends on, for THIS caller: the
 * same tool list tools/list would announce, and the current write modes. The
 * skill and the tool list cannot disagree because they are computed from the
 * same function.
 */
export function skillContext(authorized: boolean): SkillContext {
  return {
    serverName: getServerName(),
    tools: visibleTools(authorized),
    checkoutMode: checkoutMode(),
    stockAlertMode: stockAlertMode(),
  };
}

// ───────────────────────── tool dispatch ─────────────────────────

export class UnknownToolError extends Error {
  constructor(public toolName: string) {
    super(
      `Unknown tool: ${toolName}. Call tools/list — this deployment announces exactly the tools ` +
        `it can answer.`,
    );
  }
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: CallContext = DEFAULT_CONTEXT,
): Promise<unknown> {
  const { catalog, ops } = getAdapters();

  // A tool that is not announced does not exist, and says so the same way for
  // every reason it might not exist.
  if (!existingToolNames().has(name)) throw new UnknownToolError(name);

  switch (name) {
    // ───────── write tools: public, but guarded (src/lib/commerce.ts) ─────────
    case 'create_checkout':
      return createCheckoutTool(args, ctx);
    case 'subscribe_stock_alert':
      return subscribeStockAlertTool(args, ctx);

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
    case 'get_variant_chart': {
      const chart = String(args.chart ?? '');
      const card = await catalog.getVariantChart!(chart);
      if (!card) {
        const available = await catalog.listVariantCharts!();
        return { error: 'variant chart not found', chart, available: available.map(b => b.slug) };
      }
      return card;
    }
    case 'list_variant_charts':
      return { charts: await catalog.listVariantCharts!() };
    case 'get_promotions': {
      const limit = Math.min(Number(args.limit) || 50, 100);
      const brand = args.brand ? String(args.brand) : undefined;
      return catalog.getPromotions!(limit, brand);
    }
    case 'get_quote': {
      const items = Array.isArray(args.items) ? (args.items as QuoteItem[]) : [];
      if (items.length === 0) return { error: 'items required' };
      const ref = args.ref ? String(args.ref) : undefined;
      return catalog.getQuote!(items, ref);
    }

    // ───────── sensitive tools: auth already checked by the caller, and the
    // ───────── ops adapter already proven to exist by the gate above ─────────
    case 'get_stock_bulk': {
      const skus = Array.isArray(args.skus) ? (args.skus as string[]).slice(0, 50) : [];
      if (skus.length === 0) return { error: 'skus required' };
      return ops!.getStockBulk(skus);
    }
    case 'get_top_products': {
      const days = Math.min(Number(args.days) || 30, 365);
      const limit = Math.min(Number(args.limit) || 10, 50);
      return ops!.getTopProducts(days, limit);
    }
    case 'get_recent_orders': {
      const limit = Math.min(Number(args.limit) || 20, 100);
      const status = args.status ? String(args.status) : undefined;
      return ops!.getRecentOrders(limit, status);
    }
    case 'get_order_status': {
      const shortId = String(args.short_id ?? '').trim();
      if (!shortId) return { error: 'short_id required' };
      const o = await ops!.getOrderStatus(shortId);
      return o ? { found: true, ...o } : { found: false, short_id: shortId };
    }
    case 'get_sales_summary': {
      const days = Math.min(Number(args.days) || 30, 365);
      return ops!.getSalesSummary(days);
    }

    default:
      throw new UnknownToolError(name);
  }
}

// ───────────────────────── JSON-RPC handler ─────────────────────────

function metaOf(params: unknown): Record<string, unknown> | undefined {
  const meta = (params as { _meta?: unknown } | undefined)?._meta;
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : undefined;
}

/** The protocol version a 2026-07-28 client stamps on every request's `_meta`, if any. */
export function metaVersionOf(params: unknown): string | undefined {
  const v = metaOf(params)?.[META_PROTOCOL_VERSION];
  return typeof v === 'string' ? v : undefined;
}

function metaVersion(req: JsonRpcRequest): string | undefined {
  return metaVersionOf(req.params);
}

/**
 * True when the caller speaks the stateless revision. Exact match, not a
 * string comparison: an unknown version is refused by `metaProblemOf`, never
 * quietly served as if it were the newest one we know.
 */
export function isModern(req: JsonRpcRequest): boolean {
  return metaVersion(req) === LATEST_PROTOCOL_VERSION;
}

/**
 * What the 2026-07-28 revision makes the server's job to reject in `_meta`:
 * a protocol version it does not serve (-32022, listing the ones it does),
 * and a modern request without the required `clientCapabilities` (-32602).
 * Null when fine, including for requests that stamp nothing (older revisions).
 */
export function metaProblemOf(params: unknown): { code: number; message: string; data?: unknown } | null {
  // A `_meta` that is present but not an object, or a version that is not a
  // string, is malformed — not "no _meta", which would serve it as legacy.
  if (params && typeof params === 'object' && !Array.isArray(params) && '_meta' in params) {
    const meta = (params as Record<string, unknown>)._meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return { code: -32602, message: 'Invalid params: _meta must be an object' };
    }
    const pv = (meta as Record<string, unknown>)[META_PROTOCOL_VERSION];
    if (pv !== undefined && typeof pv !== 'string') {
      return { code: -32602, message: `Invalid params: _meta.${META_PROTOCOL_VERSION} must be a string` };
    }
  }
  const v = metaVersionOf(params);
  if (v === undefined) return null;
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(v)) {
    return {
      code: -32022,
      message: `Unsupported protocol version "${v}"`,
      data: { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: v },
    };
  }
  if (v === LATEST_PROTOCOL_VERSION) {
    const caps = metaOf(params)?.[META_CLIENT_CAPABILITIES];
    if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
      return { code: -32602, message: `Invalid params: _meta is missing ${META_CLIENT_CAPABILITIES}` };
    }
  }
  return null;
}

/**
 * Caching attributes every list (and resources/read) result carries since
 * 2026-07-28. Anything that depends on the caller's privilege is `private`:
 * the sensitive tools, and the skill text that lists them.
 */
export function cacheable(authorized: boolean, ttlMs = LIST_TTL_MS): { ttlMs: number; cacheScope: 'public' | 'private' } {
  return { ttlMs, cacheScope: authorized ? 'private' : 'public' };
}

export function serverCapabilities() {
  // `resources` + the skills extension: the server ships its own instructions
  // as a skill (SEP-2640, src/lib/skills.ts).
  return { tools: {}, resources: {}, extensions: { [SKILLS_EXTENSION]: {} } };
}

export function serverInfo() {
  return { name: getServerName(), version: SERVER_VERSION, description: getServerDescription() };
}

/** `_meta` every 2026-07-28 result carries: who answered (ResultMeta serverInfo). */
export function resultMeta() {
  return { [META_SERVER_INFO]: { name: getServerName(), version: SERVER_VERSION } };
}

/**
 * server/discover (2026-07-28): versions, capabilities and identity, no
 * handshake. It is a CacheableResult, so it carries ttlMs/cacheScope; the
 * capabilities do not depend on the caller, so the scope is public. Identity
 * travels in `_meta`, where the schema puts it.
 */
export function discoverResult() {
  return {
    _meta: resultMeta(),
    resultType: 'complete',
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    capabilities: serverCapabilities(),
    instructions: SERVER_INSTRUCTIONS,
    ttlMs: LIST_TTL_MS,
    cacheScope: 'public',
  };
}

/** Legacy initialize: echo the client's version when it is a handshake revision we serve, else the default. */
export function initializeResult(requested: unknown) {
  const v =
    typeof requested === 'string' && HANDSHAKE_PROTOCOL_VERSIONS.includes(requested) ? requested : HANDSHAKE_DEFAULT_VERSION;
  return {
    resultType: 'complete',
    protocolVersion: v,
    capabilities: serverCapabilities(),
    serverInfo: serverInfo(),
    instructions: SERVER_INSTRUCTIONS,
  };
}

/** Which body field `Mcp-Name` mirrors, per method (2026-07-28 Streamable HTTP). */
const NAME_HEADER_FIELD: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'resources/read': 'uri',
  'prompts/get': 'name',
};

/** `Mcp-Name` may travel Base64-encoded behind a sentinel; servers decode before comparing. */
function decodeHeaderValue(v: string): string {
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}

/**
 * Streamable HTTP since 2026-07-28 mirrors body fields into headers so
 * intermediaries can route without parsing the body: `MCP-Protocol-Version`
 * (= `_meta` version), `Mcp-Method` (= method) and, for tools/call,
 * resources/read and prompts/get, `Mcp-Name` (= params.name / params.uri).
 * A header that contradicts the body is refused (-32020), never resolved by
 * picking one: a balancer routing on the header and a server executing the
 * body would otherwise be talking about different things. A request that
 * stamps a `_meta` version MUST carry the headers; a request that stamps
 * nothing (older revisions) is served without them, which the dual-era rule
 * of the transport allows. Batches predate 2025-06-18 and cannot be modern.
 */
/** A JSON-RPC error response, as `rpcError` builds it. */
export type RpcErrorResponse = ReturnType<typeof rpcError>;

export function headerMismatch(getHeader: (name: string) => string | undefined, body: unknown): RpcErrorResponse | null {
  if (Array.isArray(body)) {
    if (body.some(b => isJsonRpcRequest(b) && metaVersion(b) !== undefined)) {
      return rpcError(null, -32600, 'JSON-RPC batching is not part of revision 2026-07-28: send one request per POST');
    }
    for (const b of body) {
      if (!isJsonRpcRequest(b)) continue;
      const m = headerMismatch(getHeader, b);
      if (m) return m;
    }
    return null;
  }
  if (!isJsonRpcRequest(body)) return null; // the body check answers that one
  const version = metaVersion(body);
  const stamped = version !== undefined;
  const mismatch = (message: string) => rpcError(body.id, -32020, message);

  const hVersion = getHeader('mcp-protocol-version');
  if (!stamped && hVersion !== undefined) {
    // The header is the only version this request names. Unknown → refused
    // with the list we serve; the stateless revision → it had to stamp
    // `_meta`; a handshake revision → legacy traffic, served as before.
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(hVersion)) {
      return rpcError(body.id, -32022, `Unsupported protocol version "${hVersion}"`, {
        supported: SUPPORTED_PROTOCOL_VERSIONS,
        requested: hVersion,
      });
    }
    if (hVersion === LATEST_PROTOCOL_VERSION) {
      return rpcError(body.id, -32602, `Invalid params: MCP-Protocol-Version ${hVersion} requires _meta.${META_PROTOCOL_VERSION} in the body`);
    }
  }
  if (stamped && hVersion === undefined) return mismatch('Missing MCP-Protocol-Version header (required since revision 2025-06-18)');
  if (hVersion !== undefined && stamped && hVersion !== version) {
    return mismatch(`MCP-Protocol-Version header "${hVersion}" does not match the _meta protocol version "${version}"`);
  }

  const hMethod = getHeader('mcp-method');
  if (stamped && hMethod === undefined) return mismatch('Missing Mcp-Method header (required by revision 2026-07-28)');
  if (hMethod !== undefined && hMethod !== body.method) {
    return mismatch(`Mcp-Method header "${hMethod}" does not match the request method "${body.method}"`);
  }

  const field = NAME_HEADER_FIELD[body.method];
  if (field) {
    const bodyValue = (body.params as Record<string, unknown> | undefined)?.[field];
    const hName = getHeader('mcp-name');
    if (stamped && hName === undefined && typeof bodyValue === 'string') {
      return mismatch(`Missing Mcp-Name header for ${body.method} (it mirrors params.${field})`);
    }
    if (hName !== undefined && typeof bodyValue === 'string' && decodeHeaderValue(hName) !== bodyValue) {
      return mismatch(`Mcp-Name header does not match params.${field} "${bodyValue}"`);
    }
  }
  return null;
}

/**
 * The HTTP status a JSON-RPC response travels with. Legacy traffic keeps 200
 * for everything (its clients read the body). For a request that stamps a
 * 2026-07-28 `_meta`: unknown method is 404 (so a client can tell "modern
 * server without that method" from "no MCP endpoint here"), and malformed
 * requests, header mismatches, bad versions and bad `_meta` are 400.
 */
export function httpStatusFor(req: JsonRpcRequest | null, response: unknown): number {
  const error = (response as { error?: { code?: unknown } } | null)?.error;
  if (!error || typeof error.code !== 'number') return 200;
  const code = error.code;
  if (code === -32700 || code === -32600 || code === -32020 || code === -32021 || code === -32022) return 400;
  if (req && metaVersion(req) !== undefined) {
    // 404 means "this server does not implement that RPC method"; an unknown
    // tool inside tools/call is -32601 too, but the method exists.
    if (code === -32601 && !IMPLEMENTED_METHODS.has(req.method)) return 404;
    if (code === -32602 && metaProblemOf(req.params)) return 400;
  }
  return 200;
}

/**
 * One POST body, both HTTP transports (the CLI's --http and the Next route):
 * shape check, header validation, dispatch, status. A body that is not a
 * request object (`null`, a number, a response) is answered, never executed —
 * before this guard a bare `null` reached `body.method` and took the process
 * down. Returns null for a notification (the transport answers 202).
 */
export async function handleHttpBody(
  body: unknown,
  getHeader: (name: string) => string | undefined,
  authorized: boolean,
  ctx: CallContext = DEFAULT_CONTEXT,
): Promise<{ status: number; payload: unknown } | null> {
  if (Array.isArray(body)) {
    if (body.length === 0) return { status: 400, payload: rpcError(null, -32600, 'Invalid Request: empty batch') };
    const mismatch = headerMismatch(getHeader, body);
    if (mismatch) return { status: 400, payload: mismatch };
    const responses = (
      await Promise.all(
        body.map(b =>
          !isJsonRpcRequest(b)
            ? rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC request object')
            : isNotification(b)
              ? null
              : handleRequest(b, authorized, ctx),
        ),
      )
    ).filter(r => r !== null);
    return { status: 200, payload: responses };
  }
  if (!isJsonRpcRequest(body)) {
    return { status: 400, payload: rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC request object') };
  }
  const mismatch = headerMismatch(getHeader, body);
  if (mismatch) return { status: 400, payload: mismatch };
  if (isNotification(body)) {
    // Accepted (202) once its headers and `_meta` check out; nothing here has
    // an effect to run for a notification, and a reply would need an id.
    const problem = metaProblemOf(body.params);
    if (problem) return { status: 400, payload: rpcError(null, problem.code, problem.message, problem.data) };
    return null;
  }
  const response = await handleRequest(body, authorized, ctx);
  if (response === null) return null;
  return { status: httpStatusFor(body, response), payload: response };
}

export async function handleRequest(
  req: JsonRpcRequest,
  authorized: boolean,
  ctx: CallContext = DEFAULT_CONTEXT,
) {
  // 2026-07-28 makes two things the server's job before any method runs: a
  // version it does not serve is refused with the list of the ones it does,
  // and a modern request without clientCapabilities is malformed.
  const problem = metaProblemOf(req.params);
  if (problem) return rpcError(req.id, problem.code, problem.message, problem.data);
  const response = await dispatch(req, authorized, ctx);
  // Modern results say who answered (ResultMeta serverInfo); discover already does.
  if (response && 'result' in response && isModern(req) && req.method !== 'server/discover') {
    const result = response.result as Record<string, unknown>;
    return { ...response, result: { _meta: resultMeta(), ...result } };
  }
  return response;
}

async function dispatch(req: JsonRpcRequest, authorized: boolean, ctx: CallContext) {
  // Every list here fits in one page and no result ever carries nextCursor, so
  // a cursor can only be stale or made up; answering it with the full list
  // would hide a client bug (pagination: invalid cursor → -32602).
  if (LIST_METHODS.has(req.method) && hasCursor(req.params)) return rpcError(req.id, -32602, CURSOR_MESSAGE);
  switch (req.method) {
    case 'server/discover':
      return rpcResult(req.id, discoverResult());

    case 'initialize':
      return rpcResult(req.id, initializeResult((req.params as { protocolVersion?: unknown } | undefined)?.protocolVersion));

    case 'notifications/initialized':
      return null; // notification: no response

    case 'tools/list':
      // The privilege boundary, part 1: unauthenticated callers don't even
      // SEE the sensitive tools. The shop window is public; the back office
      // is not on the map.
      return rpcResult(req.id, { resultType: 'complete', ...cacheable(authorized), tools: visibleTools(authorized) });

    case 'tools/call': {
      const params = (req.params || {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = params.name ?? '';
      // The privilege boundary, part 2: even if a caller guesses a sensitive
      // tool's name, the call is rejected before any adapter code runs.
      if (SENSITIVE_TOOLS.has(name) && !authorized) {
        return rpcError(req.id, -32001, `Tool '${name}' requires authentication (Bearer MCP_SECRET)`);
      }
      try {
        const result = await callTool(name, params.arguments ?? {}, ctx);
        return rpcResult(req.id, {
          resultType: 'complete',
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        // -32601 for an unknown tool is what this server has always answered,
        // and clients may rely on it, so it stays. It is NOT a missing RPC
        // method, though: httpStatusFor only turns -32601 into 404 when the
        // method itself is one dispatch does not implement.
        if (e instanceof UnknownToolError) return rpcError(req.id, -32601, e.message);
        // Quota and capability refusals carry their own code so an agent can
        // tell "not acceptable, back off" from "here is a result you dislike".
        if (e instanceof ToolCallError) return rpcError(req.id, e.code, e.message);
        return rpcError(req.id, -32603, `Tool error: ${(e as Error).message}`);
      }
    }

    // ───────── Skills over MCP (SEP-2640): one skill, served as resources ─────────
    case 'resources/list':
      return rpcResult(req.id, { resultType: 'complete', ...cacheable(authorized), resources: skillResourceList() });

    case 'resources/templates/list':
      return rpcResult(req.id, { resultType: 'complete', ...cacheable(false), resourceTemplates: [] });

    case 'resources/read': {
      const uri = (req.params as { uri?: unknown } | undefined)?.uri;
      if (typeof uri !== 'string') return rpcError(req.id, -32602, 'Invalid params: resources/read requires params.uri');
      const file = readSkillResource(uri, skillContext(authorized));
      // "Resource not found" is -32602 since 2026-07-28; older revisions used -32002.
      if (!file) return rpcError(req.id, isModern(req) ? -32602 : -32002, `Resource not found: ${uri}`);
      return rpcResult(req.id, { resultType: 'complete', ...cacheable(authorized, RESOURCE_TTL_MS), contents: [file] });
    }

    case 'skills/list':
      return rpcResult(req.id, {
        resultType: 'complete',
        ...cacheable(authorized),
        skills: [skillEntry(skillContext(authorized))],
      });

    case 'skills/get': {
      const uri = (req.params as { uri?: unknown } | undefined)?.uri;
      if (typeof uri !== 'string') return rpcError(req.id, -32602, 'Invalid params: skills/get requires params.uri (the SKILL.md URI)');
      if (uri !== SKILL_URI) {
        return rpcError(req.id, -32602, `Unknown skill: ${uri}. This server serves ${SKILL_URI}.`);
      }
      return rpcResult(req.id, {
        resultType: 'complete',
        ...cacheable(authorized),
        skill: skillEntry(skillContext(authorized)),
      });
    }

    case 'ping':
      return rpcResult(req.id, { resultType: 'complete' });

    default:
      return rpcError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

/** GET discovery descriptor shared by the Next route and the CLI HTTP mode. */
export function discoveryDescriptor(transport: 'streamable-http' | 'http') {
  // No placeholder domain: a descriptor that points every unconfigured
  // deployment at the same example URL is worse than one field short.
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || '').trim().replace(/\/$/, '');
  return {
    name: getServerName(),
    version: SERVER_VERSION,
    description: getServerDescription(),
    protocolVersion: LATEST_PROTOCOL_VERSION,
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    transport,
    ...(siteUrl ? { docs: `${siteUrl}/llms.txt` } : {}),
    tools: visibleTools(false).map(t => t.name),
    extensions: [SKILLS_EXTENSION],
    skills: [SKILL_URI],
  };
}
