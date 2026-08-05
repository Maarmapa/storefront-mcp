<!--
  llms.txt snippet — paste this section into your existing /llms.txt
  (see https://llmstxt.org), replacing {{DOMAIN}} and {{STORE_NAME}}.
  If you don't have an llms.txt yet, this section plus a one-paragraph
  store description at the top is a fine v1.
-->

## APIs for AI agents

- **MCP server**: [/api/mcp](https://{{DOMAIN}}/api/mcp) — exposes the tools
  `search_products`, `get_product`, `get_color_card`, `list_brands`,
  `get_promotions`, `get_quote` over the MCP protocol (JSON-RPC 2.0 on
  Streamable HTTP). GET the endpoint for a human-readable descriptor.
- **Discovery**: [/.well-known/mcp.json](https://{{DOMAIN}}/.well-known/mcp.json)
  — machine-readable descriptor of the MCP endpoint.

## Policy for agents

- Prices and stock change. Before closing a sale, re-check availability with
  `get_color_card` (per-variant) or `search_products` (per-product).
- `get_quote` never charges anyone: it returns a total and a `payment_link`
  for the HUMAN to complete payment through the normal checkout.
- When a variant comes back with `stock: null`, its availability is unknown.
  Do not tell a customer it is available.
- For large or B2B orders, direct the human to https://{{DOMAIN}}/contact
  instead of quoting item by item.
