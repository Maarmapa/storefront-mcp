// Cart normalization. The rule: a quantity is a positive integer or it is an
// error. No Math.floor, no `|| 1`, no clamping — because every one of those
// turns a caller's mistake into an order somebody pays for.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_INPUT_ITEMS,
  MAX_UNITS_PER_PRODUCT,
  normalizeCart,
} from '../src/lib/cart';

describe('quantities are never repaired', () => {
  it('rejects every non positive-integer, echoing back what it received', () => {
    const bad = [0, -3, 2.5, 'many', Number.NaN, Number.POSITIVE_INFINITY, null, undefined, true];
    const cart = normalizeCart(bad.map(qty => ({ slug: 'a', qty })));

    assert.equal(cart.lines.length, 0, 'nothing may survive as a line');
    assert.equal(cart.items_invalid_qty.length, bad.length);
    // The received value is echoed, not repaired: an operator reading the
    // response can see 2.5 rather than a silently created order for 2.
    assert.equal(cart.items_invalid_qty[2]?.qty_received, 2.5);
    assert.equal(cart.items_invalid_qty[3]?.qty_received, 'many');
    for (const item of cart.items_invalid_qty) {
      assert.ok(item.reason.length > 0, 'every rejection carries a reason');
    }
  });

  it('accepts a positive integer', () => {
    const cart = normalizeCart([{ slug: 'acetona-60-ml', qty: 3 }]);
    assert.equal(cart.lines.length, 1);
    assert.equal(cart.lines[0]?.qty, 3);
    assert.equal(cart.items_invalid_qty.length, 0);
  });
});

describe('references', () => {
  it('an item with neither slug nor sku is reported, not guessed at', () => {
    const cart = normalizeCart([{ qty: 1 }, { slug: '   ', qty: 1 }]);
    assert.equal(cart.lines.length, 0);
    assert.equal(cart.items_missing_ref.length, 2);
    assert.equal(cart.items_missing_ref[0]?.index, 0);
  });

  it('a non-array input is an empty cart, not a crash', () => {
    for (const raw of [null, undefined, 'items', 42, {}]) {
      const cart = normalizeCart(raw);
      assert.equal(cart.lines.length, 0, JSON.stringify(raw));
    }
  });
});

describe('consolidation', () => {
  it('merges duplicate rows of the same spelling and says how many collapsed', () => {
    const cart = normalizeCart([
      { slug: 'a', qty: 2 },
      { slug: 'a', qty: 3 },
    ]);
    assert.equal(cart.lines.length, 1);
    assert.equal(cart.lines[0]?.qty, 5);
    assert.equal(cart.lines[0]?.merged_from, 2);
    assert.equal(cart.consolidated, true);
  });

  it('does not merge different spellings — that is the adapter s job', () => {
    // slug and sku may be the same pile of units, but only the inventory
    // adapter can say so. Guessing here would be inventing stock identity.
    const cart = normalizeCart([
      { slug: 'acetona-60-ml', qty: 1 },
      { sku: 'ACETONA60ML', qty: 1 },
    ]);
    assert.equal(cart.lines.length, 2);
    assert.equal(cart.consolidated, false);
  });
});

describe('ceilings', () => {
  it('measures units per product AFTER consolidation, not per input row', () => {
    // Split across rows, each under the limit, the total is over it. A check
    // that ran per row would wave this through.
    const rows = Array.from({ length: 6 }, () => ({ slug: 'a', qty: 10 }));
    const cart = normalizeCart(rows);
    assert.equal(cart.lines.length, 1);
    assert.ok(
      cart.lines[0]!.qty > MAX_UNITS_PER_PRODUCT,
      'the consolidated quantity is what the limit must be applied to',
    );
  });

  it('refuses to even look at an oversized array', () => {
    const rows = Array.from({ length: MAX_INPUT_ITEMS + 1 }, () => ({ slug: 'a', qty: 1 }));
    const cart = normalizeCart(rows);
    assert.deepEqual(cart.too_many_input_items, {
      received: MAX_INPUT_ITEMS + 1,
      limit: MAX_INPUT_ITEMS,
    });
    assert.equal(cart.lines.length, 0, 'nothing is processed once the array is too large');
  });

  it('flags too many distinct products', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ slug: `p${i}`, qty: 1 }));
    const cart = normalizeCart(rows);
    assert.ok(cart.too_many_products, 'the distinct-product ceiling is reported');
    assert.equal(cart.too_many_products?.distinct, 25);
  });
});
