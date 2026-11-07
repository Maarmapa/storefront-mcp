import { cacheKey, MemoryReadCache, type CacheRecord } from './cache';
import {
  AVAILABILITY_UNSUPPORTED_MESSAGE,
  CAPABILITY_UNKNOWN_MESSAGE,
  isAllowlistedReadTool,
  PRICE_UNSUPPORTED_MESSAGE,
  QUOTE_UNSUPPORTED_MESSAGE,
  READ_TOOL_ALLOWLIST,
  VARIANTS_UNSUPPORTED_MESSAGE,
} from './policy';
import { projectProduct, projectSearch, projectVariantChart } from './project';
import { redactPublicMessage } from './redact';
import type {
  AvailabilityInput,
  CallControl,
  CapabilityManifest,
  CapabilityState,
  ClientError,
  ClientWarning,
  Components,
  ComponentStamp,
  Observation,
  PriceInput,
  ProductData,
  ProductInput,
  Provenance,
  QuoteInput,
  ReadEnvelope,
  SearchData,
  SearchInput,
  VariantsData,
  VariantsInput,
} from './types';
import { SCHEMA_VERSION } from './types';
import type { ReadTransport, RpcRequest, RpcResponse } from './transport';
import {
  parseAvailabilityInput,
  parsePriceInput,
  parseProductInput,
  parseQuoteInput,
  parseSearchInput,
  parseVariantsInput,
  type CommonCall,
  type FieldError,
} from './validate';

export interface CatalogReadOptions {
  transport: ReadTransport;
  now?: () => Date;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Total tries for a pure allowlisted read. Default 1 (no retry). Quote is never retried. */
  retry?: { maxAttempts: number; backoffMs: number };
  /** When set, a cache hit older than this is stale. It does not invent source freshness. */
  staleAfterMs?: number;
  deadlineMs?: number;
  cache?: MemoryReadCache;
}

interface Manifest {
  tools: Set<string>;
  adapterVersion: string | null;
  fetchedAt: string;
}

interface AttemptFailure {
  code: ClientError['code'];
  message: string;
  retryAfterMs?: number | null;
  retryable: boolean;
}

const SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

function defaultId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (list: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function stamp(): ComponentStamp {
  return { freshness: 'unknown', upstreamObservedAt: null, sourceUpdatedAt: null };
}

function unknownComponents(): Components {
  return {
    catalog: stamp(),
    price: { ...stamp(), binding: false },
    inventory: { ...stamp(), status: 'unknown' },
  };
}

function emptyObservation(): Observation {
  return {
    fetchedAt: null,
    cachedAt: null,
    cacheAgeMs: null,
    upstreamObservedAt: null,
    sourceUpdatedAt: null,
    cacheFreshness: 'unknown',
    expiresAt: null,
  };
}

function versionFrom(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const info = meta[SERVER_INFO];
  if (!info || typeof info !== 'object') return null;
  const version = (info as { version?: unknown }).version;
  if (typeof version !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(version)) return null;
  return version;
}

function unwrapTool(result: unknown): { ok: true; payload: unknown; meta: Record<string, unknown> | null } | { ok: false } {
  if (!result || typeof result !== 'object') return { ok: true, payload: result, meta: null };
  const record = result as Record<string, unknown>;
  const meta =
    record._meta && typeof record._meta === 'object' && !Array.isArray(record._meta)
      ? (record._meta as Record<string, unknown>)
      : null;
  const content = record.content;
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0];
    if (first && typeof first === 'object' && (first as { type?: unknown }).type === 'text') {
      const text = (first as { text?: unknown }).text;
      if (typeof text !== 'string') return { ok: false };
      try {
        return { ok: true, payload: JSON.parse(text) as unknown, meta };
      } catch {
        return { ok: false };
      }
    }
  }
  return { ok: true, payload: result, meta };
}

export class CatalogReadClient {
  private readonly transport: ReadTransport;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly staleAfterMs: number | null;
  private readonly deadlineMs: number;
  private readonly cache: MemoryReadCache;
  private manifest: Manifest | null = null;

  constructor(options: CatalogReadOptions) {
    if (!options || typeof options.transport?.send !== 'function') {
      throw new TypeError('CatalogReadClient requires a transport.');
    }
    const attempts = options.retry?.maxAttempts ?? 1;
    const backoff = options.retry?.backoffMs ?? 0;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) {
      throw new TypeError('retry.maxAttempts must be an integer from 1 to 3.');
    }
    if (!Number.isInteger(backoff) || backoff < 0 || backoff > 10_000) {
      throw new TypeError('retry.backoffMs must be an integer from 0 to 10000.');
    }
    const deadline = options.deadlineMs ?? 8000;
    if (!Number.isInteger(deadline) || deadline < 1 || deadline > 30_000) {
      throw new TypeError('deadlineMs must be an integer from 1 to 30000.');
    }
    if (options.staleAfterMs !== undefined && (!Number.isInteger(options.staleAfterMs) || options.staleAfterMs < 0)) {
      throw new TypeError('staleAfterMs must be a non-negative integer.');
    }
    this.transport = options.transport;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultId;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.maxAttempts = attempts;
    this.backoffMs = backoff;
    this.staleAfterMs = options.staleAfterMs ?? null;
    this.deadlineMs = deadline;
    this.cache = options.cache ?? new MemoryReadCache();
  }

  async searchProducts(input: SearchInput): Promise<ReadEnvelope<SearchData>> {
    const parsed = parseSearchInput(input);
    if (!parsed.ok) return this.invalid(parsed.error, input);
    const loaded = await this.ensureManifest(parsed.value);
    if (!loaded.ok) return loaded.envelope;
    if (!loaded.manifest.tools.has('search_products')) {
      return this.policyError(parsed.value, 'UNSUPPORTED', 'search_products is not in the server manifest.');
    }
    const key = cacheKey('search', parsed.value.cacheScope, { q: parsed.value.query, limit: parsed.value.limit });
    const hit = this.readCache<SearchData>(key, parsed.value);
    if (hit) return hit;
    const result = await this.readAllowlisted('search_products', { query: parsed.value.query, limit: parsed.value.limit }, parsed.value, loaded.manifest.adapterVersion);
    if (!result.ok) return result.envelope;
    const projected = projectSearch(result.payload, parsed.value.query);
    if (!projected.ok) {
      return this.policyError(parsed.value, projected.code, projected.message, 'mcp', 'tool:search_products', result.adapterVersion);
    }
    return this.storeAndReturn(key, parsed.value, projected, 'tool:search_products', result.adapterVersion);
  }

  async getProduct(input: ProductInput): Promise<ReadEnvelope<ProductData>> {
    const parsed = parseProductInput(input);
    if (!parsed.ok) return this.invalid(parsed.error, input);
    const loaded = await this.ensureManifest(parsed.value);
    if (!loaded.ok) return loaded.envelope;
    if (!loaded.manifest.tools.has('get_product')) {
      return this.policyError(parsed.value, 'UNSUPPORTED', 'get_product is not in the server manifest.');
    }
    const key = cacheKey('product', parsed.value.cacheScope, { ref: parsed.value.productRef });
    const hit = this.readCache<ProductData>(key, parsed.value);
    if (hit) return hit;
    const result = await this.readAllowlisted('get_product', { slug: parsed.value.productRef }, parsed.value, loaded.manifest.adapterVersion);
    if (!result.ok) return result.envelope;
    const projected = projectProduct(result.payload);
    if (!projected.ok) {
      return this.policyError(parsed.value, projected.code, projected.message, 'mcp', 'tool:get_product', result.adapterVersion);
    }
    return this.storeAndReturn(key, parsed.value, projected, 'tool:get_product', result.adapterVersion);
  }

  async getVariants(input: VariantsInput): Promise<ReadEnvelope<VariantsData>> {
    const parsed = parseVariantsInput(input);
    if (!parsed.ok) return this.invalid(parsed.error, input);
    const loaded = await this.ensureManifest(parsed.value);
    if (!loaded.ok) return loaded.envelope;
    const charts =
      loaded.manifest.tools.has('list_variant_charts') && loaded.manifest.tools.has('get_variant_chart');
    if (!charts) return this.policyError(parsed.value, 'UNSUPPORTED', VARIANTS_UNSUPPORTED_MESSAGE);
    const key = cacheKey('variants', parsed.value.cacheScope, { chart: parsed.value.chartRef });
    const hit = this.readCache<VariantsData>(key, parsed.value);
    if (hit) return hit;
    const result = await this.readAllowlisted('get_variant_chart', { chart: parsed.value.chartRef }, parsed.value, loaded.manifest.adapterVersion);
    if (!result.ok) return result.envelope;
    const projected = projectVariantChart(result.payload, parsed.value.chartRef);
    if (!projected.ok) {
      return this.policyError(parsed.value, projected.code, projected.message, 'mcp', 'tool:get_variant_chart', result.adapterVersion);
    }
    return this.storeAndReturn(key, parsed.value, projected, 'tool:get_variant_chart', result.adapterVersion);
  }

  async getAvailability(input: AvailabilityInput): Promise<ReadEnvelope<null>> {
    const parsed = parseAvailabilityInput(input);
    if (!parsed.ok) return this.invalid(parsed.error, input);
    return this.policyError(parsed.value, 'UNSUPPORTED', AVAILABILITY_UNSUPPORTED_MESSAGE);
  }

  async getPrice(input: PriceInput): Promise<ReadEnvelope<null>> {
    const parsed = parsePriceInput(input);
    if (!parsed.ok) return this.invalid(parsed.error, input);
    return this.policyError(parsed.value, 'UNSUPPORTED', PRICE_UNSUPPORTED_MESSAGE);
  }

  async quoteCart(input: QuoteInput): Promise<ReadEnvelope<null>> {
    const parsed = parseQuoteInput(input);
    if (!parsed.ok) return this.invalid(parsed.error, input);
    return this.policyError(parsed.value, 'UNSUPPORTED', QUOTE_UNSUPPORTED_MESSAGE);
  }

  async readCapabilities(input: CallControl = {}): Promise<ReadEnvelope<CapabilityManifest>> {
    const rawId = input.requestId;
    const requestId = typeof rawId === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(rawId) ? rawId : null;
    const signal = input.signal;
    if (signal?.aborted) return this.cancelled(requestId);
    if (input.refresh === true) this.manifest = null;
    const loaded = await this.loadManifest(signal, requestId);
    if (!loaded.ok) return loaded.envelope as ReadEnvelope<CapabilityManifest>;
    const data = manifestData(loaded.manifest);
    return this.okEnvelope(requestId, data, [], {
      sourceKind: 'mcp',
      sourceRef: 'rpc:tools/list',
      adapterVersion: loaded.manifest.adapterVersion,
    }, {
      ...emptyObservation(),
      fetchedAt: loaded.manifest.fetchedAt,
      upstreamObservedAt: null,
      sourceUpdatedAt: null,
    }, unknownComponents());
  }

  private invalid<T>(error: FieldError, input: unknown): ReadEnvelope<T> {
    const rawId = isPlain(input) ? input.requestId : undefined;
    const requestId = typeof rawId === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(rawId) ? rawId : null;
    return this.policyError(
      { requestId },
      error.code ?? 'INVALID_ARGUMENT',
      error.message,
      'client-policy',
      'client:validate',
      null,
      error.field,
      error.itemIndex,
    );
  }

  private policyError<T>(
    call: Pick<CommonCall, 'requestId'>,
    code: ClientError['code'],
    message: string,
    sourceKind: Provenance['sourceKind'] = 'client-policy',
    sourceRef = 'client:policy',
    adapterVersion: string | null = null,
    field?: string,
    itemIndex?: number,
    retryAfterMs?: number | null,
  ): ReadEnvelope<T> {
    return this.okEnvelope<T>(
      call.requestId,
      null,
      [{
        code,
        message,
        ...(field ? { field } : {}),
        ...(itemIndex !== undefined ? { itemIndex } : {}),
        ...(retryAfterMs != null ? { retryAfterMs } : {}),
      }],
      { sourceKind, sourceRef, adapterVersion },
      emptyObservation(),
      unknownComponents(),
      'error',
    );
  }

  private cancelled<T>(requestId: string | null): ReadEnvelope<T> {
    return this.policyError(
      { requestId },
      'CANCELLED_LOCAL',
      'The client stopped waiting. That does not mean the server stopped work it had already started.',
    );
  }

  private okEnvelope<T>(
    requestId: string | null,
    data: T | null,
    errors: ClientError[],
    provenance: Provenance,
    observation: Observation,
    components: Components,
    status: ReadEnvelope<T>['status'] = errors.length ? 'error' : 'ok',
    warnings: ClientWarning[] = [],
  ): ReadEnvelope<T> {
    const resolvedStatus = errors.length && status === 'ok' ? 'error' : status;
    return {
      schemaVersion: SCHEMA_VERSION,
      profile: 'catalog-read',
      requestId: requestId ?? this.newId(),
      attemptId: this.newId(),
      status: resolvedStatus,
      data: resolvedStatus === 'error' ? null : data,
      errors,
      warnings,
      provenance,
      observation,
      components,
    };
  }

  private async ensureManifest(call: CommonCall): Promise<{ ok: true; manifest: Manifest } | { ok: false; envelope: ReadEnvelope<never> }> {
    if (call.signal?.aborted) return { ok: false, envelope: this.cancelled(call.requestId) };
    if (this.manifest && !call.refresh) return { ok: true, manifest: this.manifest };
    return this.loadManifest(call.signal, call.requestId);
  }

  private async loadManifest(
    signal: AbortSignal | undefined,
    requestId: string | null,
  ): Promise<{ ok: true; manifest: Manifest } | { ok: false; envelope: ReadEnvelope<never> }> {
    const response = await this.rpc({ jsonrpc: '2.0', id: this.newId(), method: 'tools/list', params: {} }, signal);
    if (!response.ok) {
      if (response.failure.code === 'CANCELLED_LOCAL') return { ok: false, envelope: this.cancelled(requestId) };
      const manifestUnread = response.failure.code === 'TIMEOUT' || response.failure.code === 'UPSTREAM_UNAVAILABLE';
      const code = manifestUnread ? 'CAPABILITY_UNKNOWN' : response.failure.code;
      return {
        ok: false,
        envelope: this.policyError(
          { requestId },
          code,
          manifestUnread ? CAPABILITY_UNKNOWN_MESSAGE : response.failure.message,
          'mcp',
          'rpc:tools/list',
          null,
          undefined,
          undefined,
          response.failure.retryAfterMs,
        ),
      };
    }
    const tools = response.payload;
    if (!tools || typeof tools !== 'object' || !Array.isArray((tools as { tools?: unknown }).tools)) {
      return {
        ok: false,
        envelope: this.policyError(
          { requestId },
          'CAPABILITY_UNKNOWN',
          CAPABILITY_UNKNOWN_MESSAGE,
          'mcp',
          'rpc:tools/list',
          response.adapterVersion,
        ),
      };
    }
    const names = new Set<string>();
    for (const tool of (tools as { tools: unknown[] }).tools) {
      if (tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string') {
        names.add((tool as { name: string }).name);
      }
    }
    const manifest: Manifest = {
      tools: names,
      adapterVersion: response.adapterVersion,
      fetchedAt: this.now().toISOString(),
    };
    this.manifest = manifest;
    return { ok: true, manifest };
  }

  private readCache<T>(key: string, call: CommonCall): ReadEnvelope<T> | null {
    if (call.refresh) return null;
    const record = this.cache.get(key);
    if (!record) return null;
    const nowMs = this.now().getTime();
    const age = Math.max(0, nowMs - record.storedAtMs);
    const stale = this.staleAfterMs != null && age > this.staleAfterMs;
    const observation: Observation = {
      fetchedAt: record.fetchedAt,
      cachedAt: new Date(record.storedAtMs).toISOString(),
      cacheAgeMs: age,
      upstreamObservedAt: record.upstreamObservedAt,
      sourceUpdatedAt: record.sourceUpdatedAt,
      cacheFreshness: this.staleAfterMs == null ? 'unknown' : stale ? 'stale' : 'fresh',
      expiresAt: null,
    };
    if (stale && call.rejectStale) {
      return this.okEnvelope<T>(
        call.requestId,
        null,
        [{ code: 'STALE_DATA', message: 'The cached document is older than the caller policy. It was not presented as current, and the upstream observation time was not rewritten.' }],
        { sourceKind: 'client-cache', sourceRef: record.sourceRef, adapterVersion: record.adapterVersion },
        observation,
        record.components,
        'error',
      );
    }
    const warnings = stale
      ? [...record.warnings, { code: 'STALE_DATA', message: 'Served from the in-memory cache. The upstream observation time was not moved forward.' }]
      : record.warnings;
    return this.okEnvelope(
      call.requestId,
      record.data as T,
      [],
      { sourceKind: 'client-cache', sourceRef: record.sourceRef, adapterVersion: record.adapterVersion },
      observation,
      record.components,
      stale || record.partial ? 'partial' : 'ok',
      warnings,
    );
  }

  private storeAndReturn<T>(
    key: string,
    call: CommonCall,
    projected: {
      partial: boolean;
      data: T;
      warnings: ClientWarning[];
      upstreamObservedAt: string | null;
      sourceUpdatedAt: string | null;
    },
    sourceRef: string,
    adapterVersion: string | null,
  ): ReadEnvelope<T> {
    const fetchedAt = this.now().toISOString();
    const components = unknownComponents();
    components.catalog = {
      freshness: 'unknown',
      upstreamObservedAt: projected.upstreamObservedAt,
      sourceUpdatedAt: projected.sourceUpdatedAt,
    };
    const record: CacheRecord = {
      storedAtMs: this.now().getTime(),
      fetchedAt,
      upstreamObservedAt: projected.upstreamObservedAt,
      sourceUpdatedAt: projected.sourceUpdatedAt,
      adapterVersion,
      sourceRef,
      data: projected.data,
      components,
      warnings: projected.warnings,
      partial: projected.partial,
    };
    this.cache.set(key, record);
    return this.okEnvelope(
      call.requestId,
      projected.data,
      [],
      { sourceKind: 'mcp', sourceRef, adapterVersion },
      {
        fetchedAt,
        cachedAt: null,
        cacheAgeMs: null,
        upstreamObservedAt: projected.upstreamObservedAt,
        sourceUpdatedAt: projected.sourceUpdatedAt,
        cacheFreshness: 'unknown',
        expiresAt: null,
      },
      components,
      projected.partial ? 'partial' : 'ok',
      projected.warnings,
    );
  }

  private async readAllowlisted(
    name: string,
    args: Record<string, unknown>,
    call: CommonCall,
    adapterVersion: string | null,
  ): Promise<{ ok: true; payload: unknown; adapterVersion: string | null } | { ok: false; envelope: ReadEnvelope<never> }> {
    if (!isAllowlistedReadTool(name)) {
      return { ok: false, envelope: this.policyError(call, 'UNSUPPORTED', 'That tool is outside the read allowlist and was not called.') };
    }
    let last: AttemptFailure | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (call.signal?.aborted) return { ok: false, envelope: this.cancelled(call.requestId) };
      const response = await this.rpc(
        { jsonrpc: '2.0', id: this.newId(), method: 'tools/call', params: { name, arguments: args } },
        call.signal,
      );
      if (response.ok) {
        return { ok: true, payload: response.payload, adapterVersion: response.adapterVersion ?? adapterVersion };
      }
      last = response.failure;
      if (!response.failure.retryable || attempt === this.maxAttempts) break;
      if (this.backoffMs > 0) await this.sleep(this.backoffMs);
    }
    return {
      ok: false,
      envelope: this.policyError(
        call,
        last?.code ?? 'UPSTREAM_UNAVAILABLE',
        last?.message ?? 'The read failed.',
        'mcp',
        `tool:${name}`,
        adapterVersion,
        undefined,
        undefined,
        last?.retryAfterMs,
      ),
    };
  }

  private async rpc(
    request: RpcRequest,
    userSignal: AbortSignal | undefined,
  ): Promise<{ ok: true; payload: unknown; adapterVersion: string | null } | { ok: false; failure: AttemptFailure }> {
    if (userSignal?.aborted) {
      return { ok: false, failure: { code: 'CANCELLED_LOCAL', message: 'The client stopped waiting.', retryable: false } };
    }
    const timeout = AbortSignal.timeout(this.deadlineMs);
    const signal = anySignal(userSignal ? [userSignal, timeout] : [timeout]);
    let response: RpcResponse;
    try {
      response = await this.transport.send(request, { signal });
    } catch (error) {
      if (userSignal?.aborted) {
        return { ok: false, failure: { code: 'CANCELLED_LOCAL', message: 'The client stopped waiting. That does not mean the server stopped work it had already started.', retryable: false } };
      }
      const name = error instanceof Error ? error.name : '';
      if (timeout.aborted || name === 'TimeoutError') {
        return { ok: false, failure: { code: 'TIMEOUT', message: 'The read timed out before a document arrived. No stock or price was invented.', retryable: true } };
      }
      return {
        ok: false,
        failure: { code: 'UPSTREAM_UNAVAILABLE', message: redactPublicMessage(error instanceof Error ? error.message : ''), retryable: true },
      };
    }
    return this.interpret(response);
  }

  private interpret(response: RpcResponse): { ok: true; payload: unknown; adapterVersion: string | null } | { ok: false; failure: AttemptFailure } {
    if (response.status === 401) {
      return { ok: false, failure: { code: 'AUTH_REQUIRED', message: 'The server required authentication. This client does not attach a credential or try a different one.', retryable: false } };
    }
    if (response.status === 403) {
      return { ok: false, failure: { code: 'FORBIDDEN', message: 'The server refused this read. This client does not retry with a different credential.', retryable: false } };
    }
    if (response.status === 429) {
      return { ok: false, failure: { code: 'RATE_LIMITED', message: 'The server rate-limited the read. It was not retried automatically.', retryable: false, retryAfterMs: response.retryAfterMs } };
    }
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, failure: { code: 'UPSTREAM_UNAVAILABLE', message: 'The endpoint redirected. The redirect was not followed.', retryable: false } };
    }
    if (response.status >= 500 || response.status === 0) {
      return { ok: false, failure: { code: 'UPSTREAM_UNAVAILABLE', message: 'The endpoint returned a server error.', retryable: true } };
    }
    const body = response.body;
    if (!body || typeof body !== 'object') {
      return { ok: false, failure: { code: 'UPSTREAM_UNAVAILABLE', message: 'The endpoint did not return a JSON-RPC object.', retryable: true } };
    }
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object') {
      const code = (error as { code?: unknown }).code;
      const message = redactPublicMessage((error as { message?: unknown }).message, 'The server rejected the read.');
      if (code === -32001) return { ok: false, failure: { code: 'AUTH_REQUIRED', message: 'The server required authentication. This client does not attach a credential or try a different one.', retryable: false } };
      if (code === -32005) return { ok: false, failure: { code: 'RATE_LIMITED', message, retryable: false, retryAfterMs: response.retryAfterMs } };
      if (code === -32601) return { ok: false, failure: { code: 'UNSUPPORTED', message: 'The server does not implement that method or tool.', retryable: false } };
      if (code === -32602) return { ok: false, failure: { code: 'INVALID_ARGUMENT', message, retryable: false } };
      return { ok: false, failure: { code: 'UPSTREAM_UNAVAILABLE', message, retryable: code === -32603 } };
    }
    const result = (body as { result?: unknown }).result;
    const unwrapped = unwrapTool(result);
    if (!unwrapped.ok) {
      return { ok: false, failure: { code: 'CONTRACT_MISMATCH', message: 'The tool result was not valid JSON. No empty document was substituted.', retryable: false } };
    }
    return { ok: true, payload: unwrapped.payload, adapterVersion: versionFrom(unwrapped.meta) };
  }
}

function isPlain(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === 'object' && !Array.isArray(input);
}

function operationState(tools: Set<string>, name: string): CapabilityState {
  return tools.has(name) ? 'supported' : 'unsupported';
}

function manifestData(manifest: Manifest): CapabilityManifest {
  const charts = manifest.tools.has('list_variant_charts') && manifest.tools.has('get_variant_chart');
  const announcedNotCallable = [...manifest.tools].filter(name => !isAllowlistedReadTool(name)).sort();
  return {
    operations: {
      searchProducts: operationState(manifest.tools, 'search_products'),
      getProduct: operationState(manifest.tools, 'get_product'),
      getVariants: charts ? 'supported' : 'unsupported',
      getAvailability: 'unsupported',
      getPrice: 'unsupported',
      quoteCart: 'unsupported',
    },
    announcedNotCallable,
    allowlist: READ_TOOL_ALLOWLIST,
  };
}
