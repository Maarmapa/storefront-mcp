// Availability, and the single rule the write path depends on: "I don't know"
// must block exactly like "there is none". Every degradation here has to land
// on {units: null, verified: false} with a reason — the two tempting
// alternatives (default to 0, default to optimism) are both wrong, one blocks
// real sales and the other sells air.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AvailabilityRow, InventoryAdapter, LineRef } from '../src/lib/adapter';
import {
  NO_INVENTORY_SOURCE,
  blocksWrite,
  poolKey,
  refKey,
  resolveAvailability,
} from '../src/lib/availability';

function inventory(getAvailability: InventoryAdapter['getAvailability']): InventoryAdapter {
  return { getAvailability };
}

const REFS: LineRef[] = [{ slug: 'acetona-60-ml' }, { sku: 'ACETONA60ML' }];

describe('resolveAvailability', () => {
  it('with no inventory adapter, every line is unknown and says why', async () => {
    const rows = await resolveAvailability(undefined, REFS);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.units, null);
      assert.equal(r.verified, false);
      assert.equal(r.reason, NO_INVENTORY_SOURCE);
    }
  });

  it('when the backend throws, EVERY line is unknown — no partial optimism', async () => {
    const rows = await resolveAvailability(
      inventory(async () => {
        throw new Error('ERP timeout');
      }),
      REFS,
    );
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.verified, false);
      assert.equal(r.units, null);
      assert.match(r.reason ?? '', /inventory backend unavailable: ERP timeout/);
    }
  });

  it('a ref the inventory source has no row for is unknown, not zero', async () => {
    const rows = await resolveAvailability(
      inventory(async () => [{ slug: 'acetona-60-ml', units: 4, verified: true }]),
      REFS,
    );
    assert.equal(rows[0]?.units, 4);
    assert.equal(rows[0]?.verified, true);
    assert.equal(rows[1]?.units, null);
    assert.equal(rows[1]?.verified, false);
    assert.match(rows[1]?.reason ?? '', /no row for this line/);
  });

  it('normalizes the contradiction of verified:true with no count', async () => {
    // An adapter that claims it verified something and then hands back null is
    // not trusted into a "yes". Trusting the flag over the number is how an
    // order gets created against unknown stock.
    const rows = await resolveAvailability(
      inventory(async () => [{ slug: 'acetona-60-ml', units: null, verified: true }]),
      [{ slug: 'acetona-60-ml' }],
    );
    assert.equal(rows[0]?.verified, false);
    assert.equal(rows[0]?.units, null);
  });

  it('rejects a non-finite count the same way', async () => {
    for (const units of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const rows = await resolveAvailability(
        inventory(async () => [{ slug: 'x', units, verified: true } as AvailabilityRow]),
        [{ slug: 'x' }],
      );
      assert.equal(rows[0]?.verified, false, String(units));
      assert.equal(rows[0]?.units, null, String(units));
    }
  });

  it('floors and clamps a verified count', async () => {
    const rows = await resolveAvailability(
      inventory(async () => [
        { slug: 'a', units: 2.9, verified: true },
        { slug: 'b', units: -5, verified: true },
      ]),
      [{ slug: 'a' }, { slug: 'b' }],
    );
    assert.equal(rows[0]?.units, 2);
    assert.equal(rows[1]?.units, 0);
  });

  it('returns one row per requested ref, in the requested order', async () => {
    const rows = await resolveAvailability(
      inventory(async () => [
        { sku: 'B', units: 1, verified: true },
        { slug: 'a', units: 2, verified: true },
      ]),
      [{ slug: 'a' }, { sku: 'B' }],
    );
    assert.deepEqual(
      rows.map(r => refKey(r)),
      ['slug:a', 'sku:B'],
    );
  });

  it('an empty request asks the backend nothing', async () => {
    let called = false;
    const rows = await resolveAvailability(
      inventory(async () => {
        called = true;
        return [];
      }),
      [],
    );
    assert.deepEqual(rows, []);
    assert.equal(called, false);
  });
});

describe('pool identity', () => {
  it('falls back to the request shape when the adapter names no pool', () => {
    assert.equal(poolKey({ slug: 'a', units: 1, verified: true }), 'slug:a');
    assert.equal(poolKey({ sku: 'A', units: 1, verified: true }), 'sku:A');
  });

  it('collapses two spellings of the same pile onto one key', () => {
    // Without this, a cart with the slug on one line and the sku on another is
    // checked twice against the same units and passes twice.
    const bySlug = poolKey({ slug: 'acetona-60-ml', pool: 'wc:product:241169', units: 4, verified: true });
    const bySku = poolKey({ sku: 'ACETONA60ML', pool: 'wc:product:241169', units: 4, verified: true });
    assert.equal(bySlug, bySku);
  });

  it('a sku wins over a slug in the request-shape key', () => {
    assert.equal(refKey({ slug: 'a', sku: 'A' }), 'sku:A');
  });
});

describe('blocksWrite', () => {
  it('blocks when the line was never verified', () => {
    assert.equal(blocksWrite({ units: 99, verified: false }, 1), true);
  });

  it('blocks on unknown units exactly like on zero', () => {
    assert.equal(blocksWrite({ units: null, verified: true }, 1), true);
    assert.equal(blocksWrite({ units: 0, verified: true }, 1), true);
  });

  it('blocks when there are fewer units than requested', () => {
    assert.equal(blocksWrite({ units: 2, verified: true }, 3), true);
  });

  it('allows only a verified count that covers the request', () => {
    assert.equal(blocksWrite({ units: 3, verified: true }, 3), false);
    assert.equal(blocksWrite({ units: 4, verified: true }, 3), false);
  });
});
