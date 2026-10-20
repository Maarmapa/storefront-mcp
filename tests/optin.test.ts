// Double opt-in tokens. The whole flow rests on one property: without a usable
// signing secret, NOTHING is issued and NOTHING is accepted. A missing env var
// must not become an open door.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  MIN_SIGNING_SECRET_LENGTH,
  OPT_IN_TTL_MS,
  confirmUrlBase,
  issueOptInToken,
  optInConfigured,
  optInFailureMessage,
  signingSecretState,
  verifyOptInToken,
} from '../src/lib/optin';

const GOOD_KEY = 'a'.repeat(MIN_SIGNING_SECRET_LENGTH);
const REF = { slug: 'acetona-60-ml' };

afterEach(() => {
  delete process.env.STOCK_ALERT_SIGNING_SECRET;
  delete process.env.STOCK_ALERT_CONFIRM_URL;
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe('fail closed without a usable key', () => {
  it('issues nothing when the secret is missing', () => {
    assert.equal(optInConfigured(), false);
    assert.equal(signingSecretState(), 'missing');
    assert.equal(issueOptInToken('a@b.cl', REF), null);
  });

  it('issues nothing when the secret is too short', () => {
    process.env.STOCK_ALERT_SIGNING_SECRET = 'x'.repeat(MIN_SIGNING_SECRET_LENGTH - 1);
    assert.equal(signingSecretState(), 'too_short');
    assert.equal(optInConfigured(), false);
    assert.equal(issueOptInToken('a@b.cl', REF), null);
  });

  it('accepts nothing either — not even a token it minted itself', () => {
    process.env.STOCK_ALERT_SIGNING_SECRET = GOOD_KEY;
    const issued = issueOptInToken('a@b.cl', REF);
    assert.ok(issued);

    delete process.env.STOCK_ALERT_SIGNING_SECRET;
    const verdict = verifyOptInToken(issued.token);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false && verdict.reason, 'not_configured');
  });

  it('the boundary length is accepted', () => {
    process.env.STOCK_ALERT_SIGNING_SECRET = GOOD_KEY;
    assert.equal(signingSecretState(), 'ok');
    assert.equal(optInConfigured(), true);
  });
});

describe('round trip', () => {
  it('mints and verifies, carrying the sku when there is one', () => {
    process.env.STOCK_ALERT_SIGNING_SECRET = GOOD_KEY;
    const issued = issueOptInToken('mario@example.cl', { slug: 'p', sku: 'SKU-1' });
    assert.ok(issued);

    const verdict = verifyOptInToken(issued.token);
    assert.equal(verdict.ok, true);
    if (verdict.ok) {
      assert.equal(verdict.email, 'mario@example.cl');
      assert.equal(verdict.slug, 'p');
      assert.equal(verdict.sku, 'SKU-1');
    }
  });

  it('puts the expiry INSIDE the signed payload', () => {
    process.env.STOCK_ALERT_SIGNING_SECRET = GOOD_KEY;
    const now = 1_700_000_000_000;
    const issued = issueOptInToken('a@b.cl', REF, now);
    assert.ok(issued);
    assert.equal(issued.expires_at, new Date(now + OPT_IN_TTL_MS).toISOString());

    // One millisecond past the expiry the same token is refused, and there is
    // no separate field an attacker could edit to move it.
    assert.equal(verifyOptInToken(issued.token, now + OPT_IN_TTL_MS + 1).ok, false);
    assert.equal(verifyOptInToken(issued.token, now + OPT_IN_TTL_MS - 1).ok, true);
  });
});

describe('forgery and tampering', () => {
  it('rejects a token whose payload was edited', () => {
    process.env.STOCK_ALERT_SIGNING_SECRET = GOOD_KEY;
    const issued = issueOptInToken('victim@example.cl', REF);
    assert.ok(issued);

    const [version, , sig] = issued.token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ e: 'attacker@example.cl', s: 'p', x: Date.now() + 60_000 }),
      'utf8',
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const verdict = verifyOptInToken(`${version}.${forgedPayload}.${sig}`);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false && verdict.reason, 'bad_signature');
  });

  it('rejects a token signed with a different key', () => {
    process.env.STOCK_ALERT_SIGNING_SECRET = GOOD_KEY;
    const issued = issueOptInToken('a@b.cl', REF);
    assert.ok(issued);

    process.env.STOCK_ALERT_SIGNING_SECRET = 'b'.repeat(MIN_SIGNING_SECRET_LENGTH);
    const verdict = verifyOptInToken(issued.token);
    assert.equal(verdict.ok === false && verdict.reason, 'bad_signature');
  });

  it('never throws on garbage from the internet', () => {
    process.env.STOCK_ALERT_SIGNING_SECRET = GOOD_KEY;
    for (const junk of ['', '.', 'v1', 'v1.a', 'v2.a.b', 'a.b.c', 'v1..', '{}', '../../etc/passwd']) {
      const verdict = verifyOptInToken(junk);
      assert.equal(verdict.ok, false, JSON.stringify(junk));
    }
  });

  it('tells a prober the same thing for every failure except expiry', () => {
    // Distinguishing "misconfigured" from "bad signature" tells an attacker
    // whether their forgery had the right shape.
    const opaque = optInFailureMessage('bad_signature');
    assert.equal(optInFailureMessage('not_configured'), opaque);
    assert.equal(optInFailureMessage('malformed'), opaque);
    assert.notEqual(optInFailureMessage('expired'), opaque);
  });
});

describe('confirmation URL', () => {
  it('is null when nothing is configured, so no mail can go out', () => {
    assert.equal(confirmUrlBase(), null);
  });

  it('rejects a relative path and a non-http scheme', () => {
    for (const bad of ['/api/stock-alert/confirm', 'javascript:alert(1)', 'ftp://x/y', 'not a url']) {
      process.env.STOCK_ALERT_CONFIRM_URL = bad;
      assert.equal(confirmUrlBase(), null, bad);
    }
  });

  it('accepts an absolute http(s) URL and trims the trailing slash', () => {
    process.env.STOCK_ALERT_CONFIRM_URL = 'https://boykot.cl/confirm/';
    assert.equal(confirmUrlBase(), 'https://boykot.cl/confirm');
  });

  it('derives one from the site URL when no explicit URL is set', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://boykot.cl/';
    assert.equal(confirmUrlBase(), 'https://boykot.cl/api/stock-alert/confirm');
  });
});
