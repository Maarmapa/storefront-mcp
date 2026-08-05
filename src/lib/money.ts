// Money arithmetic, and the two assumptions a storefront template must not
// make silently.
//
// ASSUMPTION 1: "two decimals". `Math.round(x * 100) / 100` is written into
// most e-commerce code as if it were a law of nature. It is a property of a
// handful of currencies. JPY, KRW, CLP, VND and friends have ZERO minor units
// (¥1980.5 is not a price); BHD, KWD, OMR, TND and JOD have THREE (0.125 × 3
// is 0.375, and rounding it to 0.38 overcharges by design). A template that
// takes `currency` as a free-form string from the adapter and then hardcodes
// hundredths is wrong for every store outside the two-decimal world.
//
// ASSUMPTION 2: "a float is fine". It is not, and this module does not pretend
// otherwise — it rounds at the currency's real precision, which keeps the
// error from compounding across lines, but the values in `Product.price` and
// `Quote.subtotal` are still IEEE doubles. If you are handling real money at
// volume, the fix is to carry integer minor units end to end (price_minor:
// 450, not price: 4.5). That is a breaking change to the adapter contract and
// it belongs in YOUR fork; what this file does is make sure the rounding step
// is at least asking the right question.

/** Currencies with no minor unit: the amount IS the integer. */
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
  'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/** Currencies with three minor units (mils). */
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/**
 * Minor units for an ISO-4217 code. Unknown codes get 2 — the common case —
 * but note that this is a GUESS for anything outside the lists above, and a
 * guess about money is exactly the kind of thing to make explicit rather than
 * bury in a rounding helper.
 */
export function minorUnits(currency: string): number {
  const c = (currency || '').trim().toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/** Round an amount to its currency's real precision. */
export function roundMoney(amount: number, currency: string): number {
  if (!Number.isFinite(amount)) return 0;
  const f = Math.pow(10, minorUnits(currency));
  return Math.round(amount * f) / f;
}

/** Sum a list of amounts, rounding once at the end. */
export function sumMoney(amounts: number[], currency: string): number {
  return roundMoney(
    amounts.reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0),
    currency,
  );
}

/**
 * Do two amounts agree at the currency's precision?
 *
 * Used by the checkout path to reconcile what the pricing source said with
 * what the server computed, so a float artifact does not read as fraud and
 * fraud does not read as a float artifact.
 */
export function moneyEquals(a: number, b: number, currency: string): boolean {
  return roundMoney(a, currency) === roundMoney(b, currency);
}
