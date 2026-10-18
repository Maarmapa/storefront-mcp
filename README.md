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
`memory` adapter) with 8 public tools — 6 read tools plus the two write
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
route below), plus the opt-in confirmation page at
`/api/stock-alert/confirm`:

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
Streamable HTTP). It defines **13 tools**, and announces the subset your
adapter can actually answer:

| Public read (no auth) | Public write (guarded) | Sensitive (Bearer token) |
| --- | --- | --- |
| `search_products` | `create_checkout` | `get_stock_bulk` |
| `get_product` | `subscribe_stock_alert` | `get_top_products` |
| `get_variant_chart` | | `get_recent_orders` |
| `list_variant_charts` | | `get_order_status` |
| `get_promotions` | | `get_sales_summary` |
| `get_quote` | | |

Only `search_products` and `get_product` are always present. Everything else
is a capability: implement the adapter method and the tool appears, skip it
and the tool does not exist on your deployment — see
[guard rail 18](#both-tools).

The write tools are public on purpose — an agent buying on a human's behalf is
the point — so their protection is behavioral, not a token. They start in dry
mode. See [the guard rails](#the-second-design-what-a-write-tool-must-refuse).

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
case the sensitive tools are not announced at all, to anyone. Ops
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

**3. Lines are consolidated before any limit or stock check — by UNIT POOL,
not by spelling.** *Without the first half:* a per-line cap of 50 units is
decorative, because twenty lines of the same SKU at qty 50 is 1,000 units and
each one "fits". *Without the second half* — and this is the version that
survives a naive dedupe — `{slug: "notebook-a4", qty: 50}` and
`{sku: "NB-A4", qty: 50}` are two different keys for **one** product with
**one** pile of units. Each line is checked against the same 60 units, each
one passes, and the store sells 100. Only the inventory adapter can resolve
that identity, so `AvailabilityRow` carries a `pool` field and every aggregate
limit is measured per pool. When an adapter does not return one, the response
says so instead of pretending the two lines were proven distinct.

**4. An invalid quantity is rejected, never repaired.**
`Math.min(Math.max(Math.floor(Number(qty) || 1), 1), 50)` reads like input
sanitizing. *Without it:* `{qty: 0}` — which from an agent means "remove this"
— becomes one unit billed to a human, and negatives, `NaN` and fractions
become invented sales. In a tool that takes money, sanitizing means rejecting
and explaining; rewriting input into something plausible is fabricating intent.

**5. Prices are never accepted from the caller, and the quote is reconciled
against the request.** There is no price field in the input schema at all, and
before an order is created the server checks that the catalog priced *the
quantity that was asked for* and that `unit_price × qty == line_total`.
*Without the first half:* your discount policy is whatever the caller types.
*Without the second half:* the quantity travels from the cart and the money
travels from the quote, and nothing compares them — so a pricing source that
"helpfully" clamps 40 units to 10 produces an order for **40 units charged as
10**, with every other guard rail green. A quote is allowed to reject a line;
it is not allowed to answer a different question than the one asked.

**6. Units are HELD before the order exists — or live checkout refuses.** This
is the guard rail that a stateless check cannot be. Points 1–3 all describe the
past: they read a number. Ten concurrent calls each read "4 units left", each
pass every check, and each create an order — 40 sold against 4, no rule
broken. Only an atomic decrement at the inventory source can prevent that, so
`InventoryAdapter.reserve()` runs between the checks and the order, and a
deployment whose adapter cannot reserve does not create live orders unless the
operator sets `CHECKOUT_UNRESERVED=allow` and accepts the risk in writing.
*Without it:* every claim about "preventing overselling" holds for exactly one
request at a time, which is not what the phrase means. If `createCheckout`
then fails, the hold is released.

**7. The refusal ships with its evidence.** Every line comes back with
`stock_available` and `stock_verified`, success or failure. *Without it:* the
tool that reports exact stock is token-gated (it is back-office data), so the
public agent cannot diagnose anything, retries blindly, and tells the human a
made-up reason. If your privilege boundary denies the agent the diagnostic
tool, the write tool owes it the diagnosis.

**8. One bad line blocks the whole cart.** *Without it:* the human receives an
order for "the items that happened to pass", which is a cart nobody asked for.

**9. The number you read to the customer is the number they will pay.** Tax,
shipping and discounts belong to the adapter, so `CheckoutReceipt.total` may
differ from the line subtotal — and when it does, the response says which is
which (`amount_to_pay`, `charges`) instead of returning two contradictory
figures. *Without it:* a money contract that stops at `subtotal` silently
assumes tax-inclusive pricing and free delivery. An implementer in the EU or
the US either adds tax in their backend, so the total no longer matches the
subtotal the same response just reported, or does not, and undercharges.

### Back-in-stock alerts

**10. An outward effect needs a server-side business precondition.** The email
only goes out if the product is really unavailable — verified zero, or the
catalog independently saying out of stock when units cannot be verified.
*Without it:* a public tool that emails an address chosen by the caller is a
mail cannon aimed at third parties. Loop `tools/call` with
`{email: victim@company.com, slug: <anything>}` and thousands of perfectly
legitimate-looking messages leave your domain, burning credits and sender
reputation, hitting someone who never contacted the store. (Bonus: it also
kills the false "it's back!" alert about a product that never left.)

**11. Dedupe on the SEND, not only on the subscription — failing closed.**
Two different questions: "is this mailbox already subscribed?" and "did we
already mail this mailbox about this product and hear nothing back?". *Without
the second one:* the first protects nobody against the case that matters,
because an attacker never confirms — three identical calls send three emails
and every one of them is, technically, not a duplicate subscription. Both
lookups happen before the send, and if either FAILS nothing is sent: a backend
that is down must never be promoted into permission to emit.

**12. The quota is keyed by the recipient's MAILBOX, and it is only as durable
as your adapter.** Three confirmation emails per hour per mailbox, evaluated
independently of any caller limit. *Without the mailbox part:* keying on the
literal string is no quota at all, because one inbox has unlimited spellings —
`victim@`, `victim+1@`, `victim+2@`, `v.i.c.t.i.m@`, `VICTIM@` all land in the
same Gmail account and each one gets its own fresh allowance of three.
*Without the durability part:* the in-memory counter resets on cold start,
splits across instances and dies on redeploy, so the ceiling exists on paper
only. Implement `NotifyAdapter.countOptInEmails` and the limit is a real
ceiling counted in your storage; skip it and the tool's own response says
`quota_enforcement: "best_effort"` rather than promising a number it cannot
hold.

**13. The automated email never goes to the address the caller chose.** In a
web checkout you mail the customer and the admin. In an MCP tool the
`customer_email` was typed by an *agent*. *Without it:* wiring "order
confirmation" into the write tool re-opens the exact cannon the alert tool just
closed. Rule: an address arriving as tool input may receive one double-opt-in
message and nothing else; any other mail needs prior proof of intent — which is
what paying is. (Nothing in this template mails an operator. If you want order
notifications, send them from your own adapter to an address in your own env —
never to `draft.customer_email`.)

**14. Double opt-in with a properly built token, including a key long enough
to be one.** `v1.<payload>.<hmac>`, the expiry **inside** the signed payload,
timing-safe comparison, a 32-character minimum on the signing secret, and
fail-closed when it is missing or too short (the tool answers "opt-in
unavailable" instead of subscribing directly). *Without it:* unsigned tokens
are forged; an expiry stored beside the token instead of inside it gets
ignored; `===` on a signature leaks it byte by byte; a missing env var becomes
an open door; and `STOCK_ALERT_SIGNING_SECRET=x` passes a "non-empty" check
while letting anyone compute a valid token for any address and POST it
themselves — double opt-in with nobody opting in. Outwardly, "no secret",
"malformed" and "bad signature" share one message; only "expired" is
distinguished, because it is actionable for the human and useless to an
attacker.

**15. No confirmation URL, no email.** *Without it:* the one fail-*open* in a
flow where everything else fails closed. With the signing secret set and no
site URL configured, the tool used to send anyway, with a confirmation link
pointing at `https://example.com` — a domain the operator does not own —
carrying a signed token with the recipient's own address inside it, in a query
string, to a third party. A dead link is bad. A dead link on somebody else's
domain with your customer's address in it is worse.

**16. GET renders, POST writes — and the page says what is being confirmed.**
The confirmation page performs zero writes on GET; only a POST with the token
in a form body persists anything. *Without it:* corporate mail gateways (Safe
Links, URL Defense, desktop AV, client prefetch) fetch every link in every
message at delivery. Send a confirmation to a victim's address and their own
employer's security scanner activates the subscription — the third-party
opt-in you built double opt-in to prevent, re-entered through the back door.
Scanners follow links; they do not submit forms. This generalizes to anything
triggered from an emailed link: confirm, cancel, approve, unsubscribe. The
page also names the product and the specific variant, because subscribing to a
product line and subscribing to one shade of it are different subscriptions
and a consent screen that omits the difference is not consent. The write is
idempotent, so a double-click is a success rather than a support ticket.

### Both tools

**17. Dry by default, with a per-tool kill switch.** `CHECKOUT_MODE` and
`STOCK_ALERT_MODE` are `dry` unless explicitly set to `live`; `off` removes the
tool from `tools/list` entirely. A dry call runs every check and then answers
with exactly what it would have done — including "this would have been BLOCKED,
here is why". *Without it:* a write tool that arms itself by being deployed has
no rehearsal — its first real invocation is in production, against money. Only
the exact string `live` reaches live, so a typo fails towards doing nothing.

**18. A tool that cannot be honest is not announced — and that covers the read
tools.** `tools/list` is capability-gated end to end: no `getQuote`, no
`get_quote`; no `OpsAdapter`, no back-office tools even for an authorized
caller; no `CheckoutAdapter` *and* `InventoryAdapter` *and* pricing, no
`create_checkout`. Anything not announced answers `-32601`, the same way, for
every reason. *Without it:* you ship stubs. The WooCommerce adapter used to
implement three methods it could not answer — `listBrands` returning `[]`,
`getColorCard` returning `null`, `getQuote` rejecting every line — purely to
satisfy the interface, and the server announced all three to every anonymous
agent: a chart list that is always empty, a lookup that always says "not
found", a quote that always fails. A dead end an agent walks into twice is
worse than a tool that is not there.

**19. The limit description matches the limit.** The error names both tools and
says the quota is shared; the tool descriptions say the same, *including the
case where the deployment cannot identify callers*. *Without it:* an agent
alternating the two tools hits a wall earlier than announced, concludes the
counter is per-tool, and retries — the rate limit generating the traffic it
exists to stop. For an MCP server, tool descriptions and error strings are the
agent-facing API, and a mis-described limit is paid in retries.

**20. The rate-limit key cannot be chosen by the caller.** See below.

### About that rate limiter (the honest version)

Two things are usually wrong with "rate limit by IP", and the second one is
rarely mentioned.

**The key.** Everyone knows not to trust the *first* `x-forwarded-for` entry.
The part that gets missed: a forwarding header is written by a **proxy**, and
with no proxy in front of you — `node server.js` on a VPS, a bare `next
start`, nginx without `proxy_set_header`, a container with a public port —
the whole header, last hop included, is a string the caller typed. Rotating
`X-Forwarded-For: 203.0.113.1, .2, .3…` then mints a fresh bucket per request
and the limiter does nothing. So this server trusts **no** forwarding header
unless you name the one your edge writes:

```bash
TRUSTED_PROXY_HEADER=x-vercel-forwarded-for   # Vercel
TRUSTED_PROXY_HEADER=cf-connecting-ip         # Cloudflare
TRUSTED_PROXY_HEADER=x-storefront-client-ip   # the bundled WordPress proxy
```

Naming a header asserts two things: your edge *overwrites* it, and nothing
else can reach the origin. If the origin is publicly reachable, that header is
forgeable by whoever finds it — lock the origin down first (deployment
protection, a firewall, mTLS). With nothing declared, the `--http` server uses
the TCP peer address, which nobody can forge; a serverless Fetch handler has
no socket to ask, so callers are **unattributed** — and an unattributed
deployment gets a process-wide ceiling of 60 writes/minute rather than a
per-caller promise it cannot keep. (Not a shared 5/min: collapsing every
caller into one small bucket turns the rate limiter into a denial of service
against your own customers, which is a worse bug than the one it fixes.)

**The store.** The bundled counter is a `Map` in the memory of one process. On
serverless that means **N warm instances = N independent quotas**, a cold start
resets it, and a redeploy erases it. It is friction against an agent loop, not
a WAF and not an abuse control, and it is labelled that way in
`src/lib/ratelimit.ts` rather than presented as a ceiling the team does not
actually have. `rateLimited(key, max, windowMs)` is a small synchronous port
with a single call-site shape, so swapping in Redis/KV/Durable Objects is
mechanical. Do that before you rely on the counter for anything.

Which is exactly why the limits that matter are attached to the **effect**:
fail-closed availability, the atomic reservation, the out-of-stock
precondition, dedupe at the point of the send, double opt-in, and the kill
switch. Those hold no matter how many instances are running, because they are
enforced by your data, not by a counter. The per-recipient email quota sits in
between: durable when your `NotifyAdapter` implements `countOptInEmails`,
best-effort otherwise — and the tool response says which one you have rather
than leaving you to guess.

## Configuration for the write tools

| Env var | Default | What it does |
| --- | --- | --- |
| `CHECKOUT_MODE` | `dry` | `off` \| `dry` \| `live` for `create_checkout` |
| `STOCK_ALERT_MODE` | `dry` | `off` \| `dry` \| `live` for `subscribe_stock_alert` |
| `CHECKOUT_UNRESERVED` | `refuse` | In live mode, what to do when the inventory adapter cannot **hold** units: `refuse` (no order) or `allow` (accepts that concurrent calls can oversell; every receipt says so) |
| `STOCK_ALERT_SIGNING_SECRET` | *(unset)* | HMAC key for opt-in links, **min 32 chars**. Missing or too short ⇒ no link can be issued and the tool refuses. `openssl rand -hex 32` |
| `STOCK_ALERT_CONFIRM_URL` | `${NEXT_PUBLIC_SITE_URL}/api/stock-alert/confirm` | Where the confirmation page lives. With neither set, live mode sends **nothing** |
| `STOCK_ALERT_PAGE_LOCALE` | `en` | Language of that page (`en` \| `es`) — the one screen a customer sees |
| `TRUSTED_PROXY_HEADER` | *(unset)* | Name of the header your edge writes with the client IP. Unset ⇒ forwarding headers are ignored |

A tool is announced only when the active adapter provides the capability, so
none of the above resurrects a tool the adapter cannot honor.

## Trying the guard rails in 60 seconds

The bundled toy catalog is arranged so every state shows up.
`chromaflow-classic-set-12` has **4** units; `CF-G09` is a catalogued variant
with **no inventory row**; `fieldbook-sketch-a5` is published as `in_stock`
with **zero** units (the oversell shape itself); and `fieldbook-sketch-a4` is
the ordinary case — one product with **60** units addressable both by its slug
and by its SKU `FB-A4`.

```bash
npx storefront-mcp --http 8787 &

# Consolidation + fail-closed: two lines of 3 for a product with 4 units.
# Per line each one "fits". Together they do not.
curl -s http://127.0.0.1:8787/ -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_checkout","arguments":{
    "items":[{"slug":"chromaflow-classic-set-12","qty":3},{"slug":"chromaflow-classic-set-12","qty":3}]}}}'
# → blocked, qty_requested 6, merged_from_input_lines 2, stock_available 4

# Same product, two spellings, one pile of units: 50 by slug + 50 by SKU
# against 60. Both lines "fit" on their own; the pool is what gets checked.
curl -s http://127.0.0.1:8787/ -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_checkout","arguments":{
    "items":[{"slug":"fieldbook-sketch-a4","qty":50},{"sku":"FB-A4","qty":50}]}}}'
# → blocked: "only 60 unit(s) available and 100 requested across the lines that
#   share this stock", plus shares_stock_with on every line

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

Deploying it? Set `TRUSTED_PROXY_HEADER` to the header your platform writes
(`x-vercel-forwarded-for` on Vercel, `cf-connecting-ip` behind Cloudflare), or
the write quota becomes a single ceiling for the whole instance — see
[the rate limiter](#about-that-rate-limiter-the-honest-version).

## Writing your own adapter

The protocol layer never touches data directly. It calls the interfaces
defined in `src/lib/adapter.ts`. **Two methods are required. Everything else
is a capability, and capabilities decide which tools exist**:

- **`CatalogAdapter`** (required) — `searchProducts` and `getProduct`, and
  that is the whole obligation. Public by definition: assume every byte it
  returns is world-readable. Optional on the same interface:
  - `getPromotions` → `get_promotions`
  - `getQuote` → `get_quote` (and it is a precondition for `create_checkout`)
  - `listVariantCharts` + `getVariantChart` → the two chart tools, announced
    together or not at all. A "variant chart" is one product line whose stock
    lives per variant — color, size, grit, roast, capacity. If your catalog
    has no such axis, do not implement them; there is nothing to stub.
- **`OpsAdapter`** — `getStockBulk`, `getTopProducts`, `getRecentOrders`,
  `getOrderStatus`, `getSalesSummary`. Enables the token-gated tools.
- **`InventoryAdapter`** — `getAvailability(refs)` returning
  `{units, verified, reason, pool}` per line. This is the "how many units right
  now" source, and it must be the same one your read tools use. Optional but
  load-bearing: `reserve(req)` / `release(id)`, without which live checkout
  refuses (guard rail 6).
- **`CheckoutAdapter`** — `createCheckout(draft)`. Announced only alongside an
  `InventoryAdapter` and a `getQuote`.
- **`NotifyAdapter`** — `isSubscribed` / `sendOptInEmail` /
  `confirmSubscription`, plus the optional `countOptInEmails` that turns the
  per-recipient quota into a real ceiling.

An adapter that implements only the two required methods keeps working exactly
as expected: everything else is simply never announced. That is a supported
configuration, not a degraded one.

Steps:

1. Copy `src/lib/adapters/memory.ts` (the reference implementation) to a new
   file and point it at your database / API / ERP.
2. Register it in `src/lib/adapters/index.ts` and select it with the
   `CATALOG_ADAPTER` env var.
3. Keep the contract's honesty rules:
   - return `units: null` / `stock: null` when you could not verify
     availability — **never invent a number, and never fall back to 0**;
   - return a `pool` on every availability row: the identity of the pile of
     units that line draws from, with a product's slug and its SKU resolving
     to the **same** pool. Without it, one product ordered two ways is checked
     twice against the same stock;
   - implement `reserve` as ONE atomic operation (`UPDATE … WHERE (on_hand −
     reserved) >= :qty`), all-or-nothing, and `release` for the rollback;
   - serve every stock answer from one source, so the write path cannot
     validate against something different from what the customer was shown;
   - subtract what is already committed elsewhere (open holds, other channels)
     — "on the shelf" is not "sellable to this customer";
   - let `isSubscribed` throw on failure instead of returning `false`; the
     caller fails closed and sends nothing;
   - set a per-call timeout so a hung backend degrades into a note instead of
     a hung agent;
   - keep `get_quote` charge-free, make `getQuote` echo the `slug`/`sku` it was
     given on each priced line, and make it price **the quantity it was
     asked for or reject the line** — the checkout path compares the two and
     refuses the cart when they disagree.

A **WooCommerce skeleton** (`src/lib/adapters/woocommerce.ts`) is included,
built on the public Store API. It implements exactly three tools' worth of
catalog (`search_products`, `get_product`, `get_promotions`) and stubs
nothing; the TODO blocks describe what each remaining contract needs from a
WooCommerce install, including the two decisions — per-variant stock semantics
and how to hold units — that nobody can make for you.

## Discovery: getting found

Agents can only call what they can find. Two artifacts, templates in
`discovery/`:

- **`/.well-known/mcp.json`** — machine-readable descriptor
  (`discovery/well-known-mcp.json`; replace `{{DOMAIN}}`, serve from
  `public/.well-known/mcp.json`). List only public tools in it, and only the
  ones your deployment actually announces.
- **`/llms.txt`** — human/LLM-readable site guide
  (`discovery/llms-txt-snippet.md`); includes an agent policy section: re-check
  stock before closing a sale, quotes never charge, `stock: null` means
  unknown, quote `amount_to_pay` rather than `subtotal`.

Additionally, `GET /api/mcp` returns a JSON descriptor so anyone poking the
endpoint understands what it is.

For the official [MCP Registry](https://registry.modelcontextprotocol.io),
`server.json` at the repo root is the manifest: it points at the
`storefront-mcp` npm package with stdio transport, so registry clients can
run it via `npx`. **Publish to npm first** — the registry validates the
`mcpName` inside the published tarball, so registering a version npm does not
have yet creates an entry pointing at nothing. The workflow in
`.github/workflows/publish-mcp-registry.yml` checks that before it runs.

## Skills over MCP

The server also ships the instructions for using it, as a skill served over the
protocol ([SEP-2640](https://modelcontextprotocol.io/seps/2640-skills-extension),
extension `io.modelcontextprotocol/skills`). A host that implements the extension
discovers it with `skills/list`, reads `skill://storefront-mcp/SKILL.md` with
`resources/read` and verifies the sha256 digest the entry carries. A host that
does not implement it sees the same file as an ordinary resource; nothing breaks.

The extension is specified against protocol revision 2026-07-28, so the server
now answers `server/discover` and negotiates that revision (stateless, every
request stamped with its version in `_meta`, `resultType` on every result,
`ttlMs`/`cacheScope` on lists). Older clients keep using `initialize` with
2025-06-18 or 2025-11-25 and notice nothing (`initialize` never answers
2026-07-28: that revision has no handshake). The `server/discover` answer also
carries `instructions` pointing at the skill, so a host without the extension
(Claude Code today) still reads it as a resource when the model decides to.

Speaking 2026-07-28 also means refusing what that revision tells servers to
refuse: a `_meta` protocol version this server does not serve (-32022, with the
supported list), a modern request without `clientCapabilities` (-32602), and on
HTTP the mirrored headers `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`
when they are missing or contradict the body (-32020, HTTP 400). An unknown
method on a modern request is a 404. Requests that stamp no `_meta` (older
revisions) are served as before.

The SKILL.md is generated per caller from the deployment's real configuration:
it names exactly the tools `tools/list` announces to that caller, states the
current mode of each write tool (dry or live) and where an agent's permission
ends (no checkout without an explicit request to buy, no alert without an
address given for that purpose) and, for an operator session, which back-office
tools it carries; an anonymous caller's skill never mentions them. Its
digest therefore changes when the configuration does, which is the point: a host
that pinned the digest re-reads it then.

Try it with a client that speaks the extension (mcpc 0.7 or newer connects from
a config file, like any MCP host):

```bash
cat > mcp.json <<'EOF'
{ "mcpServers": { "shop": { "command": "npx", "args": ["-y", "storefront-mcp"] } } }
EOF
npx -y @apify/mcpc connect mcp.json:shop @shop
npx -y @apify/mcpc @shop skills-list
npx -y @apify/mcpc @shop skills-get storefront-mcp
```

`npm test` builds the CLI and exercises both transports end to end: capability
declared, `skills/list` and `skills/get` agree, the frontmatter parses as YAML
into the same fields as the entry (the verification hosts must do), digest and
size match the bytes served, the skill names exactly the tools `tools/list`
announces (in both directions), and an anonymous caller's skill never mentions
the back office. It also covers the 2026-07-28 refusals above and the bodies
that are not JSON-RPC requests (`null`, numbers, empty batches), which are
answered with -32600 instead of executed.

## Serving MCP from your WordPress domain

If your storefront runs WordPress/WooCommerce but the MCP server deploys
elsewhere (e.g. Vercel), `wordpress-proxy/mcp-proxy.php` is a **mu-plugin**
that serves `https://yourshop.com/api/mcp` by proxying to the upstream:

- hooks `init` at priority 0 (answers before WordPress routing),
- forwards POST bodies and the `Authorization` header untouched (the upstream
  enforces the privilege split),
- forwards the real client address in `X-Storefront-Client-IP`, overwriting
  anything the caller sent,
- handles CORS preflight, answers GET with a readable descriptor,
- caps payloads at 256 KB,
- on upstream failure returns a JSON-RPC error object — never an HTML error
  page, because the client is a program.

Install: drop the file in `wp-content/mu-plugins/` and define
`STOREFRONT_MCP_UPSTREAM` in `wp-config.php`. Then set
`TRUSTED_PROXY_HEADER=x-storefront-client-ip` **on the upstream** — without
it, every request arrives wearing the WordPress server's address and the
write quota becomes 5 calls per minute for the entire store, so one looping
agent locks every customer out of checkout. Only trust that header if the
upstream cannot be reached except through the proxy; if it is publicly
reachable, anyone who finds it can write the header themselves.

## Why not just Shopify's MCP?

If you are on Shopify: Shopify already gives every store a hosted MCP endpoint
with a generic `search_catalog`-style tool, and it is good. Use it. This
template is for the cases it does not cover:

- **You are not on Shopify** — WooCommerce, custom stack, headless, an ERP
  from 2009 that somehow still works.
- **Your differentiator is a tool the platform will never generate.** The
  worked example here is `get_variant_chart`: the full variant chart of a
  product line with *live stock per variant*. Any store can say "we sell these
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
src/lib/protocol.ts           protocol core (JSON-RPC, auth boundary, capability gating, dispatch)
src/app/api/mcp/route.ts      Next.js transport (Streamable HTTP + Bearer)
src/cli/cli.ts                standalone transport: `npx storefront-mcp` (stdio, or --http + confirm page)
src/lib/tools.ts              tool definitions, built from what the adapter can answer
src/lib/adapter.ts            the five adapter contracts + types
src/lib/commerce.ts           create_checkout / subscribe_stock_alert — the guard rails
src/lib/availability.ts       tri-state availability, pool identity, blocksWrite()
src/lib/cart.ts               consolidate first, then measure limits; reject bad quantities
src/lib/money.ts              currency-aware rounding (not everything has two decimals)
src/lib/email.ts              address vs mailbox: canonical keys for quota and dedupe
src/lib/optin.ts              signed double opt-in tokens (exp inside payload, fail-closed)
src/lib/optin-page.ts         the confirmation page: GET renders, POST writes (framework-free)
src/lib/ratelimit.ts          rateLimited(key,max,window) + what an in-memory limiter is NOT
src/lib/client-ip.ts          caller identity: no forwarding header is trusted unless declared
src/lib/write-mode.ts         off | dry | live per tool, + the unreserved-checkout policy
src/lib/errors.ts             ToolCallError (quota / capability refusals)
src/app/api/stock-alert/confirm/route.ts  Next.js transport for the confirmation page
src/lib/adapters/memory.ts    reference adapter (all five contracts, one stock source, real holds)
src/lib/adapters/woocommerce.ts  Store API skeleton — implements only what it can answer
src/lib/adapters/index.ts     adapter registry (env CATALOG_ADAPTER)
examples/toy-catalog.json     the demo data, incl. a separate `inventory` section
server.json                   MCP Registry manifest (registry.modelcontextprotocol.io)
tsconfig.build.json           compiles lib + cli to dist/ for the npm bin
discovery/                    /.well-known/mcp.json + llms.txt templates
wordpress-proxy/mcp-proxy.php mu-plugin to serve MCP under your WP domain
```

## Breaking changes in 2.0

- `get_color_card` → **`get_variant_chart`** (argument `brand` → `chart`) and
  `list_brands` → **`list_variant_charts`**. The old names described one
  store's domain, not the contract; the payload renames `colors` → `variants`
  and `hex` → optional `swatch_hex`.
- `CatalogAdapter` now requires only `searchProducts` and `getProduct`. The
  other four methods are optional, and each one gates its tool.
- `AvailabilityRow.pool` is new. Adapters that do not return it still work,
  but cannot catch slug/SKU collisions (guard rail 3).
- Live `create_checkout` requires `InventoryAdapter.reserve` unless
  `CHECKOUT_UNRESERVED=allow` (guard rail 6).
- Forwarding headers are ignored unless `TRUSTED_PROXY_HEADER` names one
  (guard rail 20).
- `STOCK_ALERT_SIGNING_SECRET` must be at least 32 characters, and live alerts
  now require a configured confirmation URL.

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
adaptador `memory`) y 8 tools públicas: 6 de lectura más las dos de
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
Next.js) y además la página de confirmación de opt-in en
`/api/stock-alert/confirm`. El adaptador se elige con `CATALOG_ADAPTER`
(`memory` por defecto, `woocommerce` para el esqueleto de la Store API).

## Qué es

Un servidor [MCP](https://modelcontextprotocol.io) empaquetado como ruta de
Next.js (App Router) que expone una tienda online a agentes de IA (Claude,
GPTs personalizados, frameworks de agentes — cualquier cliente MCP sobre
Streamable HTTP). Define **13 tools** y anuncia el subconjunto que tu
adaptador puede responder de verdad:

- 6 públicas de lectura: `search_products`, `get_product`,
  `get_variant_chart`, `list_variant_charts`, `get_promotions`, `get_quote`.
- 2 públicas de escritura, con guard rails: `create_checkout` y
  `subscribe_stock_alert`.
- 5 sensibles protegidas por token: `get_stock_bulk`, `get_top_products`,
  `get_recent_orders`, `get_order_status`, `get_sales_summary`.

Solo `search_products` y `get_product` están siempre. Todo lo demás es una
capacidad: si implementas el método del adaptador la tool aparece; si no, esa
tool no existe en tu despliegue (ver guard rail 18).

Las tools de escritura son públicas a propósito — que un agente compre por
encargo de una persona es justamente el punto — así que su protección está en
el comportamiento, no en un token. Arrancan en modo dry. Ver
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
es un contrato aparte que puedes simplemente no implementar; en ese caso las
tools sensibles no se anuncian a nadie. Las implementaciones de ops deben
anonimizar la información de clientes: los ítems llevan nombre/cantidad/precio,
nunca correos, direcciones ni teléfonos, incluso detrás de la autenticación.

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

**3. Las líneas se consolidan antes de cualquier tope o chequeo de stock, y se
consolidan por POZO DE UNIDADES, no por cómo se escribieron.** *Sin la primera
mitad:* un tope de 50 unidades por línea es decorativo, porque veinte líneas
del mismo SKU con qty 50 son 1.000 unidades y cada una "cabe". *Sin la segunda
mitad* — y esta es la versión que sobrevive a un dedupe ingenuo —
`{slug: "cuaderno-a4", qty: 50}` y `{sku: "CU-A4", qty: 50}` son dos claves
distintas para **un** producto con **una** pila de unidades. Cada línea se
compara contra las mismas 60 unidades, las dos pasan, y la tienda vende 100.
Solo el adaptador de inventario puede resolver esa identidad, así que
`AvailabilityRow` lleva un campo `pool` y todo límite agregable se mide por
pozo. Si el adaptador no lo devuelve, la respuesta lo dice en vez de fingir
que quedó demostrado que son dos productos distintos.

**4. Una cantidad inválida se rechaza, no se corrige.**
`Math.min(Math.max(Math.floor(Number(qty) || 1), 1), 50)` parece saneo de
entrada. *Sin esto:* `{qty: 0}` — que de un agente significa "saca esto" — se
convierte en una unidad cobrada a una persona, y los negativos, `NaN` y
fraccionarios se convierten en ventas inventadas. En una tool que cobra,
sanear es rechazar y explicar; reescribir la entrada a algo plausible es
fabricar intención.

**5. Los precios nunca vienen del llamador, y la cotización se reconcilia
contra lo pedido.** El schema de entrada no tiene campo de precio, y antes de
crear un pedido el servidor verifica que el catálogo cotizó *la cantidad que se
pidió* y que `unit_price × qty == line_total`. *Sin la primera mitad:* tu
política de descuentos es lo que escriba quien llame. *Sin la segunda:* la
cantidad viaja desde el carro y el dinero viaja desde la cotización, y nada las
compara — así que un cotizador que "ayuda" recortando 40 unidades a 10 produce
un pedido de **40 unidades cobrado como 10**, con todos los demás guard rails
en verde. Una cotización puede rechazar una línea; lo que no puede es responder
una pregunta distinta de la que se le hizo.

**6. Las unidades se RESERVAN antes de que exista el pedido, o el checkout en
vivo rechaza.** Este es el guard rail que una verificación sin estado no puede
ser. Los puntos 1 a 3 describen el pasado: leen un número. Diez llamadas
concurrentes leen "quedan 4", las diez pasan todas las verificaciones y las
diez crean un pedido: 40 vendidas contra 4, sin romper ninguna regla. Solo un
decremento atómico en la fuente de inventario lo impide, así que
`InventoryAdapter.reserve()` corre entre las verificaciones y el pedido, y un
despliegue cuyo adaptador no sabe reservar no crea pedidos en vivo salvo que
el operador ponga `CHECKOUT_UNRESERVED=allow` y acepte el riesgo por escrito.
*Sin esto:* toda afirmación sobre "evitar la sobreventa" vale para exactamente
un request a la vez, que no es lo que significa la frase. Si `createCheckout`
falla después, la reserva se libera.

**7. El veredicto viaja con su evidencia.** Cada línea vuelve con
`stock_available` y `stock_verified`, tanto si pasa como si no. *Sin esto:* la
tool que reporta stock exacto está detrás de token (es dato de trastienda), así
que el agente público no puede diagnosticar nada, reintenta a ciegas y le
inventa un motivo a la persona. Si tu frontera de privilegios le niega al agente
la tool de diagnóstico, la tool de escritura le debe el diagnóstico resuelto.

**8. Una línea mala bloquea el carro completo.** *Sin esto:* la persona recibe
un pedido con "los ítems que casualmente pasaron", que es un carro que nadie
pidió.

**9. El número que le lees al cliente es el que va a pagar.** Impuestos, envío
y descuentos son del adaptador, así que `CheckoutReceipt.total` puede diferir
del subtotal de líneas — y cuando difiere, la respuesta dice cuál es cuál
(`amount_to_pay`, `charges`) en vez de devolver dos cifras contradictorias.
*Sin esto:* un contrato de dinero que termina en `subtotal` asume en silencio
precios con impuesto incluido y envío gratis. Quien implemente esto en la UE o
en EE.UU. o suma el impuesto en su backend, y entonces el total deja de
coincidir con el subtotal que esa misma respuesta acaba de reportar, o no lo
suma y cobra de menos.

### Avisos de reposición

**10. Un efecto hacia afuera necesita una precondición de negocio verificada en
el servidor.** El correo sale solo si el producto está realmente sin stock:
cero verificado, o el catálogo diciéndolo de forma independiente cuando las
unidades no se pueden verificar. *Sin esto:* una tool pública que manda correo
a una dirección elegida por quien llama es un cañón de correo contra terceros.
Basta hacer loop de `tools/call` con `{email: victima@empresa.com, slug:
<cualquiera>}` para que salgan miles de mensajes impecables desde tu dominio,
gastando créditos y reputación de envío, contra alguien que nunca habló con la
tienda. (De yapa: también elimina el falso "¡volvió el stock!" sobre un producto
que nunca faltó.)

**11. Dedupe sobre el ENVÍO, no solo sobre la suscripción, y fail-closed.**
Son dos preguntas distintas: "¿esta casilla ya está suscrita?" y "¿ya le
mandamos correo a esta casilla por este producto y nadie hizo nada?". *Sin la
segunda:* la primera no protege del caso que importa, porque un atacante nunca
confirma — tres llamadas idénticas mandan tres correos y ninguna es,
técnicamente, una suscripción duplicada. Las dos consultas ocurren antes del
envío y, si cualquiera falla, no se manda nada: un backend caído nunca puede
ascender a permiso para emitir.

**12. El cupo se keyea por la CASILLA del destinatario, y dura lo que dure tu
adaptador.** Tres correos de confirmación por hora por casilla, evaluado aparte
de cualquier límite por llamador. *Sin la parte de la casilla:* keyear el
string literal no es ningún cupo, porque una casilla tiene infinitas
escrituras: `victima@`, `victima+1@`, `victima+2@`, `v.i.c.t.i.m.a@` y
`VICTIMA@` llegan todas a la misma cuenta de Gmail y cada una estrena su propio
cupo de tres. *Sin la parte de la durabilidad:* el contador en memoria se
reinicia en un cold start, se reparte entre instancias y se borra en un
redeploy, así que el techo existe solo en el papel. Implementa
`NotifyAdapter.countOptInEmails` y el límite pasa a contarse en tu
almacenamiento; si no lo haces, la respuesta de la tool dice
`quota_enforcement: "best_effort"` en vez de prometer un número que no puede
sostener.

**13. El correo automático nunca va a la dirección que eligió el llamador.** En
un checkout web le escribes al cliente y al admin. En una tool MCP el
`customer_email` lo escribió un *agente*. *Sin esto:* cablear "confirmación de
pedido" en la tool de escritura reabre exactamente el cañón que la otra tool
acaba de cerrar. Regla: una dirección que llega como input de una tool pública
puede recibir un mensaje de doble opt-in y nada más; cualquier otro correo
necesita prueba previa de intención — y pagar es esa prueba. (Esta plantilla no
le manda correo a ningún operador. Si quieres avisos de pedido, mándalos desde
tu propio adaptador a una dirección de tu propio entorno, nunca a
`draft.customer_email`.)

**14. Doble opt-in con un token bien construido, incluida una llave que sea
llave.** `v1.<payload>.<hmac>`, la expiración **dentro** del payload firmado,
comparación de tiempo constante, un mínimo de 32 caracteres para el secreto de
firma, y fail-closed cuando falta o es más corto (la tool responde "opt-in no
disponible" en vez de suscribir directo). *Sin esto:* un token sin firma se
falsifica; una expiración guardada al lado del token en vez de adentro se
ignora; un `===` sobre la firma la filtra byte a byte; una variable de entorno
faltante se vuelve una puerta abierta; y `STOCK_ALERT_SIGNING_SECRET=x` pasa un
chequeo de "no vacío" mientras cualquiera calcula un token válido para
cualquier dirección y lo envía por POST — doble opt-in sin que nadie opte.
Hacia afuera, "sin secreto", "mal formado" y "firma inválida" comparten un
mismo mensaje; solo "vencido" se distingue, porque es accionable para la
persona e inútil para un atacante.

**15. Sin URL de confirmación no hay correo.** *Sin esto:* el único fail-*open*
en un flujo donde todo lo demás falla cerrado. Con el secreto de firma puesto y
sin URL de sitio configurada, la tool mandaba igual, con un link de
confirmación a `https://example.com` — un dominio que el operador no controla —
llevando un token firmado con la dirección del destinatario adentro, en la query
string, hacia un tercero. Un link muerto es malo. Un link muerto en el dominio
de otro con la dirección de tu cliente adentro es peor.

**16. El GET renderiza, el POST escribe — y la página dice qué se está
confirmando.** La página de confirmación no escribe nada en GET; solo un POST
con el token en el cuerpo del formulario persiste algo. *Sin esto:* los
gateways de correo corporativos (Safe Links, URL Defense, antivirus de
escritorio, prefetch del cliente) hacen GET a todas las URLs del mensaje al
entregarlo. Mandas una confirmación a la dirección de una víctima y el escáner
de seguridad de su propia empresa activa la suscripción: el opt-in ajeno que el
doble opt-in venía a impedir, entrando por la puerta de atrás. Los escáneres
siguen links; no envían formularios. La regla se generaliza a cualquier acción
disparada desde un link enviado por correo: confirmar, cancelar, aprobar, dar
de baja. La página además nombra el producto y la variante específica, porque
suscribirse a una línea de productos y suscribirse a un solo tono de esa línea
son suscripciones distintas, y una pantalla de consentimiento que omite la
diferencia no es consentimiento. La escritura es idempotente, así que un doble
click es un éxito y no un ticket de soporte.

### Las dos tools

**17. Dry por defecto, con kill switch por tool.** `CHECKOUT_MODE` y
`STOCK_ALERT_MODE` valen `dry` salvo que se pongan explícitamente en `live`;
`off` saca la tool de `tools/list` por completo. Una llamada en dry corre todas
las verificaciones y responde exactamente qué habría hecho — incluido "esto
habría quedado BLOQUEADO y por qué". *Sin esto:* una tool de escritura que se
arma sola por el hecho de estar desplegada no tiene ensayo posible: su primera
invocación real es en producción, contra dinero. Solo el string exacto `live`
llega a live, así que un error de tipeo falla hacia no hacer nada.

**18. Una tool que no puede ser honesta no se anuncia, y eso incluye las de
lectura.** `tools/list` está gateado por capacidad de punta a punta: sin
`getQuote` no hay `get_quote`; sin `OpsAdapter` no hay tools de trastienda ni
para un llamador autorizado; sin `CheckoutAdapter` *y* `InventoryAdapter` *y*
cotizador no hay `create_checkout`. Lo que no se anuncia responde `-32601`, de
la misma forma, por cualquier motivo. *Sin esto:* despachas stubs. El adaptador
de WooCommerce implementaba tres métodos que no podía responder — `listBrands`
devolviendo `[]`, `getColorCard` devolviendo `null`, `getQuote` rechazando todo
— solo para satisfacer la interfaz, y el servidor anunciaba los tres a
cualquier agente anónimo: una lista de cartas siempre vacía, una búsqueda que
siempre dice "no encontrado", una cotización que siempre falla. Un callejón sin
salida donde el agente entra dos veces es peor que una tool que no está.

**19. La descripción del límite coincide con el límite.** El error nombra las
dos tools y dice que el cupo es compartido; las descripciones dicen lo mismo,
*incluido el caso en que el despliegue no puede identificar a quien llama*.
*Sin esto:* un agente que alterna las dos tools choca antes de lo anunciado,
concluye que el contador es por tool y reintenta — el rate limit generando el
tráfico que debía frenar. En un servidor MCP las descripciones y los mensajes
de error son la API que ve el agente, y una semántica mal descrita se paga en
reintentos.

**20. La llave del rate limit no la elige quien llama.** Ver abajo.

### Sobre ese rate limiter (la versión honesta)

Hay dos cosas mal en "limitar por IP", y la segunda casi nunca se menciona.

**La llave.** Todo el mundo sabe que no hay que confiar en el *primer* valor de
`x-forwarded-for`. Lo que se pasa por alto: un header de forwarding lo escribe
un **proxy**, y si no hay proxy adelante — `node server.js` en un VPS, un
`next start` pelado, nginx sin `proxy_set_header`, un contenedor con puerto
público — el header entero, último salto incluido, es un string que escribió
quien llama. Rotar `X-Forwarded-For: 203.0.113.1, .2, .3…` estrena un bucket
por request y el limitador no hace nada. Por eso este servidor no confía en
**ningún** header de forwarding salvo que nombres el que escribe tu edge:

```bash
TRUSTED_PROXY_HEADER=x-vercel-forwarded-for   # Vercel
TRUSTED_PROXY_HEADER=cf-connecting-ip         # Cloudflare
TRUSTED_PROXY_HEADER=x-storefront-client-ip   # el proxy de WordPress incluido
```

Nombrar un header afirma dos cosas: que tu edge lo *sobrescribe* y que nada más
llega al origen. Si el origen es alcanzable públicamente, ese header lo puede
falsificar cualquiera que lo encuentre — cierra el origen primero (protección
de despliegue, firewall, mTLS). Sin nada declarado, el servidor `--http` usa la
dirección del peer TCP, que nadie puede falsificar; un handler serverless tipo
Fetch no tiene socket que consultar, así que quien llama queda **sin atribuir**
— y un despliegue sin atribución recibe un techo de 60 escrituras por minuto
para todo el proceso, en vez de una promesa por llamador que no puede cumplir.
(No un 5/min compartido: meter a todos en un bucket chico convierte el rate
limiter en una denegación de servicio contra tus propios clientes, que es peor
que el problema que venía a resolver.)

**El almacenamiento.** El contador incluido es un `Map` en la memoria de un
proceso. En serverless eso significa **N instancias tibias = N cupos
independientes**, un cold start lo resetea y un redeploy lo borra. Es fricción
contra un loop de agente, no un WAF ni un control de abuso, y así está rotulado
en `src/lib/ratelimit.ts` en vez de presentarse como un techo que el equipo en
realidad no tiene. `rateLimited(key, max, windowMs)` es un puerto síncrono chico
con una sola forma de llamada, así que cambiarlo por Redis/KV/Durable Objects es
mecánico. Hazlo antes de confiar en el contador para algo.

Por eso mismo los límites que importan están puestos en el **efecto**:
fail-closed de disponibilidad, la reserva atómica, precondición de sin stock,
dedupe en el punto del envío, doble opt-in y kill switch. Esos se sostienen sin
importar cuántas instancias haya, porque los aplica tu base de datos y no un
contador. El cupo de correo por destinatario queda en el medio: durable si tu
`NotifyAdapter` implementa `countOptInEmails`, best-effort si no — y la
respuesta de la tool dice cuál de los dos tienes en vez de dejarte adivinar.

## Configuración de las tools de escritura

| Variable | Default | Qué hace |
| --- | --- | --- |
| `CHECKOUT_MODE` | `dry` | `off` \| `dry` \| `live` para `create_checkout` |
| `STOCK_ALERT_MODE` | `dry` | `off` \| `dry` \| `live` para `subscribe_stock_alert` |
| `CHECKOUT_UNRESERVED` | `refuse` | En modo live, qué hacer cuando el adaptador de inventario no puede **reservar** unidades: `refuse` (no se crea el pedido) o `allow` (acepta que llamadas concurrentes pueden sobrevender; cada recibo lo dice) |
| `STOCK_ALERT_SIGNING_SECRET` | *(sin valor)* | Llave HMAC de los links de opt-in, **mínimo 32 caracteres**. Si falta o es corta, no se puede emitir link y la tool rechaza. `openssl rand -hex 32` |
| `STOCK_ALERT_CONFIRM_URL` | `${NEXT_PUBLIC_SITE_URL}/api/stock-alert/confirm` | Dónde vive la página de confirmación. Sin ninguna de las dos, el modo live **no manda nada** |
| `STOCK_ALERT_PAGE_LOCALE` | `en` | Idioma de esa página (`en` \| `es`), la única pantalla que ve un cliente |
| `TRUSTED_PROXY_HEADER` | *(sin valor)* | Nombre del header que tu edge escribe con la IP del cliente. Sin valor ⇒ los headers de forwarding se ignoran |

Una tool se anuncia solo si el adaptador activo provee la capacidad, así que
nada de lo anterior resucita una tool que el adaptador no puede cumplir.

## Probar los guard rails en 60 segundos

El catálogo de juguete está armado para que aparezcan todos los estados.
`chromaflow-classic-set-12` tiene **4** unidades; `CF-G09` es una variante del
catálogo **sin fila de inventario**; `fieldbook-sketch-a5` está publicado como
`in_stock` con **cero** unidades (la forma exacta de una sobreventa); y
`fieldbook-sketch-a4` es el caso corriente: un producto con **60** unidades
direccionable tanto por su slug como por su SKU `FB-A4`.

```bash
npx storefront-mcp --http 8787 &

# Consolidación + fail-closed: dos líneas de 3 para un producto con 4 unidades.
# Por línea cada una "cabe". Juntas no.
curl -s http://127.0.0.1:8787/ -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_checkout","arguments":{
    "items":[{"slug":"chromaflow-classic-set-12","qty":3},{"slug":"chromaflow-classic-set-12","qty":3}]}}}'
# → bloqueado, qty_requested 6, merged_from_input_lines 2, stock_available 4

# El mismo producto escrito de dos formas, una sola pila de unidades:
# 50 por slug + 50 por SKU contra 60. Por separado cada línea "cabe";
# lo que se verifica es el pozo.
curl -s http://127.0.0.1:8787/ -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_checkout","arguments":{
    "items":[{"slug":"fieldbook-sketch-a4","qty":50},{"sku":"FB-A4","qty":50}]}}}'
# → bloqueado: "only 60 unit(s) available and 100 requested across the lines
#   that share this stock", más shares_stock_with en cada línea

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

Si lo despliegas, define `TRUSTED_PROXY_HEADER` con el header que escribe tu
plataforma (`x-vercel-forwarded-for` en Vercel, `cf-connecting-ip` detrás de
Cloudflare) o el cupo de escritura se vuelve un techo único para toda la
instancia — ver [el rate limiter](#sobre-ese-rate-limiter-la-versión-honesta).

## Escribir tu propio adaptador

La capa de protocolo nunca toca datos directamente: llama a las interfaces de
`src/lib/adapter.ts`. **Dos métodos son obligatorios; todo lo demás es una
capacidad, y las capacidades deciden qué tools existen**:

- **`CatalogAdapter`** (obligatoria) — `searchProducts` y `getProduct`, y esa
  es toda la obligación. Pública por definición. Opcionales en la misma
  interfaz: `getPromotions` → `get_promotions`; `getQuote` → `get_quote` (y es
  precondición de `create_checkout`); `listVariantCharts` + `getVariantChart` →
  las dos tools de cartas, que se anuncian juntas o no se anuncian. Una "carta
  de variantes" es una línea de producto cuyo stock vive por variante: color,
  talla, grano, tueste, capacidad. Si tu catálogo no tiene ese eje, no las
  implementes; no hay nada que stubear.
- **`OpsAdapter`** — habilita las 5 tools protegidas por token.
- **`InventoryAdapter`** — `getAvailability(refs)` devolviendo
  `{units, verified, reason, pool}` por línea. Es la fuente de "cuántas
  unidades hay ahora", y tiene que ser la misma que usan tus tools de lectura.
  Opcionales pero decisivos: `reserve(req)` / `release(id)`, sin los cuales el
  checkout en vivo rechaza (guard rail 6).
- **`CheckoutAdapter`** — `createCheckout(draft)`. Se anuncia solo junto a un
  `InventoryAdapter` y un `getQuote`.
- **`NotifyAdapter`** — `isSubscribed` / `sendOptInEmail` /
  `confirmSubscription`, más el opcional `countOptInEmails` que convierte el
  cupo por destinatario en un techo real.

Un adaptador que implemente solo los dos métodos obligatorios funciona
perfectamente: el resto simplemente no se anuncia. Es una configuración
soportada, no una degradada.

Copia `src/lib/adapters/memory.ts` como referencia, apúntalo a tu base de datos
o API, y regístralo en `src/lib/adapters/index.ts`. Reglas de honestidad del
contrato: si no pudiste verificar stock devuelve `units: null` / `stock: null`
(nunca inventes un número ni caigas a 0); devuelve un `pool` en cada fila de
disponibilidad — la identidad de la pila de unidades que consume esa línea, con
el slug y el SKU de un mismo producto resolviendo al **mismo** pozo, porque si
no un producto pedido de dos formas se verifica dos veces contra el mismo
stock; implementa `reserve` como UNA operación atómica (`UPDATE … WHERE
(on_hand − reserved) >= :qty`), todo o nada, y `release` para el rollback;
sirve todas las respuestas de stock desde una sola fuente, para que el camino
de escritura no valide contra algo distinto de lo que se le mostró al cliente;
resta lo ya comprometido en otra parte (reservas abiertas, otros canales); deja
que `isSubscribed` lance en vez de devolver `false` ante un error, para que
quien llama falle cerrado; ponle timeout a cada llamada externa; y `get_quote`
jamás cobra — cotiza, hace eco del `slug`/`sku` que recibió y cotiza **la
cantidad que le pidieron o rechaza la línea**, porque el checkout compara las
dos y rechaza el carro cuando no coinciden.

Se incluye un esqueleto para **WooCommerce** (Store API) que implementa
exactamente lo que puede responder — `search_products`, `get_product`,
`get_promotions` — y no stubea nada. Los bloques TODO describen qué necesita
cada contrato restante de una instalación de WooCommerce, incluidas las dos
decisiones que nadie puede tomar por ti: la semántica de stock por variante y
cómo reservar unidades.

## Discovery

Plantillas en `discovery/`: `/.well-known/mcp.json` (descriptor legible por
máquinas; reemplaza `{{DOMAIN}}` y sírvelo desde `public/.well-known/`) y un
snippet para `/llms.txt` con la política para agentes. Además, `GET /api/mcp`
devuelve un descriptor JSON. Lista solo las tools que tu despliegue anuncia de
verdad.

Para el Registro MCP oficial, `server.json` es el manifiesto. **Publica primero
en npm**: el registro valida el `mcpName` dentro del tarball publicado, así que
registrar una versión que npm todavía no tiene deja una entrada apuntando a
nada. El workflow de `.github/workflows/publish-mcp-registry.yml` lo verifica
antes de correr.

## Skills over MCP

El servidor también entrega sus propias instrucciones de uso como una skill
servida por el protocolo ([SEP-2640](https://modelcontextprotocol.io/seps/2640-skills-extension),
extensión `io.modelcontextprotocol/skills`). Un host que implementa la extensión
la descubre con `skills/list`, lee `skill://storefront-mcp/SKILL.md` con
`resources/read` y verifica el digest sha256 que trae la entrada. Un host que no
la implementa ve el mismo archivo como un recurso común; nada se rompe.

La extensión está especificada contra la revisión 2026-07-28 del protocolo, así
que el servidor ahora responde `server/discover` y negocia esa revisión (sin
estado, cada petición lleva su versión en `_meta`, `resultType` en cada
resultado, `ttlMs`/`cacheScope` en las listas). Los clientes antiguos siguen
usando `initialize` con 2025-06-18 o 2025-11-25 y no notan nada (`initialize`
nunca responde 2026-07-28: esa revisión no tiene handshake). La respuesta de
`server/discover` además trae `instructions` apuntando a la skill, para que un
host sin la extensión (Claude Code hoy) la lea igual como recurso cuando el
modelo lo decide.

Hablar 2026-07-28 también es rechazar lo que esa revisión manda rechazar: una
versión de protocolo en `_meta` que este servidor no sirve (-32022, con la lista
de las que sí), una petición moderna sin `clientCapabilities` (-32602), y en
HTTP las cabeceras espejo `MCP-Protocol-Version`, `Mcp-Method` y `Mcp-Name`
cuando faltan o contradicen el cuerpo (-32020, HTTP 400). Un método desconocido
en una petición moderna es un 404. Las peticiones que no estampan `_meta`
(revisiones anteriores) se sirven como antes.

El SKILL.md se genera por llamador desde la configuración real del despliegue:
nombra exactamente las tools que `tools/list` le anuncia a ese llamador, dice el
modo actual de cada tool de escritura (dry o live) y dónde termina el permiso de
un agente (nada de checkout sin un pedido explícito de compra, nada de avisos sin
una dirección entregada para eso) y, en una sesión de operador, qué tools de
back-office trae; la skill de un llamador anónimo nunca las menciona. Por eso su
digest cambia cuando cambia la configuración, que es la idea: un host que fijó
el digest lo vuelve a leer entonces.

Pruébalo con un cliente que hable la extensión (mcpc 0.7 o más nuevo se conecta
desde un archivo de configuración, como cualquier host MCP):

```bash
cat > mcp.json <<'EOF'
{ "mcpServers": { "tienda": { "command": "npx", "args": ["-y", "storefront-mcp"] } } }
EOF
npx -y @apify/mcpc connect mcp.json:tienda @tienda
npx -y @apify/mcpc @tienda skills-list
npx -y @apify/mcpc @tienda skills-get storefront-mcp
```

`npm test` compila la CLI y prueba los dos transportes de punta a punta:
capacidad declarada, `skills/list` y `skills/get` coinciden, el frontmatter se
parsea como YAML a los mismos campos de la entrada (la verificación que los
hosts tienen que hacer), digest y tamaño calzan con los bytes servidos, la skill
nombra exactamente las tools que `tools/list` anuncia (en los dos sentidos), y
la skill de un llamador anónimo nunca menciona el back-office. También cubre los
rechazos de 2026-07-28 de arriba y los cuerpos que no son peticiones JSON-RPC
(`null`, números, lotes vacíos), que se responden con -32600 en vez de
ejecutarse.

## MCP bajo tu dominio WordPress

Si tu tienda corre en WordPress/WooCommerce pero el servidor MCP vive en otra
parte, `wordpress-proxy/mcp-proxy.php` es un mu-plugin que sirve
`https://tutienda.com/api/mcp` haciendo proxy al upstream: engancha en `init`
con prioridad 0, reenvía el header `Authorization` sin tocarlo, reenvía la IP
real del cliente en `X-Storefront-Client-IP` (sobrescribiendo lo que haya
mandado quien llama), maneja el preflight CORS, responde GET con un descriptor,
limita los payloads a 256 KB y ante una falla del upstream responde con un
error JSON-RPC, nunca con una página HTML. Se instala copiando el archivo a
`wp-content/mu-plugins/` y definiendo `STOREFRONT_MCP_UPSTREAM` en
`wp-config.php`.

Después define `TRUSTED_PROXY_HEADER=x-storefront-client-ip` **en el upstream**:
sin eso, todos los requests llegan con la dirección del servidor de WordPress y
el cupo de escritura se vuelve 5 llamadas por minuto para toda la tienda, así
que un solo agente en loop deja sin checkout a todos los clientes. Confía en ese
header solo si al upstream no se puede llegar salvo por el proxy; si es
alcanzable públicamente, cualquiera que lo encuentre puede escribir el header él
mismo.

## ¿Por qué no usar el MCP de Shopify y ya?

Si estás en Shopify: Shopify le regala a cada tienda un endpoint MCP con un
`search_catalog` genérico, y funciona bien. Úsalo. Esta plantilla es para lo
que ese endpoint no cubre: tiendas fuera de Shopify (WooCommerce, stack
propio, headless), y sobre todo **tools que ninguna plataforma va a generar
por ti**. El ejemplo trabajado acá: `get_variant_chart`, la carta completa de
variantes de una línea de producto con *stock vivo por variante*. Cualquier
tienda puede decir "vendemos estos marcadores"; solo la que conectó su propio
inventario puede decir "el tono W3 está disponible ahora y el R21 no". Esa
respuesta por variante cierra ventas, y ninguna tool genérica la tiene.

Y hay un segundo motivo: **tools de escritura que puedas defender**. Una
plataforma alojada decide por ti qué verifica su checkout. Acá los rechazos
están en tu repositorio, son revisables, y los que protegen a un tercero no son
configurables.

## Cambios que rompen compatibilidad en 2.0

- `get_color_card` → **`get_variant_chart`** (argumento `brand` → `chart`) y
  `list_brands` → **`list_variant_charts`**. Los nombres viejos describían el
  dominio de una tienda, no el contrato; el payload renombra `colors` →
  `variants` y `hex` → `swatch_hex` (opcional).
- `CatalogAdapter` ahora exige solo `searchProducts` y `getProduct`. Los otros
  cuatro métodos son opcionales y cada uno gatea su tool.
- `AvailabilityRow.pool` es nuevo. Los adaptadores que no lo devuelven siguen
  funcionando, pero no pueden detectar colisiones slug/SKU (guard rail 3).
- `create_checkout` en vivo exige `InventoryAdapter.reserve` salvo que se ponga
  `CHECKOUT_UNRESERVED=allow` (guard rail 6).
- Los headers de forwarding se ignoran salvo que `TRUSTED_PROXY_HEADER` nombre
  uno (guard rail 20).
- `STOCK_ALERT_SIGNING_SECRET` debe tener al menos 32 caracteres, y los avisos
  en vivo ahora exigen una URL de confirmación configurada.

## Licencia

Apache-2.0 — ver [LICENSE](LICENSE) y [NOTICE](NOTICE).
