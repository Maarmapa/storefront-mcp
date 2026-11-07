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
  send(request: RpcRequest, init: { signal: AbortSignal }): Promise<RpcResponse>;
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

export function createHttpTransport(endpoint: string, fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)): ReadTransport {
  const url = assertReadEndpoint(endpoint);
  return {
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
