// Turning whatever the caller sent into a canonical cart, before any limit,
// price or stock check runs.
//
// Two failures live here, and both look like working code until they don't:
//
// 1. LIMITS APPLIED TO THE INPUT SHAPE INSTEAD OF THE CANONICAL SHAPE.
//    "Max 50 units per line, max 20 lines" reads like a control. Send the same
//    SKU on 20 lines of 50 and it is 1000 units of one SKU, every line inside
//    every limit. The stock check has the same hole: with 60 units in the
//    warehouse each 50-unit line "fits" on its own, and together they do not.
//    Consolidation must therefore happen FIRST, and every aggregate limit is
//    evaluated on the consolidated total.
//
// 2. COERCING AN AMBIGUOUS QUANTITY. `Math.min(Math.max(Math.floor(Number(qty)
//    || 1), 1), 50)` turns {qty: 0} — which from an agent means "remove this"
//    — into one unit billed to a human, and turns negatives, NaN and fractions
//    into invented sales. In a tool that takes money, sanitizing means
//    REJECTING AND EXPLAINING; rewriting the input into something plausible is
//    fabricating intent.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO: enforce the per-product unit
// ceiling. It cannot — not correctly. This module only sees how the caller
// SPELLED each line, and `{slug:'notebook-a4'}` and `{sku:'NB-A4'}` can be the
// same pile of units. Only the inventory adapter knows that (AvailabilityRow.
// pool), so the ceiling and the availability check are both evaluated one
// layer up, on pools, in src/lib/commerce.ts. A limit enforced twice in two
// places drifts; a limit enforced where the identity is still ambiguous is
// enforced against the wrong thing.

import type { LineRef } from './adapter';
import { refKey } from './availability';

/** Aggregate ceilings. Evaluated on the CONSOLIDATED cart, never per input row. */
export const MAX_UNITS_PER_PRODUCT = 50;
export const MAX_DISTINCT_PRODUCTS = 20;
/** Cheap guard against a caller that sends an enormous array in the first place. */
export const MAX_INPUT_ITEMS = 100;

export interface NormalizedLine extends LineRef {
  key: string;
  qty: number;
  /** How many input rows collapsed into this line. >1 means the caller duplicated it. */
  merged_from: number;
}

export interface InvalidQtyItem extends LineRef {
  index: number;
  /** The value exactly as received — echoed back, never repaired. */
  qty_received: unknown;
  reason: string;
}

export interface NormalizedCart {
  lines: NormalizedLine[];
  items_invalid_qty: InvalidQtyItem[];
  items_missing_ref: Array<{ index: number; reason: string }>;
  /** Set when the caller sent more distinct products than the cart allows. */
  too_many_products?: { distinct: number; limit: number };
  /** Set when the raw array was too large to even look at. */
  too_many_input_items?: { received: number; limit: number };
  /** True when at least one input row was merged into another. */
  consolidated: boolean;
}

interface RawItem {
  slug?: unknown;
  sku?: unknown;
  qty?: unknown;
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

/**
 * Validate, consolidate by spelling, then measure the ceilings that do not
 * need stock identity — in that order.
 *
 * Nothing here talks to the catalog or to inventory: this is purely "what did
 * the caller actually ask for, in canonical form". Keeping it separate is what
 * makes the ordering auditable.
 */
export function normalizeCart(raw: unknown): NormalizedCart {
  const out: NormalizedCart = {
    lines: [],
    items_invalid_qty: [],
    items_missing_ref: [],
    consolidated: false,
  };

  const items: RawItem[] = Array.isArray(raw) ? (raw as RawItem[]) : [];
  if (items.length > MAX_INPUT_ITEMS) {
    out.too_many_input_items = { received: items.length, limit: MAX_INPUT_ITEMS };
    return out;
  }

  const byKey = new Map<string, NormalizedLine>();

  items.forEach((it, index) => {
    const sku = str(it?.sku);
    const slug = str(it?.slug);
    if (!sku && !slug) {
      out.items_missing_ref.push({ index, reason: 'each item needs a slug or a sku' });
      return;
    }

    // A quantity is a positive integer or it is an error. No Math.floor, no
    // `|| 1`, no clamping: 0, -3, 2.5, "many", NaN and Infinity all come back
    // to the caller with the value they sent.
    const qty = it?.qty;
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0) {
      out.items_invalid_qty.push({
        index,
        slug,
        sku,
        qty_received: qty === undefined ? null : (qty as unknown),
        reason: 'qty must be an integer greater than 0 (it is not corrected for you)',
      });
      return;
    }

    // Consolidation happens BEFORE any ceiling is measured — see the header.
    // This merges identical spellings; merging different spellings of the same
    // pool needs the inventory adapter and happens in commerce.ts.
    const ref: LineRef = sku ? { sku, ...(slug ? { slug } : {}) } : { slug };
    const key = refKey(ref);
    const existing = byKey.get(key);
    if (existing) {
      existing.qty += qty;
      existing.merged_from += 1;
      out.consolidated = true;
    } else {
      byKey.set(key, { ...ref, key, qty, merged_from: 1 });
    }
  });

  const lines = [...byKey.values()];

  if (lines.length > MAX_DISTINCT_PRODUCTS) {
    out.too_many_products = { distinct: lines.length, limit: MAX_DISTINCT_PRODUCTS };
    return out;
  }

  out.lines = lines;
  return out;
}
