// The kill switches. Every assertion here is about the SAME rule: a
// misconfigured switch must land on "nothing happened", never on "we charged
// people". The parsing is deliberately asymmetric and this file is what keeps
// somebody from "fixing" it into a friendly truthy check.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  checkoutMode,
  modeBanner,
  stockAlertMode,
  unreservedCheckoutPolicy,
} from '../src/lib/write-mode';

const KEYS = ['CHECKOUT_MODE', 'STOCK_ALERT_MODE', 'CHECKOUT_UNRESERVED'] as const;

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe('write mode', () => {
  it('defaults to dry when unset', () => {
    assert.equal(checkoutMode(), 'dry');
    assert.equal(stockAlertMode(), 'dry');
  });

  it('only the exact word live reaches live', () => {
    for (const [raw, expected] of [
      ['live', 'live'],
      ['LIVE', 'live'],
      ['  live  ', 'live'],
      ['off', 'off'],
      ['OFF', 'off'],
    ] as const) {
      process.env.CHECKOUT_MODE = raw;
      assert.equal(checkoutMode(), expected, `CHECKOUT_MODE=${JSON.stringify(raw)}`);
    }
  });

  it('a typo lands in dry, never in live', () => {
    // Every one of these is something an operator has typed at 2am meaning
    // "on". If any of them ever returns 'live', real orders get created by a
    // misspelling.
    for (const raw of ['Live!', 'true', '1', 'yes', 'on', 'liv', 'livee', 'l i v e', '']) {
      process.env.CHECKOUT_MODE = raw;
      assert.equal(checkoutMode(), 'dry', `CHECKOUT_MODE=${JSON.stringify(raw)} must be dry`);
    }
  });

  it('the two switches are independent', () => {
    process.env.CHECKOUT_MODE = 'live';
    process.env.STOCK_ALERT_MODE = 'off';
    assert.equal(checkoutMode(), 'live');
    assert.equal(stockAlertMode(), 'off');
  });
});

describe('unreserved checkout policy', () => {
  it('refuses by default', () => {
    assert.equal(unreservedCheckoutPolicy(), 'refuse');
  });

  it('only the exact word allow opens it', () => {
    process.env.CHECKOUT_UNRESERVED = 'ALLOW';
    assert.equal(unreservedCheckoutPolicy(), 'allow');
    process.env.CHECKOUT_UNRESERVED = '  allow ';
    assert.equal(unreservedCheckoutPolicy(), 'allow');
  });

  it('anything else refuses, including things that look like yes', () => {
    for (const raw of ['true', '1', 'yes', 'allowed', 'Allow!', 'refuse', '']) {
      process.env.CHECKOUT_UNRESERVED = raw;
      assert.equal(
        unreservedCheckoutPolicy(),
        'refuse',
        `CHECKOUT_UNRESERVED=${JSON.stringify(raw)} must refuse`,
      );
    }
  });
});

describe('mode banner', () => {
  it('says LIVE only in live, so the agent reads the mode before calling', () => {
    assert.match(modeBanner('live', 'create a real order'), /MODE: LIVE/);
    assert.match(modeBanner('live', 'create a real order'), /create a real order/);
  });

  it('says DRY RUN for every non-live mode', () => {
    for (const mode of ['dry', 'off'] as const) {
      const banner = modeBanner(mode, 'create a real order');
      assert.match(banner, /DRY RUN/);
      assert.doesNotMatch(banner, /MODE: LIVE/);
    }
  });
});
