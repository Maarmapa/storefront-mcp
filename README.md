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
`memory` adapter) with the 6 public tools. Plug it into Claude Desktop or
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
Streamable HTTP). It ships with **11 tools**:

| Public (no auth) | Sensitive (Bearer token) |
| --- | --- |
| `search_products` | `get_stock_bulk` |
| `get_product` | `get_top_products` |
| `get_color_card` | `get_recent_orders` |
| `list_brands` | `get_order_status` |
| `get_promotions` | `get_sales_summary` |
| `get_quote` | |

It is extracted from a production server that runs at a real art-supply store
in Chile, with everything store-specific removed and replaced by a clean
adapter interface.

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

The protocol layer never touches data directly. It calls two interfaces
defined in `src/lib/adapter.ts`:

- **`CatalogAdapter`** — `searchProducts`, `getProduct`, `listBrands`,
  `getColorCard`, `getPromotions`, `getQuote`. Public by definition: assume
  every byte it returns is world-readable.
- **`OpsAdapter`** (optional) — `getStockBulk`, `getTopProducts`,
  `getRecentOrders`, `getOrderStatus`, `getSalesSummary`.

Steps:

1. Copy `src/lib/adapters/memory.ts` (the reference implementation) to a new
   file and point it at your database / API / ERP.
2. Register it in `src/lib/adapters/index.ts` and select it with the
   `CATALOG_ADAPTER` env var.
3. Keep the contract's honesty rules: return `stock: null` when you could not
   verify availability (never invent a number), set a per-call timeout so a
   hung backend degrades into a note instead of a hung agent, and keep
   `get_quote` charge-free — it quotes and returns a `payment_link`; the
   human pays.

A **WooCommerce skeleton** (`src/lib/adapters/woocommerce.ts`) is included,
built on the public Store API, with TODOs marking what you need to fill in
(variant charts, quoting strategy). It deliberately implements only the
catalog side.

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
  production server this template comes from sells art supplies: its killer
  tool is `get_color_card` — the full color chart of a marker line with
  *live stock per shade*. Any store can say "we sell these markers"; only the
  store that wired its own inventory can say "shade E00 is in stock right now,
  shade R29 is not". That per-variant answer closes sales, and it required
  domain knowledge no generic platform tool has.
- **You want the privilege-separated back office** — the same endpoint, with a
  token, answering "what were my top sellers this month?" to *you* while
  showing agents only the shop window.

## Repository layout

```
src/lib/protocol.ts           protocol core (JSON-RPC, auth boundary, dispatch) — shared by both transports
src/app/api/mcp/route.ts      Next.js transport (Streamable HTTP + Bearer)
src/cli/cli.ts                standalone transport: `npx storefront-mcp` (stdio via the official MCP SDK, or --http)
src/lib/tools.ts              tool definitions + SENSITIVE_TOOLS set
src/lib/adapter.ts            CatalogAdapter / OpsAdapter contracts + types
src/lib/adapters/memory.ts    reference adapter (toy catalog, fake back office)
src/lib/adapters/woocommerce.ts  Store API skeleton with TODOs
src/lib/adapters/index.ts     adapter registry (env CATALOG_ADAPTER)
examples/toy-catalog.json     the demo data
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
adaptador `memory`) y las 6 tools públicas. Para conectarlo a Claude Desktop
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
Streamable HTTP). Trae **11 tools**: 6 públicas de catálogo
(`search_products`, `get_product`, `get_color_card`, `list_brands`,
`get_promotions`, `get_quote`) y 5 sensibles protegidas por token
(`get_stock_bulk`, `get_top_products`, `get_recent_orders`,
`get_order_status`, `get_sales_summary`).

Está extraído de un servidor en producción de una tienda real de materiales
de arte en Chile, con todo lo específico de esa tienda removido y reemplazado
por una interfaz de adaptadores.

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
`src/lib/adapter.ts` (`CatalogAdapter` y, opcional, `OpsAdapter`). Copia
`src/lib/adapters/memory.ts` como referencia, apúntalo a tu base de datos o
API, y regístralo en `src/lib/adapters/index.ts`. Reglas de honestidad del
contrato: si no pudiste verificar stock, devuelve `stock: null` (nunca
inventes un número); ponle timeout a cada llamada externa; y `get_quote`
jamás cobra — cotiza y devuelve un `payment_link` para que pague el humano.

Se incluye un esqueleto para **WooCommerce** (Store API) con TODOs marcando
lo que falta completar.

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
por ti**. El ejemplo real detrás de esta plantilla: `get_color_card`, la
carta completa de colores de una línea de marcadores con *stock vivo por
tono*. Cualquier tienda puede decir "vendemos estos marcadores"; solo la que
conectó su propio inventario puede decir "el tono E00 está disponible ahora
y el R29 no". Esa respuesta por variante cierra ventas, y ninguna tool
genérica la tiene.

## Licencia

Apache-2.0 — ver [LICENSE](LICENSE) y [NOTICE](NOTICE).
