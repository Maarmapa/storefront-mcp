// Adapter registry. The route asks this module for the active adapters and
// never knows which backend is behind them.
//
// Selection via env CATALOG_ADAPTER:
//   "memory"      (default) → toy catalog from examples/toy-catalog.json,
//                             with a fake back office AND fake
//                             inventory/checkout/notify, so every tool in the
//                             server can be exercised without a backend.
//   "woocommerce"           → Store API skeleton (catalog only).
//
// What is returned here decides WHICH TOOLS EXIST. Omitting a capability is a
// supported configuration, not a degraded one: the tools that need it are
// never announced, so an agent cannot call something this deployment has no
// honest way to answer. That is why they are separate optional fields instead
// of one big interface with methods that throw.
//
// To add your own: implement CatalogAdapter (and optionally the rest) in a
// new file here, then add a case below.

import type { StorefrontAdapters } from '../adapter';
import {
  MemoryCatalogAdapter,
  MemoryCheckoutAdapter,
  MemoryInventoryAdapter,
  MemoryNotifyAdapter,
  MemoryOpsAdapter,
} from './memory';
import { WooCommerceCatalogAdapter } from './woocommerce';

let cached: StorefrontAdapters | null = null;

export function getAdapters(): StorefrontAdapters {
  if (cached) return cached;
  const kind = process.env.CATALOG_ADAPTER || 'memory';
  switch (kind) {
    case 'woocommerce':
      // Catalog only, on purpose. The Store API sees public data; orders,
      // revenue and real stock need a deliberate authenticated backend, and
      // an inventory source is a decision about YOUR systems that nobody can
      // guess for you. Result: with this adapter the write tools do not
      // appear at all — which is the correct behavior, not a limitation.
      cached = { catalog: new WooCommerceCatalogAdapter() };
      break;
    case 'memory':
    default:
      cached = {
        catalog: new MemoryCatalogAdapter(),
        ops: new MemoryOpsAdapter(),
        inventory: new MemoryInventoryAdapter(),
        checkout: new MemoryCheckoutAdapter(),
        notify: new MemoryNotifyAdapter(),
      };
      break;
  }
  return cached;
}
