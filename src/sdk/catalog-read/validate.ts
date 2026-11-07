import {
  DEFAULT_SEARCH_LIMIT,
  MAX_LINE_QTY,
  MAX_QUERY_LENGTH,
  MAX_QUOTE_LINES,
  MAX_REF_LENGTH,
  MAX_SEARCH_LIMIT,
} from './policy';
import type { QuantityLine } from './types';

export interface FieldError {
  field: string;
  message: string;
  itemIndex?: number;
  code?: 'INVALID_ARGUMENT' | 'ID_UNRESOLVED';
}

export interface CommonCall {
  cacheScope: string;
  signal?: AbortSignal;
  rejectStale: boolean;
  requestId: string | null;
  refresh: boolean;
}

const CONTROL_KEYS = new Set(['cacheScope', 'signal', 'rejectStale', 'requestId', 'refresh']);

function shown(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : String(value);
  if (typeof value === 'string') return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  if (value === null) return 'null';
  return typeof value;
}

function rejectUnknown(record: Record<string, unknown>, allowed: Set<string>): FieldError | null {
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) continue;
    return {
      field: key,
      message: `Field "${key}" is not accepted on this operation and was not dropped silently.`,
    };
  }
  return null;
}

function parseControl(record: Record<string, unknown>): { ok: true; value: CommonCall } | { ok: false; error: FieldError } {
  if ('cacheScope' in record && record.cacheScope !== undefined) {
    const scope = record.cacheScope;
    if (typeof scope !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(scope)) {
      return { ok: false, error: { field: 'cacheScope', message: 'cacheScope must be 1–64 characters from [A-Za-z0-9._:-]. It only partitions the local cache; it is not sent and it is not an authorization.' } };
    }
  }
  if ('requestId' in record && record.requestId !== undefined) {
    const id = record.requestId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(id)) {
      return { ok: false, error: { field: 'requestId', message: 'requestId must be 1–80 characters from [A-Za-z0-9._:-]. It is a correlation id, not a session.' } };
    }
  }
  if ('signal' in record && record.signal !== undefined) {
    const signal = record.signal;
    if (!signal || typeof signal !== 'object' || typeof (signal as AbortSignal).aborted !== 'boolean') {
      return { ok: false, error: { field: 'signal', message: 'signal must be an AbortSignal.' } };
    }
  }
  if ('rejectStale' in record && record.rejectStale !== undefined && typeof record.rejectStale !== 'boolean') {
    return { ok: false, error: { field: 'rejectStale', message: 'rejectStale must be a boolean.' } };
  }
  if ('refresh' in record && record.refresh !== undefined && typeof record.refresh !== 'boolean') {
    return { ok: false, error: { field: 'refresh', message: 'refresh must be a boolean.' } };
  }
  const cacheScope = typeof record.cacheScope === 'string' ? record.cacheScope : 'public';
  const requestId = typeof record.requestId === 'string' ? record.requestId : null;
  return {
    ok: true,
    value: {
      cacheScope,
      signal: record.signal as AbortSignal | undefined,
      rejectStale: record.rejectStale === true,
      requestId,
      refresh: record.refresh === true,
    },
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === 'object' && !Array.isArray(input);
}

function parseRef(value: unknown, field: string): FieldError | string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_REF_LENGTH) {
    return { field, message: `${field} must be a string of 1–${MAX_REF_LENGTH} characters.` };
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return { field, message: `${field} contains control characters.` };
  }
  return value;
}

export function parseQty(value: unknown, itemIndex?: number): { ok: true; qty: number } | { ok: false; error: FieldError } {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LINE_QTY) {
    return {
      ok: false,
      error: {
        field: 'qty',
        itemIndex,
        message: `qty must be an integer from 1 to ${MAX_LINE_QTY}; received ${shown(value)}. It was not clamped, rounded, or replaced with 1.`,
      },
    };
  }
  return { ok: true, qty: value };
}

function lineIdentity(line: Record<string, unknown>, index: number): FieldError | { variantRef?: string; sku?: string; productRef?: string } {
  const refs: { variantRef?: string; sku?: string; productRef?: string } = {};
  for (const field of ['variantRef', 'sku', 'productRef'] as const) {
    if (!(field in line) || line[field] === undefined) continue;
    const parsed = parseRef(line[field], field);
    if (typeof parsed !== 'string') return { ...parsed, itemIndex: index };
    refs[field] = parsed;
  }
  const present = [refs.variantRef, refs.sku, refs.productRef].filter(Boolean);
  if (present.length === 0) {
    return { field: 'lines', itemIndex: index, message: 'Each line needs variantRef, sku, or productRef. None was invented.' };
  }
  if (present.length > 1 && new Set(present).size > 1) {
    return {
      field: 'lines',
      itemIndex: index,
      code: 'ID_UNRESOLVED',
      message: 'A line named more than one distinct ref. This client does not decide which spelling wins and does not merge pools.',
    };
  }
  return refs;
}

function parseLines(lines: unknown): { ok: true; lines: QuantityLine[] } | { ok: false; error: FieldError } {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > MAX_QUOTE_LINES) {
    return { ok: false, error: { field: 'lines', message: `lines must be an array of 1–${MAX_QUOTE_LINES} entries.` } };
  }
  const parsed: QuantityLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isRecord(line)) {
      return { ok: false, error: { field: 'lines', itemIndex: i, message: 'Each line must be an object.' } };
    }
    for (const key of Object.keys(line)) {
      if (key === 'variantRef' || key === 'sku' || key === 'productRef' || key === 'qty') continue;
      return {
        ok: false,
        error: {
          field: key,
          itemIndex: i,
          message: `Line field "${key}" is not accepted and was not dropped silently.`,
        },
      };
    }
    const ident = lineIdentity(line, i);
    if ('message' in ident && 'field' in ident) return { ok: false, error: ident };
    const qty = parseQty(line.qty, i);
    if (!qty.ok) return qty;
    parsed.push({ ...ident, qty: qty.qty });
  }
  return { ok: true, lines: parsed };
}

function parseCurrency(value: unknown): FieldError | string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value)) {
    return { field: 'currency', message: 'currency must be a 3-letter code. No exchange rate was applied.' };
  }
  return value.toUpperCase();
}

export function parseSearchInput(input: unknown): { ok: true; value: CommonCall & { query: string; limit: number } } | { ok: false; error: FieldError } {
  if (!isRecord(input)) return { ok: false, error: { field: 'query', message: 'searchProducts expects an object.' } };
  const allowed = new Set(['query', 'limit', ...CONTROL_KEYS]);
  const unknown = rejectUnknown(input, allowed);
  if (unknown) return { ok: false, error: unknown };
  const control = parseControl(input);
  if (!control.ok) return control;
  if (typeof input.query !== 'string' || input.query.length < 1 || input.query.length > MAX_QUERY_LENGTH) {
    return { ok: false, error: { field: 'query', message: `query must be a string of 1–${MAX_QUERY_LENGTH} characters.` } };
  }
  if (/[\u0000-\u001f\u007f]/.test(input.query) || input.query.trim().length === 0) {
    return { ok: false, error: { field: 'query', message: 'query is empty or contains control characters.' } };
  }
  let limit = DEFAULT_SEARCH_LIMIT;
  if ('limit' in input && input.limit !== undefined) {
    if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_SEARCH_LIMIT) {
      return { ok: false, error: { field: 'limit', message: `limit must be an integer from 1 to ${MAX_SEARCH_LIMIT}. It was not clamped.` } };
    }
    limit = input.limit;
  }
  return { ok: true, value: { ...control.value, query: input.query, limit } };
}

export function parseProductInput(input: unknown): { ok: true; value: CommonCall & { productRef: string } } | { ok: false; error: FieldError } {
  if (!isRecord(input)) return { ok: false, error: { field: 'productRef', message: 'getProduct expects an object.' } };
  const unknown = rejectUnknown(input, new Set(['productRef', ...CONTROL_KEYS]));
  if (unknown) return { ok: false, error: unknown };
  const control = parseControl(input);
  if (!control.ok) return control;
  const productRef = parseRef(input.productRef, 'productRef');
  if (typeof productRef !== 'string') return { ok: false, error: productRef };
  return { ok: true, value: { ...control.value, productRef } };
}

export function parseVariantsInput(input: unknown): { ok: true; value: CommonCall & { chartRef: string } } | { ok: false; error: FieldError } {
  if (!isRecord(input)) return { ok: false, error: { field: 'chartRef', message: 'getVariants expects an object.' } };
  if ('productRef' in input && input.productRef !== undefined) {
    return {
      ok: false,
      error: {
        field: 'productRef',
        code: 'ID_UNRESOLVED',
        message: 'productRef is not a chart ref. This client does not translate a product into a brand or a variant chart.',
      },
    };
  }
  if ('cursor' in input && input.cursor !== undefined) {
    return { ok: false, error: { field: 'cursor', message: 'A cursor was sent. This client does not page variant charts and does not accept a rewritten cursor.' } };
  }
  const unknown = rejectUnknown(input, new Set(['chartRef', ...CONTROL_KEYS]));
  if (unknown) return { ok: false, error: unknown };
  const control = parseControl(input);
  if (!control.ok) return control;
  const chartRef = parseRef(input.chartRef, 'chartRef');
  if (typeof chartRef !== 'string') return { ok: false, error: chartRef };
  return { ok: true, value: { ...control.value, chartRef } };
}

export function parseAvailabilityInput(input: unknown): { ok: true; value: CommonCall & { lines: QuantityLine[] } } | { ok: false; error: FieldError } {
  if (!isRecord(input)) return { ok: false, error: { field: 'lines', message: 'getAvailability expects an object.' } };
  for (const field of ['officeId', 'exact', 'units', 'pool'] as const) {
    if (field in input && input[field] !== undefined) {
      return {
        ok: false,
        error: {
          field,
          message: 'Exact office, pool, or unit counts are outside this public read profile and were not returned as zero.',
        },
      };
    }
  }
  const unknown = rejectUnknown(input, new Set(['lines', ...CONTROL_KEYS]));
  if (unknown) return { ok: false, error: unknown };
  const control = parseControl(input);
  if (!control.ok) return control;
  const lines = parseLines(input.lines);
  if (!lines.ok) return lines;
  return { ok: true, value: { ...control.value, lines: lines.lines } };
}

export function parsePriceInput(input: unknown): { ok: true; value: CommonCall & { variantRef: string; qty: number; currency?: string } } | { ok: false; error: FieldError } {
  if (!isRecord(input)) return { ok: false, error: { field: 'variantRef', message: 'getPrice expects an object.' } };
  const unknown = rejectUnknown(input, new Set(['variantRef', 'qty', 'currency', ...CONTROL_KEYS]));
  if (unknown) return { ok: false, error: unknown };
  const control = parseControl(input);
  if (!control.ok) return control;
  const variantRef = parseRef(input.variantRef, 'variantRef');
  if (typeof variantRef !== 'string') return { ok: false, error: variantRef };
  const qty = parseQty(input.qty);
  if (!qty.ok) return qty;
  const currency = parseCurrency(input.currency);
  if (currency && typeof currency !== 'string') return { ok: false, error: currency };
  return { ok: true, value: { ...control.value, variantRef, qty: qty.qty, ...(currency ? { currency } : {}) } };
}

export function parseQuoteInput(input: unknown): { ok: true; value: CommonCall & { lines: QuantityLine[]; currency?: string } } | { ok: false; error: FieldError } {
  if (!isRecord(input)) return { ok: false, error: { field: 'lines', message: 'quoteCart expects an object.' } };
  const unknown = rejectUnknown(input, new Set(['lines', 'currency', ...CONTROL_KEYS]));
  if (unknown) return { ok: false, error: unknown };
  const control = parseControl(input);
  if (!control.ok) return control;
  const lines = parseLines(input.lines);
  if (!lines.ok) return lines;
  const currency = parseCurrency(input.currency);
  if (currency && typeof currency !== 'string') return { ok: false, error: currency };
  return { ok: true, value: { ...control.value, lines: lines.lines, ...(currency ? { currency } : {}) } };
}
