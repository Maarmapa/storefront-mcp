// Adapter registry. The route asks this module for the active adapters and
// never knows which backend is behind them.
//
// Selection via env CATALOG_ADAPTER:
//   "memory"      (default) → toy catalog from examples/toy-catalog.json,
//                             with a fake back office so you can try the
//                             gated tools too.
//   "woocommerce"           → Store API skeleton (catalog only, no ops).
//
// To add your own: implement CatalogAdapter (and optionally OpsAdapter) in a
// new file here, then add a case below.

import type { StorefrontAdapters } from '../adapter';
import { MemoryCatalogAdapter, MemoryOpsAdapter } from './memory';
import { WooCommerceCatalogAdapter } from './woocommerce';

let cached: StorefrontAdapters | null = null;

export function getAdapters(): StorefrontAdapters {
  if (cached) return cached;
  const kind = process.env.CATALOG_ADAPTER || 'memory';
  switch (kind) {
    case 'woocommerce':
      // No OpsAdapter on purpose: the Store API only sees public data, and
      // wiring order/revenue data needs a deliberate, authenticated backend.
      cached = { catalog: new WooCommerceCatalogAdapter() };
      break;
    case 'memory':
    default:
      cached = { catalog: new MemoryCatalogAdapter(), ops: new MemoryOpsAdapter() };
      break;
  }
  return cached;
}
