// Resolving real availability, and degrading without inventing anything.
//
// The failure this exists to prevent: a write path that resolves each line
// against the CATALOG index — which answers "is this published and
// purchasable?" — and then hands it straight to the pricing code, which
// answers "what does it cost?". Neither of them ever asks "are there units?",
// so an agent can order 50 of something you have 2 of, and the order plus its
// payable link are created at machine speed with no human in the loop.
//
// Published and available are different questions with different owners
// (CMS/catalog vs. ERP/POS/inventory). This module asks the second one.

import type { AvailabilityRow, InventoryAdapter, LineRef } from './adapter';

/**
 * Canonical identity of a line. A SKU wins over a slug: it is the more
 * specific thing, and mixing the two keys is how a cart ends up with the same
 * item counted twice.
 */
export function refKey(ref: LineRef): string {
  return ref.sku ? `sku:${ref.sku}` : `slug:${ref.slug ?? ''}`;
}

export const NO_INVENTORY_SOURCE = 'no inventory source configured on this deployment';

/**
 * One row per requested ref, always, in the requested order.
 *
 * Every degradation path lands on `{units: null, verified: false}` with a
 * reason attached, because the alternatives are both wrong: defaulting to 0
 * silently blocks real sales, defaulting to "probably fine" sells air. The
 * reason string travels to the agent so it can tell the human WHY it stopped
 * instead of retrying blindly.
 */
export async function resolveAvailability(
  inventory: InventoryAdapter | undefined,
  refs: LineRef[],
): Promise<AvailabilityRow[]> {
  const unknown = (reason: string): AvailabilityRow[] =>
    refs.map(r => ({ ...r, units: null, verified: false, reason }));

  if (!inventory) return unknown(NO_INVENTORY_SOURCE);
  if (refs.length === 0) return [];

  let rows: AvailabilityRow[];
  try {
    rows = await inventory.getAvailability(refs);
  } catch (e) {
    // The backend is down. EVERY line becomes unverifiable — no partial
    // optimism, no cached guesses.
    return unknown(`inventory backend unavailable: ${(e as Error).message}`);
  }

  const byKey = new Map<string, AvailabilityRow>();
  for (const row of rows ?? []) byKey.set(refKey(row), row);

  return refs.map(ref => {
    const row = byKey.get(refKey(ref));
    if (!row) {
      // A ref the inventory system does not know about (unmapped variant, no
      // row in the snapshot). Not zero. Not "assume yes". Unknown.
      return {
        ...ref,
        units: null,
        verified: false,
        reason: 'no row for this line in the inventory source',
      };
    }
    const units = row.units;
    if (!row.verified || units == null || typeof units !== 'number' || !Number.isFinite(units)) {
      // Also catches an adapter that claims verified:true with a null count —
      // normalize the contradiction to "unknown" instead of trusting the flag.
      return {
        ...ref,
        units: null,
        verified: false,
        reason: row.reason ?? 'inventory source could not verify this line',
      };
    }
    return { ...ref, units: Math.max(0, Math.floor(units)), verified: true, reason: row.reason };
  });
}

/**
 * The write-side verdict for one line. `null` units block exactly like zero:
 * before charging a human, "I don't know" and "there is none" are the same
 * answer. Read-side tools are free to be more relaxed — showing an unknown as
 * unknown costs nobody money.
 */
export function blocksWrite(row: AvailabilityRow, requested: number): boolean {
  return !row.verified || row.units == null || row.units < requested;
}
