import { READ_AUTH_SCOPE } from './policy';
import type { ClientWarning, Components } from './types';

/** In-memory only. There is no localStorage, sessionStorage, or disk write. */
export interface CacheRecord {
  storedAtMs: number;
  fetchedAt: string;
  upstreamObservedAt: string | null;
  sourceUpdatedAt: string | null;
  adapterVersion: string | null;
  sourceRef: string;
  partitionRef: string;
  authScope: typeof READ_AUTH_SCOPE;
  data: unknown;
  components: Components;
  warnings: ClientWarning[];
  partial: boolean;
}

export interface CacheIdentity {
  /** Opaque transport identity. Not a bearer, not a URL. */
  partitionRef: string;
  authScope: typeof READ_AUTH_SCOPE;
  /** Filtered server version, or `none` when the manifest did not send one. */
  adapterVersion: string;
}

const DEFAULT_MAX_ENTRIES = 64;

/**
 * Bounded in-memory cache. Eviction is a memory cap, not a freshness promise:
 * dropping an entry does not mean the source changed.
 */
export class MemoryReadCache {
  private readonly entries = new Map<string, CacheRecord>();

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000) {
      throw new TypeError('MemoryReadCache maxEntries must be an integer from 1 to 1000.');
    }
  }

  get(key: string): CacheRecord | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: CacheRecord): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * Identity comes first so two stores, two adapter versions, or two anonymous
 * partitions cannot collide on operation + cacheScope + args alone.
 * `cacheScope` stays a caller label inside one identity. It is not authorization.
 */
export function cacheKey(
  operation: string,
  scope: string,
  parts: Record<string, string | number>,
  identity: CacheIdentity,
): string {
  const body = Object.keys(parts)
    .sort()
    .map(key => `${key}=${parts[key]}`)
    .join('&');
  return [identity.partitionRef, identity.authScope, identity.adapterVersion, operation, scope, body].join('\n');
}
