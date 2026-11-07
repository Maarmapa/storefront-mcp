// Projection from an MCP tool payload into the read-profile document.
//
// Unknown fields are dropped (customer mail, payment links, exact stock).
// Dropping them here is hygiene for callers of this client. It is not the
// security boundary: a direct tools/call still receives whatever the server sends.

import { redactPublicMessage } from './redact';
import type { ProductData, ReferencePrice, SearchData, VariantView, VariantsData } from './types';

export interface ProjectedOk<T> {
  ok: true;
  partial: boolean;
  data: T;
  warnings: Array<{ code: string; message: string }>;
  upstreamObservedAt: string | null;
  sourceUpdatedAt: string | null;
}

export interface ProjectedErr {
  ok: false;
  code: 'NOT_FOUND' | 'CONTRACT_MISMATCH' | 'UPSTREAM_UNAVAILABLE';
  message: string;
}

const FAILURE_NOTE = /unavailable|timed out|timeout|did not answer|backend|failed|error/i;

export function readIso(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function timestampsOf(payload: Record<string, unknown>): { upstreamObservedAt: string | null; sourceUpdatedAt: string | null } {
  return {
    upstreamObservedAt: readIso(payload.observedAt ?? payload.upstreamObservedAt),
    sourceUpdatedAt: readIso(payload.sourceUpdatedAt),
  };
}

function referencePrice(amount: unknown, currency: unknown): ReferencePrice | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const code = typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null;
  return { amount, currency: code, exponent: null, unit: 'major-as-provided', binding: false };
}

function publicUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function projectSearch(payload: unknown, requestedQuery: string): ProjectedOk<SearchData> | ProjectedErr {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: 'CONTRACT_MISMATCH', message: 'search_products did not return an object. No empty catalog was substituted.' };
  }
  const body = payload as Record<string, unknown>;
  const stamps = timestampsOf(body);
  const note = typeof body.note === 'string' ? body.note : '';
  const results = body.results;
  if (!Array.isArray(results)) {
    return { ok: false, code: 'CONTRACT_MISMATCH', message: 'search_products did not return a results array. No empty catalog was substituted.' };
  }
  if (results.length === 0 && note && FAILURE_NOTE.test(note)) {
    return {
      ok: false,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'The catalog search reported that its backend was unavailable. An empty list was not treated as zero products.',
    };
  }
  const items: SearchData['items'] = [];
  for (const row of results) {
    if (!row || typeof row !== 'object') {
      return { ok: false, code: 'CONTRACT_MISMATCH', message: 'A search hit was not an object.' };
    }
    const hit = row as Record<string, unknown>;
    if (typeof hit.slug !== 'string' || hit.slug.length < 1 || typeof hit.name !== 'string') {
      return { ok: false, code: 'CONTRACT_MISMATCH', message: 'A search hit was missing slug or name.' };
    }
    items.push({
      productRef: hit.slug,
      name: hit.name,
      brand: typeof hit.brand === 'string' ? hit.brand : null,
      referencePrice: referencePrice(hit.price, hit.currency),
    });
  }
  const reportedCount =
    typeof body.total === 'number' && Number.isInteger(body.total) && body.total >= 0 ? body.total : null;
  const warnings = [];
  if (items.some(item => item.referencePrice)) {
    warnings.push({
      code: 'NON_BINDING_PRICE',
      message: 'Prices on search hits are catalog references in the unit the server sent. They are not a quote.',
    });
  }
  if (note) {
      warnings.push({ code: 'UPSTREAM_NOTE', message: redactPublicMessage(note, 'The server attached a note.') });
  }
  return {
    ok: true,
    partial: note.length > 0,
    data: { query: requestedQuery, items, reportedCount, nextCursor: null },
    warnings,
    ...stamps,
  };
}

export function projectProduct(payload: unknown): ProjectedOk<ProductData> | ProjectedErr {
  if (payload == null) {
    return { ok: false, code: 'NOT_FOUND', message: 'Product not found.' };
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: 'CONTRACT_MISMATCH', message: 'get_product did not return an object.' };
  }
  const body = payload as Record<string, unknown>;
  if (typeof body.error === 'string') {
    if (/not found/i.test(body.error)) return { ok: false, code: 'NOT_FOUND', message: 'Product not found.' };
    return { ok: false, code: 'UPSTREAM_UNAVAILABLE', message: 'get_product failed.' };
  }
  if (typeof body.slug !== 'string' || typeof body.name !== 'string') {
    return { ok: false, code: 'CONTRACT_MISMATCH', message: 'get_product was missing slug or name.' };
  }
  const catalogAvailability =
    body.availability === 'in_stock' || body.availability === 'out_of_stock' || body.availability === 'unknown'
      ? body.availability
      : 'unknown';
  const reference = referencePrice(body.price, body.currency);
  const warnings = [
    {
      code: 'CATALOG_NOT_INVENTORY',
      message: 'catalogAvailability answers whether the product is published as purchasable. It is not a verified unit count.',
    },
  ];
  if (reference) {
    warnings.push({
      code: 'NON_BINDING_PRICE',
      message: 'referencePrice is the catalog display amount as sent, not an offer for a quantity or channel.',
    });
  }
  return {
    ok: true,
    partial: false,
    data: {
      productRef: body.slug,
      name: body.name,
      brand: typeof body.brand === 'string' ? body.brand : null,
      category: typeof body.category === 'string' ? body.category : null,
      description: typeof body.description === 'string' ? body.description : null,
      url: publicUrl(body.url),
      referencePrice: reference,
      catalogAvailability,
      inventory: { status: 'unknown', units: null, reason: 'not-a-verified-inventory-read' },
    },
    warnings,
    ...timestampsOf(body),
  };
}

function coarseAvailability(stockVerified: unknown, available: unknown): VariantView['availability'] {
  if (stockVerified !== true || (available !== true && available !== false)) {
    return { status: 'unknown', units: null, source: 'not-verified' };
  }
  return {
    status: available ? 'available' : 'unavailable',
    units: null,
    source: 'variant-chart-coarse-flag',
  };
}

export function projectVariantChart(payload: unknown, requestedChart: string): ProjectedOk<VariantsData> | ProjectedErr {
  if (payload == null) return { ok: false, code: 'NOT_FOUND', message: 'Variant chart not found.' };
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: 'CONTRACT_MISMATCH', message: 'get_variant_chart did not return an object.' };
  }
  const body = payload as Record<string, unknown>;
  if (typeof body.error === 'string') {
    if (/not found/i.test(body.error)) return { ok: false, code: 'NOT_FOUND', message: 'Variant chart not found.' };
    return { ok: false, code: 'UPSTREAM_UNAVAILABLE', message: 'get_variant_chart failed.' };
  }
  if (!Array.isArray(body.variants)) {
    return { ok: false, code: 'CONTRACT_MISMATCH', message: 'get_variant_chart did not return variants.' };
  }
  const axis = typeof body.axis === 'string' ? body.axis : null;
  const variants: VariantView[] = [];
  for (const row of body.variants) {
    if (!row || typeof row !== 'object') {
      return { ok: false, code: 'CONTRACT_MISMATCH', message: 'A variant was not an object.' };
    }
    const variant = row as Record<string, unknown>;
    if (typeof variant.code !== 'string' || typeof variant.name !== 'string') {
      return { ok: false, code: 'CONTRACT_MISMATCH', message: 'A variant was missing code or name.' };
    }
    const sku = typeof variant.sku === 'string' && variant.sku.length > 0 ? variant.sku : null;
    variants.push({
      variantRef: sku,
      mappingStatus: sku ? 'server-sku' : 'unresolved',
      attributes: {
        code: variant.code,
        name: variant.name,
        axis,
        swatchHex: typeof variant.swatch_hex === 'string' ? variant.swatch_hex : null,
      },
      availability: coarseAvailability(body.stock_verified, variant.available),
    });
  }
  return {
    ok: true,
    partial: variants.some(v => v.mappingStatus === 'unresolved' || v.availability.status === 'unknown'),
    data: {
      chartRef: typeof body.slug === 'string' ? body.slug : requestedChart,
      axis,
      variants,
    },
    warnings: [
      {
        code: 'COARSE_AVAILABILITY_ONLY',
        message: 'Variant availability is the chart flag when stock_verified is true. Exact units are omitted and were not replaced with zero.',
      },
    ],
    ...timestampsOf(body),
  };
}
