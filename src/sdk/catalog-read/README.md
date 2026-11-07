# Catalog read client

Unpublished TypeScript client for six catalog reads. It lives in this repo so a web app, a React Native bundle, or an agent runtime can share one contract. It is not a second MCP server, not an npm package, and not a registered MCP namespace. `tsconfig.build.json` does not compile this folder into the `storefront-mcp` tarball.

## SDK and MCP

MCP (`src/lib/protocol.ts`) is the server. It announces tools from the active adapter and dispatches `tools/call`. This client is a caller of that protocol. It does not replace the adapter, the privilege check, or the write guard rails.

| | MCP server | This client |
| --- | --- | --- |
| Process | Answers JSON-RPC | Sends JSON-RPC through an injected transport |
| Authority | Prices, permissions, and effects stay on the server | Projects public fields and reports errors |
| Tool list | Whatever the adapter implements | Fixed allowlist: `search_products`, `get_product`, `list_variant_charts`, `get_variant_chart` |
| Secrets | `MCP_SECRET` gates ops tools | No `Authorization` header, no cookie, no `localStorage` |

`get_quote` is a public MCP tool. This client still does not call it.

## Quote is unsupported on purpose

`CatalogAdapter.getQuote` is optional. The `Quote` type includes `payment_link`, and the tool text tells an agent to hand that link to a person.

What was read in this repo, not executed against a live store:

- `MemoryCatalogAdapter.getQuote` builds a demo URL string. The function does not call `reserve`, `createCheckout`, or `sendOptInEmail`.
- `src/lib/adapters/woocommerce.ts` does not implement `getQuote`. Its TODO names `POST /cart/add-item` as one possible implementation. That call would create cart state.
- One tool name covers both shapes. Deleting `payment_link` from a response would not undo an order, a hold, or a link created before the response was filtered.

Until a server manifest states that a specific quote implementation has no effect, and a test observes that claim, `quoteCart` returns `UNSUPPORTED` and does not call the transport. `getPrice` is unsupported for the same family of reasons: there is no separate price method, and a display price times a quantity is not an offer. `getAvailability` is unsupported: exact stock is either on a privileged ops tool or inside a variant chart as a raw count. This profile does not call `get_stock_bulk`, and it does not turn "no count" into zero.

`getVariants` is supported only when the server manifest announces both chart tools. The argument is `chartRef`. A `productRef` is rejected with `ID_UNRESOLVED`. This repo's memory adapter will also resolve a brand name if one is passed as `chart`; this client does not do that translation. A Boykot `get_color_card` adapter, which keys charts by brand, is not in this repository and was not called.

## Usage

```ts
import { CatalogReadClient, createHttpTransport } from './src/sdk/catalog-read';

const client = new CatalogReadClient({
  transport: createHttpTransport('https://shop.example.com/api/mcp'),
});

const found = await client.searchProducts({ query: 'warm gray marker', limit: 8 });
// found.data.items[].referencePrice.binding === false
// found.observation.sourceUpdatedAt === null when the server omits it
// found.observation.fetchedAt is when this client received the document

const detail = await client.getProduct({ productRef: 'fieldbook-sketch-a5' });
// detail.data.catalogAvailability is the catalog flag
// detail.data.inventory.status === 'unknown'
// detail.data.inventory.units === null

const quote = await client.quoteCart({
  lines: [{ variantRef: 'SYN-SKU', qty: 2 }],
  currency: 'CLP',
});
// quote.errors[0].code === 'UNSUPPORTED'
// the transport was not asked to call get_quote
```

The endpoint is fixed on the transport. A per-call `endpoint`, `unitPrice`, `role`, or `currency` on search is `INVALID_ARGUMENT` and is not stripped and ignored. `currency` on `quoteCart` is accepted as a requested context and still produces no converted total.

Cache is a `Map` in the client. `cacheScope` only partitions that map. It is not sent to the server and it is not a tenant grant. A later hit reuses `fetchedAt`, `upstreamObservedAt`, and `sourceUpdatedAt` from the first response. `expiresAt` is always null.

## What the tests in this increment actually ran

`tests/catalog-read-client.test.ts` uses a mock transport plus one in-process call into the demo memory adapter. That is not a production probe and not a Boykot runtime check.

| Proposed case | What ran here |
| --- | --- |
| A01, A02 | Manifest without the optional pair, and a fictional `export_customers`, stay off the allowlist. No successful empty list. |
| A06 | Search note that the backend is unavailable becomes `UPSTREAM_UNAVAILABLE`, data null. |
| A08 | Chart fixture with `stock: 4242` is projected without that number. `officeId` is rejected. |
| A09, A10, A22, A25 | Injected price, bad qty, foreign currency on search, and a caller host are rejected with zero transport calls. |
| A14, A15, A24 | `quoteCart` does not call a transport that would count a payment link, including with retries enabled. |
| A17, A18, A19 | Component stamps stay independent. Missing `sourceUpdatedAt` stays null. A cache hit does not move `fetchedAt`. |
| A20 | Two `cacheScope` values do not share a document. |
| A21, A23, A27 | HTTP 403 is not retried and does not swap credentials. Abort is `CANCELLED_LOCAL`. Bearer text and paths are redacted. |
| A03–A05, A07, A11–A13, A16, A26, A28, A29 | Not claimed as passing server behavior. Identity, pools, kits, taxes, and private-field filtering belong on a server that does not exist in this client. A28 is explicitly not met by dropping fields here. |

## Pending adapters

Not implemented, and no extra repository was created:

- Boykot catalog connector (`get_product` by slug, `get_color_card` by brand, `get_quote` with `payment_link`).
- A line-to-brand resolver.
- BSale stock, WooCommerce `wc/v3`, Mercado Libre.
- A pure quote route whose implementation has been shown not to create an order, hold, link, email, subscription, or stored document.
- A server manifest endpoint. This client reads `tools/list` and applies its own allowlist. No route was added.
- Agency OS. Nothing in this folder reads its sessions, cookies, or grants.
