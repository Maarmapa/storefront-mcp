// Acceptance tests for the catalog read client.
//
// Fixtures in this file are synthetic and labeled. The one in-process case
// uses the repo's demo memory adapter (examples/toy-catalog.json). None of
// these tests call Boykot, BSale, WooCommerce, Mercado Libre, or a payment
// provider. A mock that would record an effect is not a runtime proof that a
// live get_quote is side-effect free.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { MAX_UNITS_PER_PRODUCT } from '../src/lib/cart';
import { handleRequest } from '../src/lib/protocol';
import {
  CatalogReadClient,
  MemoryReadCache,
  MAX_LINE_QTY,
  READ_AUTH_SCOPE,
  READ_TOOL_ALLOWLIST,
  assertPartitionRef,
  assertReadEndpoint,
  createHttpTransport,
  isAllowlistedReadTool,
  type CacheRecord,
  type ReadTransport,
  type RpcRequest,
  type RpcResponse,
} from '../src/sdk/catalog-read';

const SYNTHETIC = 'synthetic-fixture';

function rpc(result: unknown, status = 200): RpcResponse {
  return { status, body: { jsonrpc: '2.0', id: '1', result }, retryAfterMs: null };
}

function tool(payload: unknown, status = 200): RpcResponse {
  return rpc({ content: [{ type: 'text', text: JSON.stringify(payload) }] }, status);
}

function tools(names: string[]): RpcResponse {
  return rpc({ tools: names.map(name => ({ name, description: SYNTHETIC, inputSchema: { type: 'object' } })) });
}

interface Effects {
  orders: number;
  paymentLinks: number;
  holds: number;
  emails: number;
  subscriptions: number;
  documents: number;
}

function scripted(handler: (request: RpcRequest) => RpcResponse | Promise<RpcResponse>, partitionRef = 'synthetic-fixture') {
  const calls: RpcRequest[] = [];
  const effects: Effects = { orders: 0, paymentLinks: 0, holds: 0, emails: 0, subscriptions: 0, documents: 0 };
  const transport: ReadTransport = {
    partitionRef,
    async send(request) {
      calls.push(request);
      const name = request.method === 'tools/call' ? String((request.params as { name?: unknown })?.name ?? '') : '';
      if (name === 'get_quote') {
        effects.orders += 1;
        effects.paymentLinks += 1;
        effects.documents += 1;
      }
      if (name === 'create_checkout') effects.orders += 1;
      if (name === 'subscribe_stock_alert') {
        effects.emails += 1;
        effects.subscriptions += 1;
      }
      const response = await handler(request);
      if (response.body && typeof response.body === 'object' && !Array.isArray(response.body)) {
        return { ...response, body: { ...(response.body as Record<string, unknown>), id: request.id } };
      }
      return response;
    },
  };
  return { calls, effects, transport };
}

function toolName(request: RpcRequest): string {
  return request.method === 'tools/call' ? String((request.params as { name?: unknown })?.name ?? '') : request.method;
}

function keysDeep(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      found.add(key);
      keysDeep(child, found);
    }
  }
  return found;
}

function numbersDeep(value: unknown, found: number[] = []): number[] {
  if (typeof value === 'number') found.push(value);
  else if (Array.isArray(value)) value.forEach(item => numbersDeep(item, found));
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(item => numbersDeep(item, found));
  return found;
}

const CORE_AND_NOISE = [
  'search_products',
  'get_product',
  'get_quote',
  'get_promotions',
  'create_checkout',
  'subscribe_stock_alert',
  'get_stock_bulk',
  'export_customers',
];

describe('catalog read profile', () => {
  it('A01/A02 allowlist does not grow when the server announces a new write tool', async () => {
    assert.deepEqual([...READ_TOOL_ALLOWLIST], ['search_products', 'get_product', 'list_variant_charts', 'get_variant_chart']);
    assert.equal(isAllowlistedReadTool('get_quote'), false);
    assert.equal(isAllowlistedReadTool('create_checkout'), false);
    assert.equal(isAllowlistedReadTool('export_customers'), false);
    assert.equal(MAX_LINE_QTY, MAX_UNITS_PER_PRODUCT);

    const gateway = scripted(request => {
      if (request.method === 'tools/list') return tools(CORE_AND_NOISE);
      if (toolName(request) === 'search_products') {
        return tool({
          query: 'marker',
          total: 1,
          results: [{ slug: 'synthetic-marker', name: 'Synthetic Marker', brand: 'Fixture', price: 5900 }],
        });
      }
      return rpc({ error: 'unexpected' }, 500);
    });
    const client = new CatalogReadClient({ transport: gateway.transport });
    const found = await client.searchProducts({ query: 'marker', limit: 8, requestId: 'trace-a01' });
    assert.equal(found.status, 'ok');
    assert.equal(found.requestId, 'trace-a01');
    assert.equal(found.data?.items[0]?.referencePrice?.amount, 5900);
    assert.equal(found.data?.items[0]?.referencePrice?.exponent, null);
    assert.equal(found.data?.items[0]?.referencePrice?.binding, false);
    assert.equal(found.observation.expiresAt, null);
    assert.equal(found.observation.sourceUpdatedAt, null);
    assert.equal('ready' in found, false);

    const manifest = await client.readCapabilities();
    assert.equal(manifest.data?.operations.searchProducts, 'supported');
    assert.equal(manifest.data?.operations.getVariants, 'unsupported');
    assert.equal(manifest.data?.operations.getAvailability, 'unsupported');
    assert.equal(manifest.data?.operations.getPrice, 'unsupported');
    assert.equal(manifest.data?.operations.quoteCart, 'unsupported');
    assert.deepEqual(manifest.data?.announcedNotCallable, [
      'create_checkout',
      'export_customers',
      'get_promotions',
      'get_quote',
      'get_stock_bulk',
      'subscribe_stock_alert',
    ]);

    const variants = await client.getVariants({ chartRef: 'synthetic-chart' });
    const availability = await client.getAvailability({ lines: [{ variantRef: 'SYN', qty: 1 }] });
    const price = await client.getPrice({ variantRef: 'SYN', qty: 2, currency: 'CLP' });
    const quote = await client.quoteCart({ lines: [{ variantRef: 'SYN', qty: 2 }], currency: 'CLP' });
    assert.equal(variants.errors[0]?.code, 'UNSUPPORTED');
    assert.equal(availability.errors[0]?.code, 'UNSUPPORTED');
    assert.equal(price.errors[0]?.code, 'UNSUPPORTED');
    assert.equal(quote.errors[0]?.code, 'UNSUPPORTED');
    assert.equal(quote.data, null);
    assert.equal(JSON.stringify(quote).includes('11800'), false);
    assert.equal(JSON.stringify(price).includes('11800'), false);
    assert.deepEqual(gateway.calls.map(toolName), ['tools/list', 'search_products', 'tools/list']);
    assert.equal((gateway.calls[1]?.params as { name?: string }).name, 'search_products');
    assert.deepEqual(gateway.effects, { orders: 0, paymentLinks: 0, holds: 0, emails: 0, subscriptions: 0, documents: 0 });
  });

  it('A09/A10/A22/A25 reject injected price, bad qty, currency, and a caller-supplied host before any call', async () => {
    const gateway = scripted(() => tools(['search_products']));
    const client = new CatalogReadClient({ transport: gateway.transport });
    const injected = await client.searchProducts({ query: 'marker', unitPrice: 1 } as never);
    const currency = await client.searchProducts({ query: 'marker', currency: 'EUR' } as never);
    const host = await client.searchProducts({ query: 'marker', endpoint: 'http://169.254.169.254/' } as never);
    const role = await client.getProduct({ productRef: 'synthetic-marker', role: 'admin' } as never);
    const badLimit = await client.searchProducts({ query: 'marker', limit: 100 });
    const qtyCases = [0, -1, 0.5, Number.NaN, 51];
    for (const qty of qtyCases) {
      const quote = await client.quoteCart({ lines: [{ variantRef: 'SYN', qty }] });
      assert.equal(quote.errors[0]?.code, 'INVALID_ARGUMENT', `qty ${String(qty)}`);
      assert.equal(quote.data, null);
    }
    const office = await client.getAvailability({ lines: [{ variantRef: 'SYN', qty: 1 }], officeId: 'private-office' });
    assert.equal(injected.errors[0]?.code, 'INVALID_ARGUMENT');
    assert.equal(currency.errors[0]?.code, 'INVALID_ARGUMENT');
    assert.equal(host.errors[0]?.code, 'INVALID_ARGUMENT');
    assert.equal(role.errors[0]?.code, 'INVALID_ARGUMENT');
    assert.equal(badLimit.errors[0]?.code, 'INVALID_ARGUMENT');
    assert.equal(office.errors[0]?.code, 'INVALID_ARGUMENT');
    assert.equal(gateway.calls.length, 0);
    assert.throws(() => assertReadEndpoint('file:///etc/passwd'), TypeError);
    assert.throws(() => assertReadEndpoint('https://user:pass@example.com/mcp'), TypeError);
    assert.throws(() => assertReadEndpoint('https://example.com/mcp?token=abc'), TypeError);
    const unresolved = await client.quoteCart({
      lines: [{ variantRef: 'SYN-A', sku: 'SYN-B', qty: 1 }],
    });
    assert.equal(unresolved.errors[0]?.code, 'ID_UNRESOLVED');
    assert.equal(gateway.calls.length, 0);
  });

  it('A14/A15/A24 a transport that would record a payment link is never asked to quote', async () => {
    let sleeps = 0;
    const gateway = scripted(request => {
      if (request.method === 'tools/list') return tools(['search_products', 'get_product', 'get_quote', 'create_checkout']);
      return tool({ payment_link: 'https://example.com/pay', total: 11800 });
    });
    const client = new CatalogReadClient({
      transport: gateway.transport,
      retry: { maxAttempts: 3, backoffMs: 5 },
      sleep: async () => {
        sleeps += 1;
      },
    });
    const quote = await client.quoteCart({ lines: [{ sku: 'SYN', qty: 2 }], currency: 'CLP', requestId: 'trace-quote' });
    assert.equal(quote.status, 'error');
    assert.equal(quote.errors[0]?.code, 'UNSUPPORTED');
    assert.match(quote.errors[0]?.message ?? '', /get_quote/);
    assert.equal(quote.data, null);
    assert.equal(gateway.calls.length, 0);
    assert.equal(sleeps, 0);
    assert.equal(gateway.effects.paymentLinks, 0);
    assert.equal(gateway.effects.orders, 0);
    assert.equal(gateway.effects.documents, 0);
  });

  it('A06/A18/A23/A27 timeout, missing source time, abort, and secret-bearing failures stay empty of invented stock', async () => {
    const observed = '2026-11-01T08:00:00.000Z';
    const gateway = scripted(request => {
      if (request.method === 'tools/list') return tools(['search_products', 'get_product']);
      if (toolName(request) === 'get_product') {
        return tool({
          slug: 'synthetic-marker',
          name: 'Synthetic Marker',
          price: 5900,
          currency: 'CLP',
          availability: 'in_stock',
          sourceUpdatedAt: observed,
          customer_email: 'person@example.com',
          payment_link: 'https://example.com/should-not-pass',
        });
      }
      return tool({ query: 'marker', total: 0, results: [], note: 'search backend unavailable: timeout' });
    });
    const client = new CatalogReadClient({
      transport: gateway.transport,
      now: () => new Date('2026-11-07T15:00:00.000Z'),
    });
    const failed = await client.searchProducts({ query: 'marker' });
    assert.equal(failed.status, 'error');
    assert.equal(failed.errors[0]?.code, 'UPSTREAM_UNAVAILABLE');
    assert.equal(failed.data, null);
    assert.equal(JSON.stringify(failed).includes('"items":[]'), false);

    const detail = await client.getProduct({ productRef: 'synthetic-marker' });
    assert.equal(detail.status, 'ok');
    assert.equal(detail.data?.referencePrice?.amount, 5900);
    assert.equal(detail.data?.referencePrice?.currency, 'CLP');
    assert.equal(detail.data?.referencePrice?.exponent, null);
    assert.equal(detail.data?.catalogAvailability, 'in_stock');
    assert.equal(detail.data?.inventory.status, 'unknown');
    assert.equal(detail.data?.inventory.units, null);
    assert.equal(detail.components.catalog.sourceUpdatedAt, observed);
    assert.equal(detail.components.price.sourceUpdatedAt, null);
    assert.equal(detail.components.inventory.sourceUpdatedAt, null);
    assert.equal(detail.components.price.freshness, 'unknown');
    assert.equal(detail.components.inventory.freshness, 'unknown');
    assert.notEqual(detail.observation.fetchedAt, observed);
    assert.equal(detail.observation.sourceUpdatedAt, observed);
    const leaked = keysDeep(detail);
    assert.equal(leaked.has('customer_email'), false);
    assert.equal(leaked.has('payment_link'), false);
    assert.equal(leaked.has('ready'), false);

    const ac = new AbortController();
    ac.abort();
    const cancelled = await client.searchProducts({ query: 'marker', signal: ac.signal });
    assert.equal(cancelled.errors[0]?.code, 'CANCELLED_LOCAL');

    const forbidden = scripted(() => ({
      status: 403,
      body: { token: 'super-secret-token', html: '<script>Bearer super-secret-token</script>' },
      retryAfterMs: null,
    }));
    const blocked = new CatalogReadClient({
      transport: forbidden.transport,
      retry: { maxAttempts: 3, backoffMs: 1 },
      sleep: async () => undefined,
    });
    const denied = await blocked.searchProducts({ query: 'marker' });
    assert.equal(denied.errors[0]?.code, 'FORBIDDEN');
    assert.equal(JSON.stringify(denied).includes('super-secret-token'), false);
    assert.equal(forbidden.calls.length, 1);

    const messy = scripted(() => {
      throw new Error('connect failed Bearer super-secret-token\n    at Client.fetch (/home/ubuntu/private/secret.ts:10:1)');
    });
    const redacted = await new CatalogReadClient({ transport: messy.transport }).searchProducts({ query: 'marker' });
    assert.equal(redacted.errors[0]?.code, 'CAPABILITY_UNKNOWN');
    const rendered = JSON.stringify(redacted);
    assert.equal(rendered.includes('super-secret-token'), false);
    assert.equal(rendered.includes('/home/ubuntu'), false);
    assert.equal(rendered.includes('secret.ts'), false);
  });

  it('A17/A19/A20 cache hits keep the original observation and do not cross scopes', async () => {
    let nowMs = Date.parse('2026-11-06T12:00:00.000Z');
    const sourceUpdatedAt = '2026-11-01T00:00:00.000Z';
    const seen: string[] = [];
    const gateway = scripted(request => {
      if (request.method === 'tools/list') return tools(['search_products', 'get_product']);
      const args = (request.params as { arguments?: { query?: string } }).arguments;
      seen.push(String(args?.query));
      const slug = args?.query === 'scope-b' ? 'synthetic-b' : 'synthetic-a';
      return tool({
        query: args?.query,
        total: 1,
        observedAt: '2026-11-05T00:00:00.000Z',
        sourceUpdatedAt,
        results: [{ slug, name: slug, brand: null, price: 5900, currency: 'CLP' }],
      });
    });
    const client = new CatalogReadClient({
      transport: gateway.transport,
      now: () => new Date(nowMs),
      staleAfterMs: 60_000,
    });
    const first = await client.searchProducts({ query: 'scope-a', cacheScope: 'tenant-a' });
    nowMs = Date.parse('2026-11-07T12:00:00.000Z');
    const second = await client.searchProducts({ query: 'scope-a', cacheScope: 'tenant-a' });
    assert.equal(second.status, 'partial');
    assert.equal(second.observation.fetchedAt, first.observation.fetchedAt);
    assert.equal(second.observation.upstreamObservedAt, '2026-11-05T00:00:00.000Z');
    assert.equal(second.observation.sourceUpdatedAt, sourceUpdatedAt);
    assert.equal(second.observation.cacheFreshness, 'stale');
    assert.equal(second.components.catalog.freshness, 'unknown');
    assert.equal(second.components.price.freshness, 'unknown');
    assert.equal(second.components.inventory.freshness, 'unknown');
    assert.equal(second.components.price.binding, false);
    assert.notEqual(second.components.price, second.components.inventory);
    assert.equal(seen.length, 1);

    const other = await client.searchProducts({ query: 'scope-b', cacheScope: 'tenant-b' });
    assert.equal(other.data?.items[0]?.productRef, 'synthetic-b');
    assert.equal(other.provenance.sourceKind, 'mcp');
    const again = await client.searchProducts({ query: 'scope-a', cacheScope: 'tenant-a' });
    assert.equal(again.data?.items[0]?.productRef, 'synthetic-a');
    assert.equal(seen.length, 2);

    const rejected = await client.searchProducts({ query: 'scope-a', cacheScope: 'tenant-a', rejectStale: true });
    assert.equal(rejected.errors[0]?.code, 'STALE_DATA');
    assert.equal(rejected.data, null);
    assert.equal(rejected.observation.fetchedAt, first.observation.fetchedAt);
    assert.equal(seen.length, 2);
  });

  it('A08 variant projection keeps a coarse flag and drops exact units', async () => {
    const gateway = scripted(request => {
      if (request.method === 'tools/list') {
        return tools(['search_products', 'get_product', 'list_variant_charts', 'get_variant_chart']);
      }
      assert.equal((request.params as { arguments?: { chart?: string } }).arguments?.chart, 'synthetic-chart');
      return tool({
        slug: 'synthetic-chart',
        axis: 'color',
        stock_verified: true,
        base_price: 4.5,
        variants: [
          { code: 'A', name: 'Red', sku: 'SYN-A', stock: 4242, available: true, swatch_hex: '#ff0000' },
          { code: 'B', name: 'Gone', sku: 'SYN-B', stock: 0, available: false },
          { code: 'C', name: 'Unmapped', sku: null, stock: null, available: null },
          { code: 'D', name: 'Lie', sku: 'SYN-D', stock: 7, available: true },
        ],
      });
    });
    const client = new CatalogReadClient({ transport: gateway.transport });
    const missing = await client.getVariants({ productRef: 'synthetic-product' });
    assert.equal(missing.errors[0]?.code, 'ID_UNRESOLVED');
    assert.equal(gateway.calls.length, 0);

    const chart = await client.getVariants({ chartRef: 'synthetic-chart' });
    assert.equal(chart.status, 'partial');
    assert.equal(chart.data?.variants[0]?.availability.status, 'available');
    assert.equal(chart.data?.variants[0]?.availability.units, null);
    assert.equal(chart.data?.variants[1]?.availability.status, 'unavailable');
    assert.equal(chart.data?.variants[2]?.variantRef, null);
    assert.equal(chart.data?.variants[2]?.mappingStatus, 'unresolved');
    assert.equal(chart.data?.variants[2]?.availability.status, 'unknown');
    assert.equal(chart.components.inventory.status, 'unknown');
    const rendered = JSON.stringify(chart);
    assert.equal(rendered.includes('"stock"'), false);
    assert.equal(rendered.includes('4242'), false);
    assert.equal(numbersDeep(chart).includes(0), false);
    assert.equal(gateway.calls.filter(call => toolName(call) === 'get_quote').length, 0);

    const half = scripted(request => (request.method === 'tools/list' ? tools(['list_variant_charts', 'search_products', 'get_product']) : tool({})));
    const unsupported = await new CatalogReadClient({ transport: half.transport }).getVariants({ chartRef: 'synthetic-chart' });
    assert.equal(unsupported.errors[0]?.code, 'UNSUPPORTED');
    assert.equal(half.calls.some(call => call.method === 'tools/call'), false);
  });

  it('a failed manifest stays unknown and a contract break is not an empty catalog', async () => {
    const down = scripted(() => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    const unknown = await new CatalogReadClient({ transport: down.transport }).searchProducts({ query: 'marker' });
    assert.equal(unknown.errors[0]?.code, 'CAPABILITY_UNKNOWN');
    assert.equal(unknown.data, null);

    const broken = scripted(request => (request.method === 'tools/list' ? rpc({ tools: 'nope' }) : tool({})));
    const mismatch = await new CatalogReadClient({ transport: broken.transport }).searchProducts({ query: 'marker' });
    assert.equal(mismatch.errors[0]?.code, 'CAPABILITY_UNKNOWN');
    assert.equal(broken.calls.some(call => call.method === 'tools/call'), false);

    const badHits = scripted(request => {
      if (request.method === 'tools/list') return tools(['search_products', 'get_product']);
      return tool({ query: 'marker', total: 0, results: 'nope' });
    });
    const contract = await new CatalogReadClient({ transport: badHits.transport }).searchProducts({ query: 'marker' });
    assert.equal(contract.errors[0]?.code, 'CONTRACT_MISMATCH');
    assert.equal(contract.data, null);

    const missing = scripted(request => {
      if (request.method === 'tools/list') return tools(['search_products', 'get_product']);
      return tool({ error: 'product not found', slug: 'missing' });
    });
    const notFound = await new CatalogReadClient({ transport: missing.transport }).getProduct({ productRef: 'missing' });
    assert.equal(notFound.errors[0]?.code, 'NOT_FOUND');
    assert.equal(notFound.data, null);
  });

  it('retries a pure search and does not retry a forbidden read', async () => {
    let searches = 0;
    let sleeps = 0;
    const gateway = scripted(request => {
      if (request.method === 'tools/list') return tools(['search_products', 'get_product']);
      searches += 1;
      if (searches < 3) return { status: 503, body: null, retryAfterMs: null };
      return tool({ query: 'marker', total: 0, results: [] });
    });
    const client = new CatalogReadClient({
      transport: gateway.transport,
      retry: { maxAttempts: 3, backoffMs: 25 },
      sleep: async () => {
        sleeps += 1;
      },
      newId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });
    const found = await client.searchProducts({ query: 'marker', requestId: 'trace-retry' });
    assert.equal(found.status, 'ok');
    assert.equal(found.requestId, 'trace-retry');
    assert.equal(found.data?.items.length, 0);
    assert.equal(searches, 3);
    assert.equal(sleeps, 2);

    const forbidden = scripted(request => {
      if (request.method === 'tools/list') return tools(['search_products']);
      return { status: 403, body: { error: { message: 'Bearer super-secret-token' } }, retryAfterMs: null };
    });
    const denied = await new CatalogReadClient({
      transport: forbidden.transport,
      retry: { maxAttempts: 3, backoffMs: 1 },
      sleep: async () => {
        sleeps += 1;
      },
    }).searchProducts({ query: 'marker' });
    assert.equal(denied.errors[0]?.code, 'FORBIDDEN');
    assert.equal(forbidden.calls.filter(call => call.method === 'tools/call').length, 1);
    assert.equal(JSON.stringify(denied).includes('super-secret-token'), false);
  });

  it('http transport omits credentials and does not follow a redirect', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const transport = createHttpTransport('https://shop.example.com/api/mcp', async (url, init) => {
      const headers = init.headers as Record<string, string>;
      const body = JSON.parse(String(init.body));
      seen.push({
        url,
        method: init.method,
        credentials: init.credentials,
        redirect: init.redirect,
        cache: init.cache,
        authorization: headers.authorization ?? headers.Authorization ?? null,
        rpc: body.method,
      });
      if (body.method === 'tools/list') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'search_products' }, { name: 'get_product' }] } }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: JSON.stringify({ query: 'marker', total: 0, results: [] }) }] },
        }),
        { status: 200 },
      );
    });
    const client = new CatalogReadClient({ transport });
    const found = await client.searchProducts({ query: 'marker' });
    assert.equal(found.status, 'ok');
    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.credentials, 'omit');
    assert.equal(seen[0]?.redirect, 'manual');
    assert.equal(seen[0]?.cache, 'no-store');
    assert.equal(seen[0]?.authorization, null);
    assert.equal(seen[0]?.url, 'https://shop.example.com/api/mcp');

    let fetches = 0;
    const quoteTransport = createHttpTransport('https://shop.example.com/api/mcp', async () => {
      fetches += 1;
      throw new Error('live network');
    });
    const quote = await new CatalogReadClient({ transport: quoteTransport }).quoteCart({
      lines: [{ variantRef: 'SYN', qty: 2 }],
      currency: 'CLP',
    });
    assert.equal(fetches, 0);
    assert.equal(quote.errors[0]?.code, 'UNSUPPORTED');

    const redirected = createHttpTransport('https://shop.example.com/api/mcp', async () =>
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
    );
    const bounced = await new CatalogReadClient({ transport: redirected }).readCapabilities();
    assert.equal(bounced.errors[0]?.code, 'CAPABILITY_UNKNOWN');
    assert.match(bounced.errors[0]?.message ?? '', /redirect was not followed/);
    assert.equal(JSON.stringify(bounced).includes('169.254.169.254'), false);
  });

  it('in-process demo memory adapter: search and detail only, quote is not dispatched', async () => {
    assert.ok(
      !process.env.CATALOG_ADAPTER || process.env.CATALOG_ADAPTER === 'memory',
      'this demo path refuses a non-memory adapter',
    );
    const calls: string[] = [];
    const effects: Effects = { orders: 0, paymentLinks: 0, holds: 0, emails: 0, subscriptions: 0, documents: 0 };
    const transport: ReadTransport = {
      partitionRef: 'demo-memory',
      async send(request) {
        const name = toolName(request);
        calls.push(name);
        if (name === 'get_quote') {
          effects.paymentLinks += 1;
          effects.orders += 1;
        }
        const body = await handleRequest(
          { jsonrpc: '2.0', id: request.id, method: request.method, params: request.params },
          false,
        );
        return { status: 200, body, retryAfterMs: null };
      },
    };
    const client = new CatalogReadClient({ transport });
    const found = await client.searchProducts({ query: 'fieldbook', limit: 5 });
    assert.equal(found.status, 'ok');
    assert.ok((found.data?.items.length ?? 0) > 0);
    for (const item of found.data?.items ?? []) {
      assert.equal(item.referencePrice?.binding, false);
      assert.equal(item.referencePrice?.exponent, null);
    }

    const detail = await client.getProduct({ productRef: 'fieldbook-sketch-a5' });
    assert.equal(detail.status, 'ok');
    assert.equal(detail.data?.catalogAvailability, 'in_stock');
    assert.equal(detail.data?.inventory.status, 'unknown');
    assert.equal(detail.data?.inventory.units, null);
    assert.equal(detail.data?.referencePrice?.exponent, null);
    assert.equal(detail.observation.sourceUpdatedAt, null);

    const missing = await client.getProduct({ productRef: 'not-in-the-demo-catalog' });
    assert.equal(missing.errors[0]?.code, 'NOT_FOUND');

    const chart = await client.getVariants({ chartRef: 'chromaflow-classic' });
    assert.equal(chart.data?.chartRef, 'chromaflow-classic');
    const poppy = chart.data?.variants.find(variant => variant.variantRef === 'CF-R21');
    const leaf = chart.data?.variants.find(variant => variant.variantRef === 'CF-G09');
    assert.equal(poppy?.availability.status, 'unavailable');
    assert.equal(poppy?.availability.units, null);
    assert.equal(leaf?.availability.status, 'unknown');
    assert.equal(numbersDeep(chart).includes(14), false);
    assert.equal(keysDeep(chart).has('stock'), false);

    const quote = await client.quoteCart({ lines: [{ sku: 'CF-W00', qty: 2 }], currency: 'CLP' });
    assert.equal(quote.errors[0]?.code, 'UNSUPPORTED');
    assert.equal(calls.includes('get_quote'), false);
    assert.equal(calls.includes('create_checkout'), false);
    assert.equal(effects.paymentLinks, 0);
    assert.equal(effects.orders, 0);
    assert.ok(calls.includes('search_products'));
    assert.ok(calls.includes('get_product'));
    assert.ok(calls.includes('get_variant_chart'));
  });

  it('shared cache does not cross stores, tenants, or adapter versions', async () => {
    const cache = new MemoryReadCache();
    const searchOf = (slug: string) =>
      tool({
        query: 'marker',
        total: 1,
        results: [{ slug, name: slug, brand: null, price: 5900, currency: 'CLP' }],
      });
    const shop = (partitionRef: string, slug: string) => {
      const gateway = scripted(request => {
        if (request.method === 'tools/list') return tools(['search_products', 'get_product']);
        return searchOf(slug);
      }, partitionRef);
      const client = new CatalogReadClient({ transport: gateway.transport, cache });
      return { gateway, client };
    };

    const a = shop('store-a', 'from-a');
    const b = shop('store-b', 'from-b');
    const foundA = await a.client.searchProducts({ query: 'marker', cacheScope: 'public' });
    const foundB = await b.client.searchProducts({ query: 'marker', cacheScope: 'public' });
    assert.equal(foundA.data?.items[0]?.productRef, 'from-a');
    assert.equal(foundB.data?.items[0]?.productRef, 'from-b');
    assert.equal(foundA.provenance.partitionRef, 'store-a');
    assert.equal(foundB.provenance.partitionRef, 'store-b');
    assert.equal(foundA.provenance.authScope, READ_AUTH_SCOPE);
    assert.match(foundA.provenance.sourceRef, /^tool:search_products#store-a$/);
    assert.equal(foundA.provenance.sourceRef.includes('shop-a'), false);
    assert.deepEqual(
      b.gateway.calls.map(toolName),
      ['tools/list', 'search_products'],
    );
    const quote = await b.client.quoteCart({ lines: [{ variantRef: 'SYN', qty: 1 }], currency: 'CLP' });
    assert.equal(quote.errors[0]?.code, 'UNSUPPORTED');
    assert.equal(b.gateway.calls.some(call => toolName(call) === 'get_quote'), false);
    assert.equal(JSON.stringify(foundB).includes('bearer'), false);

    let version = '1.0.0';
    let slug = 'version-1';
    const versioned = scripted(request => {
      if (request.method === 'tools/list') {
        return rpc({
          tools: [{ name: 'search_products', description: SYNTHETIC, inputSchema: { type: 'object' } }],
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture', version } },
        });
      }
      return searchOf(slug);
    }, 'store-versioned');
    const first = new CatalogReadClient({ transport: versioned.transport, cache });
    const second = new CatalogReadClient({ transport: versioned.transport, cache });
    assert.equal((await first.searchProducts({ query: 'marker', cacheScope: 'public' })).data?.items[0]?.productRef, 'version-1');
    version = '2.0.0';
    slug = 'version-2';
    const next = await second.searchProducts({ query: 'marker', cacheScope: 'public' });
    assert.equal(next.data?.items[0]?.productRef, 'version-2');
    assert.equal(next.provenance.adapterVersion, '2.0.0');
    assert.equal(versioned.calls.filter(call => toolName(call) === 'search_products').length, 2);
  });

  it('http partitions by canonical endpoint and public tenant label, not by a bearer or cacheScope', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: string; method: string };
      calls.push(`${url} ${body.method}`);
      const slug = url.includes('/shops/a') ? 'path-a' : 'path-b';
      const result =
        body.method === 'tools/list'
          ? { tools: [{ name: 'search_products' }, { name: 'get_product' }] }
          : { content: [{ type: 'text', text: JSON.stringify({ query: 'marker', total: 1, results: [{ slug, name: slug, brand: null, price: 5900 }] }) }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
    };
    const cache = new MemoryReadCache();
    const left = createHttpTransport('https://Shop.Example:443/shops/a/', fetchImpl);
    const right = createHttpTransport('https://shop.example/shops/b', fetchImpl);
    assert.notEqual(left.partitionRef, right.partitionRef);
    assert.equal(left.partitionRef.includes('shop.example'), false);
    assert.equal(left.partitionRef.startsWith('ep_'), true);
    const clientA = new CatalogReadClient({ transport: left, cache });
    const clientB = new CatalogReadClient({ transport: right, cache });
    const docA = await clientA.searchProducts({ query: 'marker', cacheScope: 'public' });
    const docB = await clientB.searchProducts({ query: 'marker', cacheScope: 'public' });
    assert.equal(docA.data?.items[0]?.productRef, 'path-a');
    assert.equal(docB.data?.items[0]?.productRef, 'path-b');
    assert.equal(JSON.stringify(docA).includes('shop.example'), false);
    assert.equal(JSON.stringify(docA).includes('Shop.Example'), false);
    assert.equal(calls.filter(call => call.endsWith('tools/call')).length, 2);

    const sameA = createHttpTransport('https://Shop.Example:443/api/mcp/', fetchImpl);
    const sameB = createHttpTransport('https://shop.example/api/mcp?b=1&a=2', fetchImpl);
    const sameC = createHttpTransport('https://shop.example/api/mcp?a=2&b=1', fetchImpl);
    assert.equal(sameB.partitionRef, sameC.partitionRef);
    assert.notEqual(sameA.partitionRef, sameB.partitionRef);

    const privateHost = createHttpTransport('http://10.1.2.3/internal/mcp', fetchImpl);
    assert.equal(privateHost.partitionRef.includes('10.1.2.3'), false);
    assert.equal(privateHost.partitionRef.includes('internal'), false);
    assert.throws(() => createHttpTransport('https://shop.example/api/mcp', fetchImpl, { partitionRef: 'Bearer-super-secret-token' }), TypeError);
    assert.throws(() => assertPartitionRef('10.4.4.4'), TypeError);
    let thrown = '';
    try {
      assertPartitionRef('Bearer-super-secret-token');
    } catch (error) {
      thrown = error instanceof Error ? error.message : '';
    }
    assert.equal(thrown.includes('super-secret-token'), false);

    let n = 0;
    const tenantFetch = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: string; method: string };
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.authorization ?? headers.Authorization, undefined);
      const slug = body.method === 'tools/call' ? `tenant-${++n}` : 'unused';
      const result =
        body.method === 'tools/list'
          ? { tools: [{ name: 'search_products' }] }
          : { content: [{ type: 'text', text: JSON.stringify({ query: 'marker', total: 1, results: [{ slug, name: slug, brand: null, price: 1 }] }) }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
    };
    const sharedUrl = 'https://shop.example/api/mcp';
    const tenantCache = new MemoryReadCache();
    const tenantA = new CatalogReadClient({
      transport: createHttpTransport(sharedUrl, tenantFetch, { partitionRef: 'tenant-a' }),
      cache: tenantCache,
    });
    const tenantB = new CatalogReadClient({
      transport: createHttpTransport(sharedUrl, tenantFetch, { partitionRef: 'tenant-b' }),
      cache: tenantCache,
    });
    const ta = await tenantA.searchProducts({ query: 'marker', cacheScope: 'public' });
    const tb = await tenantB.searchProducts({ query: 'marker', cacheScope: 'public' });
    assert.equal(ta.data?.items[0]?.productRef, 'tenant-1');
    assert.equal(tb.data?.items[0]?.productRef, 'tenant-2');
    assert.equal(ta.provenance.authScope, 'anonymous');
    assert.notEqual(ta.provenance.partitionRef, tb.provenance.partitionRef);
    assert.equal(JSON.stringify(ta).includes(sharedUrl), false);

    const anonCache = new MemoryReadCache();
    let anonSearches = 0;
    const anonFetch = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: string; method: string };
      if (body.method === 'tools/call') anonSearches += 1;
      const result =
        body.method === 'tools/list'
          ? { tools: [{ name: 'search_products' }] }
          : {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    query: 'marker',
                    total: 1,
                    results: [{ slug: 'anon-product', name: 'Anon', brand: null, price: 1 }],
                  }),
                },
              ],
            };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
    };
    const anonA = new CatalogReadClient({ transport: createHttpTransport(sharedUrl, anonFetch), cache: anonCache });
    const anonB = new CatalogReadClient({ transport: createHttpTransport(sharedUrl, anonFetch), cache: anonCache });
    assert.equal((await anonA.searchProducts({ query: 'marker', cacheScope: 'public' })).data?.items[0]?.productRef, 'anon-product');
    const anonHit = await anonB.searchProducts({ query: 'marker', cacheScope: 'public' });
    assert.equal(anonHit.data?.items[0]?.productRef, 'anon-product');
    assert.equal(anonHit.provenance.sourceKind, 'client-cache');
    assert.equal(anonSearches, 1);
  });

  it('discards a mismatched JSON-RPC id and aborts during retry sleep', async () => {
    const mismatch: ReadTransport = {
      partitionRef: 'mismatch',
      async send() {
        return { status: 200, body: { jsonrpc: '2.0', id: 'someone-else', result: { tools: [{ name: 'search_products' }] } }, retryAfterMs: null };
      },
    };
    const mismatched = await new CatalogReadClient({ transport: mismatch }).searchProducts({ query: 'marker' });
    assert.equal(mismatched.errors[0]?.code, 'CONTRACT_MISMATCH');
    assert.match(mismatched.errors[0]?.message ?? '', /response id/);
    assert.equal(mismatched.data, null);
    assert.equal(JSON.stringify(mismatched).includes('someone-else'), false);

    const ac = new AbortController();
    let searches = 0;
    let enteredSleep: () => void = () => undefined;
    const entered = new Promise<void>(resolve => {
      enteredSleep = resolve;
    });
    const gateway = scripted(request => {
      if (request.method === 'tools/list') return tools(['search_products', 'get_product']);
      searches += 1;
      return { status: 503, body: null, retryAfterMs: null };
    }, 'retry-abort');
    const client = new CatalogReadClient({
      transport: gateway.transport,
      retry: { maxAttempts: 3, backoffMs: 1000 },
      sleep: () => {
        enteredSleep();
        return new Promise(() => undefined);
      },
    });
    const pending = client.searchProducts({ query: 'marker', signal: ac.signal });
    await entered;
    ac.abort();
    const cancelled = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('abort did not interrupt retry sleep')), 500)),
    ]);
    assert.equal(cancelled.errors[0]?.code, 'CANCELLED_LOCAL');
    assert.equal(searches, 1);
    assert.equal(gateway.calls.filter(call => toolName(call) === 'get_quote').length, 0);
  });

  it('an aged cache hit without a freshness policy is partial, and the map is bounded', async () => {
    let nowMs = Date.parse('2026-11-01T00:00:00.000Z');
    const gateway = scripted(request => {
      if (request.method === 'tools/list') return tools(['search_products', 'get_product']);
      const query = String((request.params as { arguments?: { query?: string } }).arguments?.query);
      return tool({ query, total: 1, results: [{ slug: query, name: query, brand: null, price: 1 }] });
    }, 'aged');
    const client = new CatalogReadClient({
      transport: gateway.transport,
      now: () => new Date(nowMs),
      maxCacheEntries: 1,
    });
    const first = await client.searchProducts({ query: 'one' });
    nowMs += 10 * 24 * 60 * 60 * 1000;
    const second = await client.searchProducts({ query: 'one' });
    assert.equal(second.status, 'partial');
    assert.equal(second.observation.cacheFreshness, 'unknown');
    assert.equal(second.observation.fetchedAt, first.observation.fetchedAt);
    assert.equal(second.warnings.some(warning => warning.code === 'CACHE_AGE_UNCERTIFIED'), true);
    assert.equal(gateway.calls.filter(call => toolName(call) === 'search_products').length, 1);

    const bounded = new MemoryReadCache(1);
    const record = {
      storedAtMs: 1,
      fetchedAt: '2026-11-01T00:00:00.000Z',
      upstreamObservedAt: null,
      sourceUpdatedAt: null,
      adapterVersion: null,
      sourceRef: 'tool:search_products#aged',
      partitionRef: 'aged',
      authScope: READ_AUTH_SCOPE,
      data: { query: 'x', items: [], reportedCount: 0, nextCursor: null },
      components: first.components,
      warnings: [],
      partial: false,
    } satisfies CacheRecord;
    bounded.set('a', record);
    bounded.set('b', { ...record, sourceRef: 'tool:search_products#other' });
    assert.equal(bounded.get('a'), undefined);
    assert.equal(bounded.get('b')?.partitionRef, 'aged');
  });

  it('the client sources do not touch browser storage, cookies, or server secrets', () => {
    const dir = path.resolve('src/sdk/catalog-read');
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.ts'));
    assert.ok(files.length > 0);
    for (const name of files) {
      const source = fs
        .readFileSync(path.join(dir, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      assert.equal(/\blocalStorage\b/.test(source), false, name);
      assert.equal(/\bsessionStorage\b/.test(source), false, name);
      assert.equal(source.includes('document.cookie'), false, name);
      assert.equal(source.includes('MCP_SECRET'), false, name);
      assert.equal(/from ['"][^'"]*\/lib\//.test(source), false, name);
    }
  });
});
