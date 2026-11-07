// Public contract for the catalog read client.
//
// Amounts that travel on search/detail are whatever the server already sent.
// This module does not rescale them into minor units: CLP with exponent 0 and
// USD with exponent 2 are indistinguishable if the only signal is a JS number,
// and guessing is how 5900 becomes 590000.

export const SCHEMA_VERSION = 'catalog-read/0.1.0' as const;

export type ReadStatus = 'ok' | 'partial' | 'error';

export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'AUTH_REQUIRED'
  | 'UNSUPPORTED'
  | 'CAPABILITY_UNKNOWN'
  | 'ID_UNRESOLVED'
  | 'SOURCE_CONFLICT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'STALE_DATA'
  | 'CONTRACT_MISMATCH'
  | 'CANCELLED_LOCAL';

export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export type ComponentFreshness = 'fresh' | 'stale' | 'unknown';

export interface ClientError {
  code: ErrorCode;
  message: string;
  field?: string;
  itemIndex?: number;
  retryAfterMs?: number | null;
}

export interface ClientWarning {
  code: string;
  message: string;
}

/**
 * Where a projected document came from. No hosts, payloads, or credentials.
 * `partitionRef` names the transport identity (an opaque label or an endpoint
 * fingerprint). `authScope` is `anonymous` because this profile does not send
 * a credential. `cacheScope` is not part of this block: it is not a grant.
 */
export interface Provenance {
  sourceKind: 'mcp' | 'client-cache' | 'client-policy';
  sourceRef: string;
  partitionRef: string;
  authScope: 'anonymous';
  adapterVersion: string | null;
}

/**
 * Clocks that must not be collapsed into one another.
 * `fetchedAt` is when this client received the document.
 * `cachedAt` is when it was stored in the in-memory cache.
 * `upstreamObservedAt` / `sourceUpdatedAt` are copied only from fields the
 * server actually sent. A cache hit does not refresh them.
 * `expiresAt` is always null: this client does not invent a TTL.
 */
export interface Observation {
  fetchedAt: string | null;
  cachedAt: string | null;
  cacheAgeMs: number | null;
  upstreamObservedAt: string | null;
  sourceUpdatedAt: string | null;
  cacheFreshness: ComponentFreshness;
  expiresAt: null;
}

export interface ComponentStamp {
  freshness: ComponentFreshness;
  upstreamObservedAt: string | null;
  sourceUpdatedAt: string | null;
}

export interface Components {
  catalog: ComponentStamp;
  price: ComponentStamp & { binding: false };
  inventory: ComponentStamp & { status: 'unknown' | 'available' | 'unavailable' };
}

export interface ReadEnvelope<T> {
  schemaVersion: typeof SCHEMA_VERSION;
  profile: 'catalog-read';
  requestId: string;
  attemptId: string;
  status: ReadStatus;
  data: T | null;
  errors: ClientError[];
  warnings: ClientWarning[];
  provenance: Provenance;
  observation: Observation;
  components: Components;
}

/** Non-binding display amount. `exponent` null means the server did not say. */
export interface ReferencePrice {
  amount: number;
  currency: string | null;
  exponent: null;
  unit: 'major-as-provided';
  binding: false;
}

export interface SearchItem {
  productRef: string;
  name: string;
  brand: string | null;
  referencePrice: ReferencePrice | null;
}

export interface SearchData {
  query: string;
  items: SearchItem[];
  reportedCount: number | null;
  nextCursor: null;
}

export interface ProductData {
  productRef: string;
  name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  url: string | null;
  referencePrice: ReferencePrice | null;
  /** Catalog publication flag. Not a verified unit count. */
  catalogAvailability: 'in_stock' | 'out_of_stock' | 'unknown';
  inventory: {
    status: 'unknown';
    units: null;
    reason: 'not-a-verified-inventory-read';
  };
}

export interface VariantView {
  variantRef: string | null;
  mappingStatus: 'server-sku' | 'unresolved';
  attributes: {
    code: string;
    name: string;
    axis: string | null;
    swatchHex: string | null;
  };
  /**
   * Coarse flag copied from the chart when that chart says it verified stock.
   * `units` is always null: exact counts are not part of this public profile,
   * and a missing count is not zero.
   */
  availability: {
    status: 'available' | 'unavailable' | 'unknown';
    units: null;
    source: 'variant-chart-coarse-flag' | 'not-verified';
  };
}

export interface VariantsData {
  chartRef: string;
  axis: string | null;
  variants: VariantView[];
}

export interface CapabilityManifest {
  operations: {
    searchProducts: CapabilityState;
    getProduct: CapabilityState;
    getVariants: CapabilityState;
    getAvailability: 'unsupported';
    getPrice: 'unsupported';
    quoteCart: 'unsupported';
  };
  /** Server-announced tools this profile will not call. */
  announcedNotCallable: string[];
  allowlist: readonly string[];
}

export interface CallControl {
  cacheScope?: string;
  signal?: AbortSignal;
  rejectStale?: boolean;
  requestId?: string;
  refresh?: boolean;
}

export interface SearchInput extends CallControl {
  query: string;
  limit?: number;
}

export interface ProductInput extends CallControl {
  productRef: string;
}

export interface VariantsInput extends CallControl {
  chartRef?: string;
  /** Rejected. A product ref is not a chart ref and is not a brand. */
  productRef?: string;
  cursor?: unknown;
}

export interface QuantityLine {
  variantRef?: string;
  sku?: string;
  productRef?: string;
  qty: number;
}

export interface AvailabilityInput extends CallControl {
  lines: QuantityLine[];
  officeId?: unknown;
  exact?: unknown;
  units?: unknown;
  pool?: unknown;
}

export interface PriceInput extends CallControl {
  variantRef: string;
  qty: number;
  currency?: string;
}

export interface QuoteInput extends CallControl {
  lines: QuantityLine[];
  currency?: string;
}
