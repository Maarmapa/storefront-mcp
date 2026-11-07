import type { ClientWarning, Components } from './types';

/** In-memory only. There is no localStorage, sessionStorage, or disk write. */
export interface CacheRecord {
  storedAtMs: number;
  fetchedAt: string;
  upstreamObservedAt: string | null;
  sourceUpdatedAt: string | null;
  adapterVersion: string | null;
  sourceRef: string;
  data: unknown;
  components: Components;
  warnings: ClientWarning[];
  partial: boolean;
}

export class MemoryReadCache {
  private readonly entries = new Map<string, CacheRecord>();

  get(key: string): CacheRecord | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: CacheRecord): void {
    this.entries.set(key, value);
  }
}

export function cacheKey(operation: string, scope: string, parts: Record<string, string | number>): string {
  const body = Object.keys(parts)
    .sort()
    .map(key => `${key}=${parts[key]}`)
    .join('&');
  return `${operation}\n${scope}\n${body}`;
}
