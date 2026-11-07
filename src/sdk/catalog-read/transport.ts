// HTTP transport for the read profile.
//
// The endpoint is fixed when the transport is created. Callers cannot pass a
// different host per request. Redirects are not followed. Cookies and
// Authorization are not attached: this profile has no privileged credential,
// and a browser session for another product must not ride along.

export interface RpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  status: number;
  body: unknown;
  retryAfterMs: number | null;
}

export interface ReadTransport {
  /**
   * Opaque identity for cache and provenance. A short public label or an
   * endpoint fingerprint. Not a bearer, not a URL, not a private host.
   */
  partitionRef: string;
  send(request: RpcRequest, init: { signal: AbortSignal }): Promise<RpcResponse>;
}

const PARTITION_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;

/** Rejects credentials and raw hosts. The thrown text does not echo the value. */
export function assertPartitionRef(value: unknown): string {
  if (typeof value !== 'string' || !PARTITION_REF.test(value)) {
    throw new TypeError('partitionRef must be a short public label. Credentials and hosts are not accepted.');
  }
  if (/bearer|password|mcp_secret|token=/i.test(value) || value.includes('://') || value.includes('@')) {
    throw new TypeError('partitionRef must be a short public label. Credentials and hosts are not accepted.');
  }
  if (/^\d{1,3}(\.\d{1,3}){3}(:|$)/.test(value)) {
    throw new TypeError('partitionRef must be a short public label. Credentials and hosts are not accepted.');
  }
  return value;
}

/** Canonical endpoint used only as hash input. Not stored on the cache record. */
export function canonicalReadEndpoint(url: URL): string {
  const protocol = url.protocol.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const port = url.port;
  const defaultPort = (protocol === 'https:' && (port === '' || port === '443')) || (protocol === 'http:' && (port === '' || port === '80'));
  const host = defaultPort ? hostname : `${hostname}:${port}`;
  let path = url.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !BLOCKED_QUERY.test(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.map(([key, item]) => `${encodeURIComponent(key)}=${encodeURIComponent(item)}`).join('&');
  return `${protocol}//${host}${path}${query ? `?${query}` : ''}`;
}

/** Non-reversible discriminator. Not a password hash and not the host. */
export function endpointPartitionRef(canonical: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= BigInt(canonical.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return `ep_${hash.toString(16).padStart(16, '0')}`;
}

export interface FetchLike {
  (url: string, init: RequestInit): Promise<Response>;
}

const BLOCKED_QUERY = /^(token|access_token|key|secret|authorization|api_key)$/i;

export function assertReadEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TypeError('Catalog read endpoint must be an absolute http(s) URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('Catalog read endpoint must use http or https.');
  }
  if (url.username || url.password) {
    throw new TypeError('Catalog read endpoint must not embed credentials.');
  }
  for (const key of url.searchParams.keys()) {
    if (BLOCKED_QUERY.test(key)) {
      throw new TypeError('Catalog read endpoint must not carry a token in the query string.');
    }
  }
  return url;
}

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

export function createHttpTransport(
  endpoint: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  options?: { partitionRef?: string },
): ReadTransport {
  const url = assertReadEndpoint(endpoint);
  const endpointRef = endpointPartitionRef(canonicalReadEndpoint(url));
  const tenant = options?.partitionRef === undefined ? '' : `:${assertPartitionRef(options.partitionRef)}`;
  const partitionRef = assertPartitionRef(`${endpointRef}${tenant}`);
  return {
    partitionRef,
    async send(request, init) {
      const response = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(request),
        signal: init.signal,
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      if (response.status >= 300 && response.status < 400) {
        return { status: response.status, body: null, retryAfterMs: null };
      }
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = null;
        }
      }
      return { status: response.status, body, retryAfterMs: retryAfterMs(response.headers) };
    },
  };
}
