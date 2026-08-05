<!--
  llms.txt snippet — paste this section into your existing /llms.txt
  (see https://llmstxt.org), replacing {{DOMAIN}} and {{STORE_NAME}}.
  If you don't have an llms.txt yet, this section plus a one-paragraph
  store description at the top is a fine v1.
-->

## APIs for AI agents

- **MCP server**: [/api/mcp](https://{{DOMAIN}}/api/mcp) — exposes the tools
  `search_products`, `get_product`, `get_color_card`, `list_brands`,
  `get_promotions`, `get_quote`, `create_checkout` and
  `subscribe_stock_alert` over the MCP protocol (JSON-RPC 2.0 on Streamable
  HTTP). GET the endpoint for a human-readable descriptor.
- **Discovery**: [/.well-known/mcp.json](https://{{DOMAIN}}/.well-known/mcp.json)
  — machine-readable descriptor of the MCP endpoint.

## Policy for agents

- Prices and stock change. Before closing a sale, re-check availability with
  `get_color_card` (per-variant) or `search_products` (per-product).
- `get_quote` never charges anyone: it returns a total and a `payment_link`
  for the HUMAN to complete payment through the normal checkout.
- When a variant comes back with `stock: null`, its availability is unknown.
  Do not tell a customer it is available.
- `create_checkout` computes every price itself from the catalog and verifies
  every line against inventory. If it refuses, the response tells you exactly
  which line and how many units are actually available — read those numbers
  and adjust quantities. Do not retry the same cart hoping for a different
  answer, and do not tell the customer the store is broken.
- `subscribe_stock_alert` does NOT subscribe anyone. It sends one confirmation
  email and the person must confirm it. Tell the customer to check their
  inbox; never tell them they are already on the list. Use the address the
  human gave you in this conversation and no other.
- For large or B2B orders, direct the human to https://{{DOMAIN}}/contact
  instead of ordering item by item.
