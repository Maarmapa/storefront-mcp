// What this read profile is willing to call.
//
// The list is an allowlist, not "everything tools/list returned minus a
// denylist". A write tool added on the server tomorrow is not called just
// because this client has not heard of it yet.
//
// `get_quote` is a public read in the MCP server, and it is still absent
// here. The tool contract includes `payment_link`. Memory's getQuote builds
// that string without calling checkout or reserve; the WooCommerce notes
// describe POST /cart/add-item as one way to implement the same method.
// Those are different effects behind one tool name. Stripping `payment_link`
// from a response does not undo an order, a hold, or a link the handler
// already created, so this profile does not call the tool at all.

export const READ_TOOL_ALLOWLIST = [
  'search_products',
  'get_product',
  'list_variant_charts',
  'get_variant_chart',
] as const;

export type AllowlistedTool = (typeof READ_TOOL_ALLOWLIST)[number];

const ALLOWED = new Set<string>(READ_TOOL_ALLOWLIST);

export function isAllowlistedReadTool(name: string): name is AllowlistedTool {
  return ALLOWED.has(name);
}

export const QUOTE_UNSUPPORTED_MESSAGE =
  'quoteCart is unsupported in this read profile. This client does not call get_quote: ' +
  'the tool contract can return payment_link, and omitting that field would not undo an order, hold, or link created by the call.';

export const PRICE_UNSUPPORTED_MESSAGE =
  'getPrice is unsupported. This contract has no separate price method, and this client does not ' +
  'turn a catalog display price or a quote into an offer.';

export const AVAILABILITY_UNSUPPORTED_MESSAGE =
  'getAvailability is unsupported. This read profile has no public quantity check that resolves variant, unit, and pool. ' +
  'It does not read privileged stock tools and it does not treat a catalog flag or a missing count as zero.';

export const VARIANTS_UNSUPPORTED_MESSAGE =
  'getVariants is unsupported on this server manifest. It requires both list_variant_charts and get_variant_chart. ' +
  'This client does not pass a product ref as a brand.';

export const CAPABILITY_UNKNOWN_MESSAGE =
  'The server tool manifest could not be read, so this operation stays unknown. It was not called and it was not marked unsupported for every source.';

/** Same ceiling as cart.ts MAX_UNITS_PER_PRODUCT. Rejected, never clamped. */
export const MAX_LINE_QTY = 50;

export const MAX_QUOTE_LINES = 20;

export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 25;
export const MAX_QUERY_LENGTH = 200;
export const MAX_REF_LENGTH = 200;
