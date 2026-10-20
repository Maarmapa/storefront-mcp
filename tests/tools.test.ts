// What the server ANNOUNCES. The rule the whole template rests on: a tool that
// cannot be honest is not announced. This is the file that catches somebody
// re-adding a stub so an interface looks complete — which is exactly what the
// WooCommerce adapter used to do, announcing a chart list that was always
// empty and a quote that always rejected.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  CORE_TOOLS,
  OPS_TOOLS,
  SENSITIVE_TOOLS,
  WRITE_TOOLS,
  catalogToolDefs,
  writeToolDefs,
} from '../src/lib/tools';

const names = (defs: { name: string }[]) => defs.map(d => d.name).sort();

afterEach(() => {
  delete process.env.CHECKOUT_MODE;
  delete process.env.STOCK_ALERT_MODE;
});

describe('catalog tools follow the adapter capabilities', () => {
  it('announces nothing optional when the adapter implements nothing optional', () => {
    // This is the WooCommerce shape: catalog only, no quote, no charts, no
    // promotions beyond the core.
    const defs = catalogToolDefs({ promotions: false, quote: false, variantCharts: false });
    assert.deepEqual(defs, [], 'an adapter with no optional capability announces no optional tool');
  });

  it('announces the variant chart pair together, or not at all', () => {
    const off = names(catalogToolDefs({ promotions: false, quote: false, variantCharts: false }));
    assert.equal(off.includes('get_variant_chart'), false);
    assert.equal(off.includes('list_variant_charts'), false);

    const on = names(catalogToolDefs({ promotions: false, quote: false, variantCharts: true }));
    assert.equal(on.includes('get_variant_chart'), true);
    assert.equal(on.includes('list_variant_charts'), true);
  });

  it('each capability adds only its own tool', () => {
    const quoteOnly = names(catalogToolDefs({ promotions: false, quote: true, variantCharts: false }));
    assert.deepEqual(quoteOnly, ['get_quote']);
  });

  it('core tools exist regardless of capabilities', () => {
    assert.ok(CORE_TOOLS.length > 0);
    for (const t of CORE_TOOLS) {
      assert.ok(t.name.length > 0);
      assert.ok(t.description.length > 0, `${t.name} needs a description`);
      assert.ok(t.inputSchema, `${t.name} needs an input schema`);
    }
  });
});

describe('write tools follow the capabilities too', () => {
  it('announces nothing when the adapter can neither check out nor alert', () => {
    assert.deepEqual(writeToolDefs({ checkout: false, stockAlert: false }), []);
  });

  it('announces create_checkout only when the capability exists', () => {
    assert.deepEqual(names(writeToolDefs({ checkout: true, stockAlert: false })), ['create_checkout']);
    assert.deepEqual(
      names(writeToolDefs({ checkout: false, stockAlert: true })),
      ['subscribe_stock_alert'],
    );
  });

  it('carries the current mode in the description, so the agent reads it before calling', () => {
    process.env.CHECKOUT_MODE = 'live';
    const live = writeToolDefs({ checkout: true, stockAlert: false })[0];
    assert.match(live!.description, /MODE: LIVE/);

    delete process.env.CHECKOUT_MODE;
    const dry = writeToolDefs({ checkout: true, stockAlert: false })[0];
    assert.match(dry!.description, /DRY RUN/);
  });

  it('never accepts a price from the caller', () => {
    const checkout = writeToolDefs({ checkout: true, stockAlert: false })[0];
    const itemProps = (checkout!.inputSchema as any)?.properties?.items?.items?.properties ?? {};
    assert.equal('price' in itemProps, false, 'there is deliberately no price field');
    assert.deepEqual(Object.keys(itemProps).sort(), ['qty', 'sku', 'slug']);
  });
});

describe('the tool classifications stay in sync', () => {
  it('every announced write tool is registered as a write tool', () => {
    const announced = writeToolDefs({ checkout: true, stockAlert: true }).map(d => d.name);
    for (const name of announced) {
      assert.ok(WRITE_TOOLS.has(name), `${name} is announced but not in WRITE_TOOLS`);
    }
  });

  it('every ops tool is sensitive', () => {
    // OPS_TOOLS are the token-gated back office. If one ever escapes
    // SENSITIVE_TOOLS it becomes readable without the secret.
    for (const t of OPS_TOOLS) {
      assert.ok(SENSITIVE_TOOLS.has(t.name), `${t.name} is an ops tool but not sensitive`);
    }
    assert.equal(SENSITIVE_TOOLS.size, OPS_TOOLS.length);
  });

  it('no core or catalog tool is sensitive', () => {
    const open = [
      ...CORE_TOOLS,
      ...catalogToolDefs({ promotions: true, quote: true, variantCharts: true }),
    ];
    for (const t of open) {
      assert.equal(SENSITIVE_TOOLS.has(t.name), false, `${t.name} must not need the secret`);
    }
  });
});
