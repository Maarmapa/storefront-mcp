# storefront-mcp

**An MCP server template for e-commerce storefronts.** AI agents get your
catalog; only you get your back office.

*(Español más abajo / Spanish below.)*

---

## Quickstart (30 seconds)

```bash
npx storefront-mcp
```

That starts an MCP server over **stdio** serving a demo catalog (the bundled
`memory` adapter) with the 8 public tools — 6 read tools plus the two write
tools, which start in **dry mode**: they run every check and then create
nothing. Plug it into Claude Desktop or
Claude Code by adding this to your MCP config (`claude_desktop_config.json`,
or `claude mcp add storefront -- npx storefront-mcp`):

```json
{
  "mcpServers": {
    "storefront": {
      "command": "npx",
      "args": ["storefront-mcp"]
    }
  }
}
```

Want the 5 back-office tools too? On stdio there is no HTTP header, so the
gate is the presence of `MCP_SECRET` in the server process env — whoever
launches the process owns the machine it runs on:

```json
{
  "mcpServers": {
    "storefront": {
      "command": "npx",
      "args": ["storefront-mcp"],
      "env": { "MCP_SECRET": "anything-non-empty" }
    }
  }
}
```

Prefer curl? `npx storefront-mcp --http 8787` serves the same JSON-RPC
contract over plain HTTP on localhost, with the real
`Authorization: Bearer <MCP_SECRET>` check (same behavior as the Next.js
route below):

```bash
npx storefront-mcp --http 8787 &
curl -s http://127.0.0.1:8787/ -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Pick the adapter with `CATALOG_ADAPTER` (`memory` by default,
`woocommerce` for the Store API skeleton). To serve your own catalog, write
an adapter (see below) — the CLI, the Next.js route and the registry entry
(`server.json`) all reuse the same tool definitions and privilege boundary.

## What is this

A [Model Context Protocol](https://modelcontextprotocol.io) server, packaged
as a Next.js App Router route, that exposes an online store to AI agents
(Claude, custom GPTs, agent frameworks — anything that speaks MCP over
Streamable HTTP). It ships with **13 tools**:

| Public read (no auth) | Public write (guarded) | Sensitive (Bearer token) |
| --- | --- | --- |
| `search_products` | `create_checkout` | `get_stock_bulk` |
| `get_product` | `subscribe_stock_alert` | `get_top_products` |
| `get_color_card` | | `get_recent_orders` |
| `list_brands` | | `get_order_status` |
| `get_promotions` | | `get_sales_summary` |
| `get_quote` | | |

The write tools are public on purpose — an agent buying on a human's behalf is
the point — so their protection is behavioral, not a token. They only appear
when the active adapter can honor them, and they start in dry mode. See
[the guard rails](#the-second-design-what-a-write-tool-must-refuse).

It is extracted from a production storefront server, with everything
store-specific removed and replaced by a clean adapter interface.

## Why

AI agents are becoming a sales channel. When someone asks their assistant
"find me a warm gray alcohol marker in stock near me", the stores that win
are the ones the agent can actually *query*: structured search, real
availability, a quote with a payment link. A public MCP endpoint is how your
store shows up in that conversation — on your own domain, with your own data,
under your own rules.

## The core design: privilege separation

**An agent may browse the shop window; it never sees the operation.**

Every tool is either *public* or *sensitive*, and the boundary is enforced
twice in the protocol layer (`src/lib/protocol.ts`, shared by the Next.js
route and the standalone CLI):

1. **`tools/list`** — without a valid `Authorization: Bearer <MCP_SECRET>`
   header, only the public tools are returned. Sensitive tools are not merely
   locked; they are invisible.
2. **`tools/call`** — a caller who guesses a sensitive tool's name anyway gets
   JSON-RPC error **`-32001`** before any data code runs.

The check is **fail-closed**: if the `MCP_SECRET` env var is not set, the
sensitive tools are blocked for everyone. There is no
"nothing-configured-so-everything-is-open" mode. Token comparison is
constant-time.

Transport nuance: over HTTP (the Next.js route and `--http` mode) the gate is
the Bearer header, because remote callers are untrusted. Over **stdio**
(`npx storefront-mcp`) there is no header — the client and server share a
machine — so the gate is whether `MCP_SECRET` exists in the server process
env. Same boundary, enforced at the trust seam each transport actually has.

The same split exists at the data layer: the `CatalogAdapter` interface only
knows public storefront data, and the optional `OpsAdapter` (orders, revenue,
exact stock) is a separate contract you can simply not implement — in which
case sensitive tools return an error even to authenticated callers. Ops
implementations must anonymize customer PII: line items carry name/qty/price,
never emails, addresses or phone numbers, even behind auth.

## The second design: what a write tool must refuse

A read tool that is wrong says something inaccurate. A write tool that is
wrong sells stock you do not have, or points a mail cannon at a stranger — at
machine speed, in a retry loop, with nobody in the room.

So the interesting part of `create_checkout` and `subscribe_stock_alert` is not
what they do. It is what they refuse to do, and **the refusals that protect a
third party are not configurable**. You can switch the effect off entirely
(dry mode, kill switch); you cannot keep the effect and drop the check.

Each guard rail below is followed by *what breaks without it*. That is the part
worth copying — the tools themselves are a few hundred lines you could write in
an afternoon.

### Checkout

**1. Availability is checked against the inventory source, not the catalog.**
"Published and purchasable" and "there are units" are two different questions,
and almost every e-commerce stack answers them in two different systems (CMS
vs. ERP/POS). *Without it:* the tool resolves each line against the sellable-catalog
index, hands it to the pricing code — which only knows prices — and no
inventory query happens anywhere on the path. An agent orders 50 units of
something you have 2 of and gets a real order plus a payable link.

**2. "I don't know" blocks exactly like "there is none".** Availability is
tri-state: `{units: n, verified: true}`, `{units: 0, verified: true}`,
`{units: null, verified: false}`. *Without it:* the result gets modeled as a
number, so every failure degrades to either `0` (silently blocking real sales)
or "assume it's fine" (selling air). The three real "I don't know" cases —
variant not mapped in the inventory system, no row in the stock snapshot,
backend down — are none of them zero. Before charging a human, unknown and
unavailable are worth the same.

**3. Duplicate lines are consolidated before any limit or stock check.**
*Without it:* a per-line cap of 50 units is decorative. Twenty lines of the
same SKU at qty 50 is 1,000 units, and the stock check passes too — with 60 in
the warehouse each 50-unit line "fits" on its own. Every aggregate limit must
be measured on the canonical form of the input, not on the shape the caller
happened to write.

**4. An invalid quantity is rejected, never repaired.**
`Math.min(Math.max(Math.floor(Number(qty) || 1), 1), 50)` reads like input
sanitizing. *Without it:* `{qty: 0}` — which from an agent means "remove this"
— becomes one unit billed to a human, and negatives, `NaN` and fractions
become invented sales. In a tool that takes money, sanitizing means rejecting
and explaining; rewriting input into something plausible is fabricating intent.

**5. Prices are never accepted from the caller.** There is no price field in
the input schema at all; every unit price and total is computed server-side
from the catalog on that request. *Without it:* your discount policy is
whatever the caller types.

**6. The refusal ships with its evidence.** Every line comes back with
`stock_available` and `stock_verified`, success or failure. *Without it:* the
tool that reports exact stock is token-gated (it is back-office data), so the
public agent cannot diagnose anything, retries blindly, and tells the human a
made-up reason. If your privilege boundary denies the agent the diagnostic
tool, the write tool owes it the diagnosis.

**7. One bad line blocks the whole cart.** *Without it:* the human receives an
order for "the items that happened to pass", which is a cart nobody asked for.

### Back-in-stock alerts

**8. An outward effect needs a server-side business precondition.** The email
only goes out if the product is really unavailable — verified zero, or the
catalog independently saying out of stock when units cannot be verified.
*Without it:* a public tool that emails an address chosen by the caller is a
mail cannon aimed at third parties. Loop `tools/call` with
`{email: victim@company.com, slug: <anything>}` and thousands of perfectly
legitimate-looking messages leave your domain, burning credits and sender
reputation, hitting someone who never contacted the store. (Bonus: it also
kills the false "it's back!" alert about a product that never left.)

**9. Dedupe at the point of the irreversible effect, failing closed.** The
check happens before the send, and *if the lookup itself fails, nothing is
sent.* *Without it:* the same call repeated N times sends N emails even though
the final insert is idempotent — idempotent storage protects nothing when the
expensive part happens first. And a backend that is down must never be
promoted into permission to emit.

**10. The quota is keyed by recipient, not by IP.** Three confirmation emails
per hour per address, evaluated independently of any caller limit. *Without
it:* the limit is trivially bypassed by rotating IPs (and on serverless it is
already split across instances). The victim of the abuse is not an IP — it is
somebody's mailbox. Key the limit to the resource you are protecting.

**11. The automated email never goes to the address the caller chose.** In a
web checkout you mail the customer and the admin. In an MCP tool the
`customer_email` was typed by an *agent*. *Without it:* wiring "order
confirmation" into the write tool re-opens the exact cannon the alert tool just
closed. Rule: an address arriving as tool input may receive one double-opt-in
message and nothing else; any other mail needs prior proof of intent — which is
what paying is. Operator notifications go to a fixed configured address.

**12. Double opt-in with a properly built token.** `v1.<payload>.<hmac>`, the
expiry **inside** the signed payload, timing-safe comparison, and fail-closed
when no signing secret is set (the tool answers "opt-in unavailable" instead of
subscribing directly). *Without it:* unsigned tokens are forged; an expiry
stored beside the token instead of inside it gets ignored; `===` on a signature
leaks it byte by byte; and a missing env var becomes an open door. Outwardly,
"no secret", "malformed" and "bad signature" share one message — only "expired"
is distinguished, because it is actionable for the human and useless to an
attacker.

**13. GET renders, POST writes.** The confirmation page performs zero writes on
GET; only a POST with the token in a form body persists anything. *Without it:*
corporate mail gateways (Safe Links, URL Defense, desktop AV, client prefetch)
fetch every link in every message at delivery. Send a confirmation to a victim's
address and their own employer's security scanner activates the subscription —
the third-party opt-in you built double opt-in to prevent, re-entered through
the back door. Scanners follow links; they do not submit forms. This
generalizes to anything triggered from an emailed link: confirm, cancel,
approve, unsubscribe. The write is also idempotent, so a double-click is a
success rather than a support ticket.

### Both tools

**14. Dry by default, with a per-tool kill switch.** `CHECKOUT_MODE` and
`STOCK_ALERT_MODE` are `dry` unless explicitly set to `live`; `off` removes the
tool from `tools/list` entirely. A dry call runs every check and then answers
with exactly what it would have done — including "this would have been BLOCKED,
here is why". *Without it:* a write tool that arms itself by being deployed has
no rehearsal — its first real invocation is in production, against money. Only
the exact string `live` reaches live, so a typo fails towards doing nothing.

**15. A tool that cannot be honest is not announced.** `tools/list` is
capability-gated: no `CheckoutAdapter` *and* `InventoryAdapter`, no
`create_checkout`. *Without it:* you ship a checkout tool with no inventory
source, so either every call is blocked (a tool that can never succeed) or —
worse — someone "fixes" it by trusting the catalog.

**16. The limit description matches the limit.** The error names both tools and
says the quota is shared; the tool descriptions say the same. *Without it:* an
agent alternating the two tools hits a wall earlier than announced, concludes
the counter is per-tool, and retries — the rate limit generating the traffic it
exists to stop. For an MCP server, tool descriptions and error strings are the
agent-facing API, and a mis-described limit is paid in retries.

### About that rate limiter (the honest version)

The bundled limiter is a `Map` in the memory of one process. On serverless that
means **N warm instances = N independent quotas**, a cold start resets the
counter, and a redeploy erases it. It is friction against an agent loop, not a
WAF and not an abuse control, and it is labelled that way in
`src/lib/ratelimit.ts` rather than presented as a ceiling the team does not
actually have.

That is exactly why the limits that matter are attached to the **effect**
rather than to the request counter: fail-closed availability, the out-of-stock
precondition, dedupe on (recipient, product), the per-recipient email quota,
double opt-in, and the kill switch. Those are business invariants — they hold
no matter how many instances are running.

`rateLimited(key, max, windowMs)` is a small synchronous port with a single
call-site shape, so swapping the in-memory store for Redis/KV/Durable Objects
is mechanical. Do that before you rely on the counter for anything.

## Configuration for the write tools

| Env var | Default | What it does |
| --- | --- | --- |
| `CHECKOUT_MODE` | `dry` | `off` \| `dry` \| `live` for `create_checkout` |
| `STOCK_ALERT_MODE` | `dry` | `off` \| `dry` \| `live` for `subscribe_stock_alert` |
| `STOCK_ALERT_SIGNING_SECRET` | *(unset)* | HMAC key for opt-in links. Unset ⇒ no link can be issued and the tool refuses — it never subscribes without confirmation. `openssl rand -hex 32` |
| `STOCK_ALERT_CONFIRM_URL` | `${NEXT_PUBLIC_SITE_URL}/api/stock-alert/confirm` | Where the confirmation page lives |

A tool is announced only when the active adapter provides the capability, so
none of the above resurrects a tool the adapter cannot honor.

## Trying the guard rails in 60 seconds

The bundled toy catalog is arranged so every state shows up. `chromaflow-classic-set-12`
has **4** units; `CF-G09` is a catalogued color with **no inventory row**; and
`fieldbook-sketch-a5` is published as `in_stock` with **zero** units — the
oversell shape itself.

```bash
npx storefront-mcp --http 8787 &

# Consolidation + fail-closed: two lines of 3 for a product with 4 units.
# Per line each one "fits". Together they do not.
curl -s http://127.0.0.1:8787/ -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_checkout","arguments":{
    "items":[{"slug":"chromaflow-classic-set-12","qty":3},{"slug":"chromaflow-classic-set-12","qty":3}]}}}'
# → blocked, qty_requested 6, merged_from_input_lines 2, stock_available 4

# Unverifiable stock blocks like zero:
#   "items":[{"sku":"CF-G09","qty":1}]   → stock_verified:false, blocked

# Quantities are rejected, not repaired:
#   "items":[{"slug":"fieldbook-sketch-a5","qty":0}] → items_invalid_qty, qty_received 0
```

## Quickstart as a web endpoint (2 minutes)

To serve MCP from your own domain (the deployable Next.js route):

```bash
git clone <this repo> && cd storefront-mcp
npm install
npm run dev
```

That's it — the default `memory` adapter serves the toy catalog in
`examples/toy-catalog.json` (a fictional store, "Demo Art Supply"). Try it:

```bash
# descriptor
curl http://localhost:3000/api/mcp

# list tools (public only — no token sent)
curl -s http://localhost:3000/api/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# search
curl -s http://localhost:3000/api/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_products","arguments":{"query":"leather dye"}}}'

# a sensitive tool without a token → -32001
curl -s http://localhost:3000/api/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_sales_summary","arguments":{}}}'

# now with the token
export MCP_SECRET=$(openssl rand -hex 32)   # also set it in .env.local and restart
curl -s http://localhost:3000/api/mcp -H 'content-type: application/json' \
  -H "authorization: Bearer $MCP_SECRET" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_sales_summary","arguments":{}}}'
```

To connect it to Claude Code: `claude mcp add --transport http my-store
http://localhost:3000/api/mcp`.

## Writing your own adapter

The protocol layer never touches data directly. It calls the interfaces
defined in `src/lib/adapter.ts`. Only the first is required — **every other one
is a capability, and capabilities decide which tools exist**:

- **`CatalogAdapter`** (required) — `searchProducts`, `getProduct`,
  `listBrands`, `getColorCard`, `getPromotions`, `getQuote`. Public by
  definition: assume every byte it returns is world-readable.
- **`OpsAdapter`** — `getStockBulk`, `getTopProducts`, `getRecentOrders`,
  `getOrderStatus`, `getSalesSummary`. Enables the token-gated tools.
- **`InventoryAdapter`** — `getAvailability(refs)`, returning
  `{units, verified, reason}` per line. This is the "how many units right now"
  source, and it must be the same one your read tools use.
- **`CheckoutAdapter`** — `createCheckout(draft)`. Announced only alongside an
  `InventoryAdapter`.
- **`NotifyAdapter`** — `isSubscribed` / `sendOptInEmail` /
  `confirmSubscription`.

An adapter that implements none of the new ones keeps working exactly as
before: the write tools are simply never announced. That is a supported
configuration, not a degraded one.

Steps:

1. Copy `src/lib/adapters/memory.ts` (the reference implementation) to a new
   file and point it at your database / API / ERP.
2. Register it in `src/lib/adapters/index.ts` and select it with the
   `CATALOG_ADAPTER` env var.
3. Keep the contract's honesty rules:
   - return `units: null` / `stock: null` when you could not verify
     availability — **never invent a number, and never fall back to 0**;
   - serve every stock answer from one source, so the write path cannot
     validate against something different from what the customer was shown;
   - subtract what is already committed elsewhere (open holds, other channels)
     — "on the shelf" is not "sellable to this customer";
   - let `isSubscribed` throw on failure instead of returning `false`; the
     caller fails closed and sends nothing;
   - set a per-call timeout so a hung backend degrades into a note instead of
     a hung agent;
   - keep `get_quote` charge-free, and make `getQuote` echo the `slug`/`sku`
     it was given on each priced line (the checkout path matches lines by that
     reference).

A **WooCommerce skeleton** (`src/lib/adapters/woocommerce.ts`) is included,
built on the public Store API, with TODOs marking what you need to fill in
(variant charts, quoting strategy, and the three write-side contracts). It
deliberately implements only the catalog side — so with that adapter selected,
the write tools do not appear at all.

## Discovery: getting found

Agents can only call what they can find. Two artifacts, templates in
`discovery/`:

- **`/.well-known/mcp.json`** — machine-readable descriptor
  (`discovery/well-known-mcp.json`; replace `{{DOMAIN}}`, serve from
  `public/.well-known/mcp.json`). List only public tools in it.
- **`/llms.txt`** — human/LLM-readable site guide
  (`discovery/llms-txt-snippet.md`); includes an agent policy section: re-check
  stock before closing a sale, quotes never charge, `stock: null` means
  unknown.

Additionally, `GET /api/mcp` returns a JSON descriptor so anyone poking the
endpoint understands what it is.

For the official [MCP Registry](https://registry.modelcontextprotocol.io),
`server.json` at the repo root is the manifest: it points at the
`storefront-mcp` npm package with stdio transport, so registry clients can
run it via `npx`.

## Serving MCP from your WordPress domain

If your storefront runs WordPress/WooCommerce but the MCP server deploys
elsewhere (e.g. Vercel), `wordpress-proxy/mcp-proxy.php` is a **mu-plugin**
that serves `https://yourshop.com/api/mcp` by proxying to the upstream:

- hooks `init` at priority 0 (answers before WordPress routing),
- forwards POST bodies and the `Authorization` header untouched (the upstream
  enforces the privilege split),
- handles CORS preflight, answers GET with a readable descriptor,
- caps payloads at 256 KB,
- on upstream failure returns a JSON-RPC error object — never an HTML error
  page, because the client is a program.

Install: drop the file in `wp-content/mu-plugins/` and define
`STOREFRONT_MCP_UPSTREAM` in `wp-config.php`.

## Why not just Shopify's MCP?

If you are on Shopify: Shopify already gives every store a hosted MCP endpoint
with a generic `search_catalog`-style tool, and it is good. Use it. This
template is for the cases it does not cover:

- **You are not on Shopify** — WooCommerce, custom stack, headless, an ERP
  from 2009 that somehow still works.
- **Your differentiator is a tool the platform will never generate.** The
  worked example here is `get_color_card`: the full variant chart of a product
  line with *live stock per variant*. Any store can say "we sell these
  markers"; only the store that wired its own inventory can say "shade W3 is in
  stock right now, shade R21 is not". That per-variant answer closes sales, and
  it needs domain knowledge no generic platform tool has.
- **You want the privilege-separated back office** — the same endpoint, with a
  token, answering "what were my top sellers this month?" to *you* while
  showing agents only the shop window.
- **You want write tools you can actually defend.** A hosted platform decides
  for you what its checkout tool checks. Here the refusals are in your repo,
  reviewable, and the ones that protect a third party are not configurable.

## Repository layout

```
src/lib/protocol.ts           protocol core (JSON-RPC, auth boundary, dispatch) — shared by both transports
src/app/api/mcp/route.ts      Next.js transport (Streamable HTTP + Bearer)
src/cli/cli.ts                standalone transport: `npx storefront-mcp` (stdio via the official MCP SDK, or --http)
src/lib/tools.ts              tool definitions (incl. mode-aware write tools) + SENSITIVE_TOOLS set
src/lib/adapter.ts            the five adapter contracts + types
src/lib/commerce.ts           create_checkout / subscribe_stock_alert — the guard rails
src/lib/availability.ts       tri-state availability, degrade-don't-invent, blocksWrite()
src/lib/cart.ts               consolidate first, then measure limits; reject bad quantities
src/lib/optin.ts              signed double opt-in tokens (exp inside payload, fail-closed)
src/lib/ratelimit.ts          rateLimited(key,max,window) + what an in-memory limiter is NOT
src/lib/client-ip.ts          one caller resolver for both transports (last hop, not first)
src/lib/write-mode.ts         off | dry | live per tool
src/lib/errors.ts             ToolCallError (quota / capability refusals)
src/app/api/stock-alert/confirm/route.ts  GET renders, POST writes
src/lib/adapters/memory.ts    reference adapter (all five contracts, one stock source)
src/lib/adapters/woocommerce.ts  Store API skeleton with TODOs (catalog only)
src/lib/adapters/index.ts     adapter registry (env CATALOG_ADAPTER)
examples/toy-catalog.json     the demo data, incl. a separate `inventory` section
server.json                   MCP Registry manifest (registry.modelcontextprotocol.io)
tsconfig.build.json           compiles lib + cli to dist/ for the npm bin
discovery/                    /.well-known/mcp.json + llms.txt templates
wordpress-proxy/mcp-proxy.php mu-plugin to serve MCP under your WP domain
```

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

---

# storefront-mcp (Español)

**Plantilla de servidor MCP para tiendas online.** Los agentes de IA ven tu
catálogo; tu operación la ves solo tú.

## Partir en 30 segundos

```bash
npx storefront-mcp
```

Eso levanta un servidor MCP por **stdio** con un catálogo de demostración (el
adaptador `memory`) y las 8 tools públicas: 6 de lectura más las dos de
escritura, que arrancan en **modo dry** (corren todas las verificaciones y no
crean nada). Para conectarlo a Claude Desktop
o Claude Code, agrega esto a tu configuración MCP (o ejecuta
`claude mcp add storefront -- npx storefront-mcp`):

```json
{
  "mcpServers": {
    "storefront": {
      "command": "npx",
      "args": ["storefront-mcp"]
    }
  }
}
```

¿Quieres también las 5 tools de trastienda? En stdio no existe el header
HTTP, así que la llave es la **presencia** de `MCP_SECRET` en el entorno del
proceso del servidor (quien lanza el proceso es dueño de la máquina donde
corre):

```json
{
  "mcpServers": {
    "storefront": {
      "command": "npx",
      "args": ["storefront-mcp"],
      "env": { "MCP_SECRET": "cualquier-valor-no-vacio" }
    }
  }
}
```

¿Prefieres curl? `npx storefront-mcp --http 8787` sirve el mismo contrato
JSON-RPC por HTTP en localhost, con el chequeo real de
`Authorization: Bearer <MCP_SECRET>` (mismo comportamiento que la ruta de
Next.js). El adaptador se elige con `CATALOG_ADAPTER` (`memory` por defecto,
`woocommerce` para el esqueleto de la Store API).

## Qué es

Un servidor [MCP](https://modelcontextprotocol.io) empaquetado como ruta de
Next.js (App Router) que expone una tienda online a agentes de IA (Claude,
GPTs personalizados, frameworks de agentes — cualquier cliente MCP sobre
Streamable HTTP). Trae **13 tools**:

- 6 públicas de lectura: `search_products`, `get_product`, `get_color_card`,
  `list_brands`, `get_promotions`, `get_quote`.
- 2 públicas de escritura, con guard rails: `create_checkout` y
  `subscribe_stock_alert`.
- 5 sensibles protegidas por token: `get_stock_bulk`, `get_top_products`,
  `get_recent_orders`, `get_order_status`, `get_sales_summary`.

Las tools de escritura son públicas a propósito — que un agente compre por
encargo de una persona es justamente el punto — así que su protección está en
el comportamiento, no en un token. Solo aparecen cuando el adaptador activo
puede cumplirlas, y arrancan en modo dry. Ver
[los guard rails](#el-segundo-diseño-qué-tiene-que-rechazar-una-tool-de-escritura).

Está extraído de un servidor de tienda en producción, con todo lo específico
de esa tienda removido y reemplazado por una interfaz de adaptadores.

## Por qué

Los agentes de IA se están convirtiendo en un canal de venta. Cuando alguien
le pide a su asistente "búscame un marcador gris cálido con stock", ganan las
tiendas que el agente puede *consultar* de verdad: búsqueda estructurada,
disponibilidad real, una cotización con link de pago. Un endpoint MCP público
es la forma de aparecer en esa conversación — en tu propio dominio, con tus
datos y tus reglas.

## El diseño central: separación de privilegios

**Un agente puede mirar la vitrina; nunca ve la operación.**

Cada tool es *pública* o *sensible*, y el límite se aplica dos veces en la
capa de protocolo:

1. **`tools/list`** — sin un `Authorization: Bearer <MCP_SECRET>` válido,
   solo se devuelven las tools públicas. Las sensibles no están bloqueadas:
   son invisibles.
2. **`tools/call`** — quien adivine el nombre de una tool sensible recibe el
   error JSON-RPC **`-32001`** antes de que corra cualquier código de datos.

El chequeo es **fail-closed**: si `MCP_SECRET` no está definido en el
entorno, las tools sensibles quedan bloqueadas para todos. No existe el modo
"no configuré nada, entonces todo queda abierto". La comparación del token es
de tiempo constante.

Matiz por transporte: sobre HTTP (la ruta de Next.js y el modo `--http`) la
llave es el header Bearer, porque quien llama desde afuera no es de
confianza. Sobre **stdio** (`npx storefront-mcp`) no hay header — cliente y
servidor comparten la máquina — así que la llave es que `MCP_SECRET` exista
en el entorno del proceso. Es el mismo límite, aplicado en la costura de
confianza que cada transporte realmente tiene.

La misma separación existe en la capa de datos: `CatalogAdapter` solo conoce
datos públicos de vitrina, y el `OpsAdapter` (órdenes, ventas, stock exacto)
es un contrato aparte que puedes simplemente no implementar. Las
implementaciones de ops deben anonimizar la información de clientes: los
ítems llevan nombre/cantidad/precio, nunca correos, direcciones ni teléfonos,
incluso detrás de la autenticación.

## El segundo diseño: qué tiene que rechazar una tool de escritura

Una tool de lectura equivocada dice algo inexacto. Una tool de escritura
equivocada vende stock que no existe, o apunta un cañón de correo contra un
tercero — a velocidad de máquina, en un loop de reintentos, sin nadie mirando.

Por eso lo interesante de `create_checkout` y `subscribe_stock_alert` no es lo
que hacen, sino lo que se niegan a hacer, y **los rechazos que protegen a un
tercero no son configurables**. Se puede apagar el efecto completo (modo dry,
kill switch); no se puede conservar el efecto y quitar la verificación.

Cada guard rail viene con *qué se rompe sin él*. Esa es la parte que vale la
pena copiar: las tools en sí son unos cientos de líneas que cualquiera escribe
en una tarde.

### Checkout

**1. La disponibilidad se verifica contra el inventario, no contra el
catálogo.** "Publicado y comprable" y "hay unidades" son dos preguntas
distintas, y casi todo stack de e-commerce las responde en dos sistemas
distintos (CMS vs. ERP/POS). *Sin esto:* la tool resuelve cada línea contra el
índice de catálogo vendible, se la pasa al cotizador — que solo sabe de precios
— y en todo el camino no hay una sola consulta de inventario. Un agente pide 50
unidades de algo de lo que hay 2 y recibe un pedido real con link de pago
cobrable.

**2. "No sé" bloquea igual que "no hay".** La disponibilidad es tri-estado:
`{units: n, verified: true}`, `{units: 0, verified: true}`,
`{units: null, verified: false}`. *Sin esto:* el resultado se modela como
número y todo error degrada a `0` (bloqueando ventas legítimas en silencio) o a
"asumamos que hay" (vendiendo aire). Los tres casos reales de "no sé" — variante
sin mapear en inventario, producto sin fila en el snapshot, backend caído — no
son cero. Antes de cobrarle a alguien, desconocido y agotado valen lo mismo.

**3. Las líneas duplicadas se consolidan antes de cualquier tope o chequeo de
stock.** *Sin esto:* un tope de 50 unidades por línea es decorativo. Veinte
líneas del mismo SKU con qty 50 son 1.000 unidades, y el chequeo de stock
también pasa: con 60 en bodega cada línea de 50 "cabe" por separado. Todo
límite agregable se mide sobre la forma canónica de la entrada, no sobre la
forma en que el llamador la escribió.

**4. Una cantidad inválida se rechaza, no se corrige.**
`Math.min(Math.max(Math.floor(Number(qty) || 1), 1), 50)` parece saneo de
entrada. *Sin esto:* `{qty: 0}` — que de un agente significa "saca esto" — se
convierte en una unidad cobrada a una persona, y los negativos, `NaN` y
fraccionarios se convierten en ventas inventadas. En una tool que cobra,
sanear es rechazar y explicar; reescribir la entrada a algo plausible es
fabricar intención.

**5. Los precios nunca vienen del llamador.** El schema de entrada no tiene
campo de precio; cada precio unitario y cada total se calcula server-side desde
el catálogo en esa misma llamada. *Sin esto:* tu política de descuentos es lo
que escriba quien llame.

**6. El veredicto viaja con su evidencia.** Cada línea vuelve con
`stock_available` y `stock_verified`, tanto si pasa como si no. *Sin esto:* la
tool que reporta stock exacto está detrás de token (es dato de trastienda), así
que el agente público no puede diagnosticar nada, reintenta a ciegas y le
inventa un motivo a la persona. Si tu frontera de privilegios le niega al agente
la tool de diagnóstico, la tool de escritura le debe el diagnóstico resuelto.

**7. Una línea mala bloquea el carro completo.** *Sin esto:* la persona recibe
un pedido con "los ítems que casualmente pasaron", que es un carro que nadie
pidió.

### Avisos de reposición

**8. Un efecto hacia afuera necesita una precondición de negocio verificada en
el servidor.** El correo sale solo si el producto está realmente sin stock:
cero verificado, o el catálogo diciéndolo de forma independiente cuando las
unidades no se pueden verificar. *Sin esto:* una tool pública que manda correo
a una dirección elegida por quien llama es un cañón de correo contra terceros.
Basta hacer loop de `tools/call` con `{email: victima@empresa.com, slug:
<cualquiera>}` para que salgan miles de mensajes impecables desde tu dominio,
gastando créditos y reputación de envío, contra alguien que nunca habló con la
tienda. (De yapa: también elimina el falso "¡volvió el stock!" sobre un producto
que nunca faltó.)

**9. Dedupe en el punto del efecto irreversible, y fail-closed.** El chequeo
ocurre antes del envío y, *si la consulta de duplicado falla, no se manda
nada*. *Sin esto:* la misma llamada repetida N veces manda N correos aunque el
INSERT final sea idempotente — la idempotencia del almacenamiento no protege
nada cuando la parte cara ocurre antes. Y un backend caído nunca puede
ascender a permiso para emitir.

**10. El cupo se keyea por destinatario, no por IP.** Tres correos de
confirmación por hora por dirección, evaluado aparte de cualquier límite por
llamador. *Sin esto:* el límite se esquiva rotando IPs (y en serverless ya
viene repartido entre instancias). La víctima del abuso no es una IP: es la
casilla de alguien. Keyea el límite al recurso que estás protegiendo.

**11. El correo automático nunca va a la dirección que eligió el llamador.** En
un checkout web le escribes al cliente y al admin. En una tool MCP el
`customer_email` lo escribió un *agente*. *Sin esto:* cablear "confirmación de
pedido" en la tool de escritura reabre exactamente el cañón que la otra tool
acaba de cerrar. Regla: una dirección que llega como input de una tool pública
puede recibir un mensaje de doble opt-in y nada más; cualquier otro correo
necesita prueba previa de intención — y pagar es esa prueba. Las notificaciones
al operador van a una dirección fija configurada por env.

**12. Doble opt-in con un token bien construido.** `v1.<payload>.<hmac>`, la
expiración **dentro** del payload firmado, comparación de tiempo constante y
fail-closed cuando no hay secreto de firma (la tool responde "opt-in no
disponible" en vez de suscribir directo). *Sin esto:* un token sin firma se
falsifica; una expiración guardada al lado del token en vez de adentro se
ignora; un `===` sobre la firma la filtra byte a byte; y una variable de
entorno faltante se vuelve una puerta abierta. Hacia afuera, "sin secreto",
"mal formado" y "firma inválida" comparten un mismo mensaje — solo "vencido" se
distingue, porque es accionable para la persona e inútil para un atacante.

**13. El GET renderiza, el POST escribe.** La página de confirmación no escribe
nada en GET; solo un POST con el token en el cuerpo del formulario persiste
algo. *Sin esto:* los gateways de correo corporativos (Safe Links, URL Defense,
antivirus de escritorio, prefetch del cliente) hacen GET a todas las URLs del
mensaje al entregarlo. Mandas una confirmación a la dirección de una víctima y
el escáner de seguridad de su propia empresa activa la suscripción: el opt-in
ajeno que el doble opt-in venía a impedir, entrando por la puerta de atrás. Los
escáneres siguen links; no envían formularios. La regla se generaliza a
cualquier acción disparada desde un link enviado por correo: confirmar,
cancelar, aprobar, dar de baja. La escritura además es idempotente, así que un
doble click es un éxito y no un ticket de soporte.

### Las dos tools

**14. Dry por defecto, con kill switch por tool.** `CHECKOUT_MODE` y
`STOCK_ALERT_MODE` valen `dry` salvo que se pongan explícitamente en `live`;
`off` saca la tool de `tools/list` por completo. Una llamada en dry corre todas
las verificaciones y responde exactamente qué habría hecho — incluido "esto
habría quedado BLOQUEADO y por qué". *Sin esto:* una tool de escritura que se
arma sola por el hecho de estar desplegada no tiene ensayo posible: su primera
invocación real es en producción, contra dinero. Solo el string exacto `live`
llega a live, así que un error de tipeo falla hacia no hacer nada.

**15. Una tool que no puede ser honesta no se anuncia.** `tools/list` está
gateado por capacidad: sin `CheckoutAdapter` *y* `InventoryAdapter`, no hay
`create_checkout`. *Sin esto:* despachas una tool de checkout sin fuente de
inventario, así que o todas las llamadas quedan bloqueadas (una tool que nunca
puede funcionar) o — peor — alguien la "arregla" confiando en el catálogo.

**16. La descripción del límite coincide con el límite.** El error nombra las
dos tools y dice que el cupo es compartido; las descripciones dicen lo mismo.
*Sin esto:* un agente que alterna las dos tools choca antes de lo anunciado,
concluye que el contador es por tool y reintenta — el rate limit generando el
tráfico que debía frenar. En un servidor MCP las descripciones y los mensajes
de error son la API que ve el agente, y una semántica mal descrita se paga en
reintentos.

### Sobre ese rate limiter (la versión honesta)

El limitador incluido es un `Map` en la memoria de un proceso. En serverless
eso significa **N instancias tibias = N cupos independientes**, un cold start
resetea el contador y un redeploy lo borra. Es fricción contra un loop de
agente, no un WAF ni un control de abuso, y así está rotulado en
`src/lib/ratelimit.ts` en vez de presentarse como un techo que el equipo en
realidad no tiene.

Por eso mismo los límites que importan están puestos en el **efecto** y no en
el contador de requests: fail-closed de disponibilidad, precondición de sin
stock, dedupe por (destinatario, producto), cupo por destinatario, doble opt-in
y kill switch. Esos son invariantes de negocio: se sostienen sin importar
cuántas instancias haya.

`rateLimited(key, max, windowMs)` es un puerto síncrono chico con una sola
forma de llamada, así que cambiar el almacenamiento en memoria por Redis/KV/
Durable Objects es mecánico. Hazlo antes de confiar en el contador para algo.

## Configuración de las tools de escritura

| Variable | Default | Qué hace |
| --- | --- | --- |
| `CHECKOUT_MODE` | `dry` | `off` \| `dry` \| `live` para `create_checkout` |
| `STOCK_ALERT_MODE` | `dry` | `off` \| `dry` \| `live` para `subscribe_stock_alert` |
| `STOCK_ALERT_SIGNING_SECRET` | *(sin valor)* | Llave HMAC de los links de opt-in. Si falta, no se puede emitir link y la tool rechaza: nunca suscribe sin confirmación. `openssl rand -hex 32` |
| `STOCK_ALERT_CONFIRM_URL` | `${NEXT_PUBLIC_SITE_URL}/api/stock-alert/confirm` | Dónde vive la página de confirmación |

Una tool se anuncia solo si el adaptador activo provee la capacidad, así que
nada de lo anterior resucita una tool que el adaptador no puede cumplir.

## Probar los guard rails en 60 segundos

El catálogo de juguete está armado para que aparezcan todos los estados.
`chromaflow-classic-set-12` tiene **4** unidades; `CF-G09` es un color del
catálogo **sin fila de inventario**; y `fieldbook-sketch-a5` está publicado
como `in_stock` con **cero** unidades — la forma exacta de una sobreventa.

```bash
npx storefront-mcp --http 8787 &

# Consolidación + fail-closed: dos líneas de 3 para un producto con 4 unidades.
# Por línea cada una "cabe". Juntas no.
curl -s http://127.0.0.1:8787/ -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_checkout","arguments":{
    "items":[{"slug":"chromaflow-classic-set-12","qty":3},{"slug":"chromaflow-classic-set-12","qty":3}]}}}'
# → bloqueado, qty_requested 6, merged_from_input_lines 2, stock_available 4

# Stock no verificable bloquea igual que cero:
#   "items":[{"sku":"CF-G09","qty":1}]   → stock_verified:false, blocked

# Las cantidades se rechazan, no se corrigen:
#   "items":[{"slug":"fieldbook-sketch-a5","qty":0}] → items_invalid_qty, qty_received 0
```

## Partir como endpoint web (2 minutos)

Para servir MCP desde tu propio dominio (la ruta de Next.js desplegable):

```bash
git clone <este repo> && cd storefront-mcp
npm install
npm run dev
```

Listo: el adaptador `memory` (el default) sirve el catálogo de juguete de
`examples/toy-catalog.json`, una tienda ficticia. Los mismos `curl` de la
sección en inglés funcionan tal cual.

## Escribir tu propio adaptador

La capa de protocolo nunca toca datos directamente: llama a las interfaces de
`src/lib/adapter.ts`. Solo `CatalogAdapter` es obligatoria; **cada una de las
otras es una capacidad, y las capacidades deciden qué tools existen**:

- **`CatalogAdapter`** (obligatoria) — búsqueda, producto, cartas de variantes,
  promociones, cotización. Pública por definición.
- **`OpsAdapter`** — habilita las 5 tools protegidas por token.
- **`InventoryAdapter`** — `getAvailability(refs)` devolviendo
  `{units, verified, reason}` por línea. Es la fuente de "cuántas unidades hay
  ahora", y tiene que ser la misma que usan tus tools de lectura.
- **`CheckoutAdapter`** — `createCheckout(draft)`. Se anuncia solo junto a un
  `InventoryAdapter`.
- **`NotifyAdapter`** — `isSubscribed` / `sendOptInEmail` /
  `confirmSubscription`.

Un adaptador que no implemente ninguna de las nuevas sigue funcionando igual
que antes: las tools de escritura simplemente no se anuncian. Es una
configuración soportada, no una degradada.

Copia `src/lib/adapters/memory.ts` como referencia, apúntalo a tu base de datos
o API, y regístralo en `src/lib/adapters/index.ts`. Reglas de honestidad del
contrato: si no pudiste verificar stock devuelve `units: null` / `stock: null`
(nunca inventes un número ni caigas a 0); sirve todas las respuestas de stock
desde una sola fuente, para que el camino de escritura no valide contra algo
distinto de lo que se le mostró al cliente; resta lo ya comprometido en otra
parte (reservas abiertas, otros canales); deja que `isSubscribed` lance en vez
de devolver `false` ante un error, para que quien llama falle cerrado; ponle
timeout a cada llamada externa; y `get_quote` jamás cobra — cotiza y devuelve
un `payment_link` para que pague la persona.

Se incluye un esqueleto para **WooCommerce** (Store API) con TODOs marcando lo
que falta completar, incluidos los tres contratos de escritura. Implementa solo
el lado de catálogo a propósito: con ese adaptador seleccionado, las tools de
escritura no aparecen.

## Discovery

Plantillas en `discovery/`: `/.well-known/mcp.json` (descriptor legible por
máquinas; reemplaza `{{DOMAIN}}` y sírvelo desde `public/.well-known/`) y un
snippet para `/llms.txt` con la política para agentes. Además, `GET /api/mcp`
devuelve un descriptor JSON.

## MCP bajo tu dominio WordPress

Si tu tienda corre en WordPress/WooCommerce pero el servidor MCP vive en otra
parte, `wordpress-proxy/mcp-proxy.php` es un mu-plugin que sirve
`https://tutienda.com/api/mcp` haciendo proxy al upstream: engancha en `init`
con prioridad 0, reenvía el header `Authorization` sin tocarlo, maneja el
preflight CORS, responde GET con un descriptor, limita los payloads a 256 KB
y ante una falla del upstream responde con un error JSON-RPC, nunca con una
página HTML. Se instala copiando el archivo a `wp-content/mu-plugins/` y
definiendo `STOREFRONT_MCP_UPSTREAM` en `wp-config.php`.

## ¿Por qué no usar el MCP de Shopify y ya?

Si estás en Shopify: Shopify le regala a cada tienda un endpoint MCP con un
`search_catalog` genérico, y funciona bien. Úsalo. Esta plantilla es para lo
que ese endpoint no cubre: tiendas fuera de Shopify (WooCommerce, stack
propio, headless), y sobre todo **tools que ninguna plataforma va a generar
por ti**. El ejemplo trabajado acá: `get_color_card`, la carta completa de
colores de una línea de marcadores con *stock vivo por tono*. Cualquier tienda
puede decir "vendemos estos marcadores"; solo la que conectó su propio
inventario puede decir "el tono W3 está disponible ahora y el R21 no". Esa
respuesta por variante cierra ventas, y ninguna tool genérica la tiene.

Y hay un segundo motivo: **tools de escritura que puedas defender**. Una
plataforma alojada decide por ti qué verifica su checkout. Acá los rechazos
están en tu repositorio, son revisables, y los que protegen a un tercero no son
configurables.

## Licencia

Apache-2.0 — ver [LICENSE](LICENSE) y [NOTICE](NOTICE).
