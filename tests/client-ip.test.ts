// Who is calling. The inversion this file protects: a forwarding header is
// only worth something when an edge writes it. With no proxy in front, the
// whole header — last hop included — is a string the caller typed, and a rate
// limit keyed on it is a no-op with extra steps.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { UNATTRIBUTED_KEY, resolveCaller, trustedProxyHeader } from '../src/lib/client-ip';

afterEach(() => {
  delete process.env.TRUSTED_PROXY_HEADER;
});

const headers = (map: Record<string, string | string[]>) => (name: string) => map[name];

describe('with no trusted header configured', () => {
  it('ignores forwarding headers entirely', () => {
    const id = resolveCaller(
      headers({
        'x-forwarded-for': '203.0.113.1',
        'x-real-ip': '203.0.113.2',
        'cf-connecting-ip': '203.0.113.3',
      }),
      '10.0.0.9',
    );
    // The socket wins: it is the one address the caller cannot choose.
    assert.equal(id.clientKey, 'sock:10.0.0.9');
    assert.equal(id.source, 'socket');
    assert.equal(id.attributed, true);
  });

  it('is unattributed when there is no socket either', () => {
    const id = resolveCaller(headers({ 'x-forwarded-for': '203.0.113.1' }), null);
    assert.equal(id.clientKey, UNATTRIBUTED_KEY);
    assert.equal(id.attributed, false);
    assert.equal(id.source, 'none');
  });
});

describe('with a trusted header configured', () => {
  it('uses it, and takes the LAST entry of a list', () => {
    process.env.TRUSTED_PROXY_HEADER = 'x-vercel-forwarded-for';
    const id = resolveCaller(
      headers({ 'x-vercel-forwarded-for': '198.51.100.7, 203.0.113.1, 192.0.2.5' }),
      '10.0.0.9',
    );
    // Everything left of the last entry came from further out and is worth
    // nothing: a caller can prepend whatever it likes.
    assert.equal(id.clientKey, 'ip:192.0.2.5');
    assert.equal(id.source, 'trusted-header');
    assert.equal(id.attributed, true);
  });

  it('takes the last value when the header repeats', () => {
    process.env.TRUSTED_PROXY_HEADER = 'cf-connecting-ip';
    const id = resolveCaller(headers({ 'cf-connecting-ip': ['1.1.1.1', '2.2.2.2'] }), null);
    assert.equal(id.clientKey, 'ip:2.2.2.2');
  });

  it('does NOT fall back to another header when the trusted one is absent', () => {
    // A missing trusted header means this request did not come through the
    // edge the operator described — which is exactly the case worth not
    // trusting. Falling back to x-forwarded-for here would undo the whole file.
    process.env.TRUSTED_PROXY_HEADER = 'x-vercel-forwarded-for';
    const id = resolveCaller(headers({ 'x-forwarded-for': '203.0.113.1' }), null);
    assert.equal(id.clientKey, UNATTRIBUTED_KEY);
    assert.equal(id.attributed, false);
  });

  it('falls through to the socket when the trusted header is absent', () => {
    process.env.TRUSTED_PROXY_HEADER = 'x-vercel-forwarded-for';
    const id = resolveCaller(headers({ 'x-forwarded-for': '203.0.113.1' }), '10.0.0.9');
    assert.equal(id.clientKey, 'sock:10.0.0.9');
  });

  it('ignores an empty or whitespace-only value', () => {
    process.env.TRUSTED_PROXY_HEADER = 'cf-connecting-ip';
    const id = resolveCaller(headers({ 'cf-connecting-ip': '   ' }), null);
    assert.equal(id.clientKey, UNATTRIBUTED_KEY);
  });
});

describe('trustedProxyHeader', () => {
  it('is null when unset or blank, and normalized when set', () => {
    assert.equal(trustedProxyHeader(), null);
    process.env.TRUSTED_PROXY_HEADER = '   ';
    assert.equal(trustedProxyHeader(), null);
    process.env.TRUSTED_PROXY_HEADER = '  CF-Connecting-IP ';
    assert.equal(trustedProxyHeader(), 'cf-connecting-ip');
  });
});
