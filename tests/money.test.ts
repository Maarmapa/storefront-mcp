// Money. The bug this guards against is the one every storefront ships with:
// `Math.round(x * 100) / 100` written as if two decimals were a law of nature.
// Boykot prices in CLP, which has none, so this is not a hypothetical.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { minorUnits, moneyEquals, roundMoney, sumMoney } from '../src/lib/money';

describe('minor units', () => {
  it('knows the zero-decimal currencies', () => {
    for (const c of ['CLP', 'JPY', 'KRW', 'VND', 'ISK', 'PYG']) {
      assert.equal(minorUnits(c), 0, c);
    }
  });

  it('knows the three-decimal currencies', () => {
    for (const c of ['KWD', 'BHD', 'OMR', 'TND', 'JOD']) {
      assert.equal(minorUnits(c), 3, c);
    }
  });

  it('guesses two for everything else, including unknown codes', () => {
    for (const c of ['USD', 'EUR', 'GBP', 'ZZZ', '', 'not-a-currency']) {
      assert.equal(minorUnits(c), 2, JSON.stringify(c));
    }
  });

  it('does not care about case or padding', () => {
    assert.equal(minorUnits(' clp '), 0);
    assert.equal(minorUnits('Clp'), 0);
  });
});

describe('rounding at the currency precision', () => {
  it('CLP has no cents: a half peso rounds to a peso', () => {
    assert.equal(roundMoney(1980.5, 'CLP'), 1981);
    assert.equal(roundMoney(6900.4, 'CLP'), 6900);
  });

  it('USD keeps two decimals', () => {
    assert.equal(roundMoney(4.005, 'USD'), 4.01);
    assert.equal(roundMoney(4.004, 'USD'), 4);
  });

  it('KWD keeps three, so rounding to two would overcharge', () => {
    // 0.125 × 3 = 0.375. Rounded at two decimals that becomes 0.38.
    assert.equal(roundMoney(0.375, 'KWD'), 0.375);
    assert.notEqual(roundMoney(0.375, 'KWD'), 0.38);
  });

  it('a non-finite amount is zero, not NaN travelling into a receipt', () => {
    assert.equal(roundMoney(Number.NaN, 'USD'), 0);
    assert.equal(roundMoney(Number.POSITIVE_INFINITY, 'USD'), 0);
  });
});

describe('summing', () => {
  it('rounds once at the end, not per line', () => {
    // Three lines of 0.005 are 0.015 → 0.02. Rounding each first gives 0.03.
    assert.equal(sumMoney([0.005, 0.005, 0.005], 'USD'), 0.02);
  });

  it('skips non-finite entries instead of poisoning the total', () => {
    assert.equal(sumMoney([10, Number.NaN, 5], 'USD'), 15);
  });

  it('sums CLP as integers', () => {
    assert.equal(sumMoney([2500, 6900, 46000], 'CLP'), 55400);
  });
});

describe('comparing', () => {
  it('agrees at the currency precision, so a float artifact is not read as fraud', () => {
    assert.equal(moneyEquals(0.1 + 0.2, 0.3, 'USD'), true);
  });

  it('still catches a real difference', () => {
    assert.equal(moneyEquals(10, 100, 'CLP'), false);
  });

  it('is stricter in a three-decimal currency than in a two-decimal one', () => {
    assert.equal(moneyEquals(1.001, 1.002, 'USD'), true);
    assert.equal(moneyEquals(1.001, 1.002, 'KWD'), false);
  });
});
