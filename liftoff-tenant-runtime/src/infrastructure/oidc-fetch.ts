// Authenticated cross-project HTTP fetch using google-auth-library's
// IdTokenClient. Used by code paths that call cross-service authenticated
// endpoints (e.g., chat-turn-handler's synchronous reconcile-now fallback
// against platform-backend).
//
// Audience is the target Cloud Run service URL — Cloud Run validates that
// the OIDC token's aud claim matches the receiving service URL.

import { GoogleAuth } from 'google-auth-library';

const auth = new GoogleAuth();
const clientCache = new Map<string, Awaited<ReturnType<GoogleAuth['getIdTokenClient']>>>();

async function getClientForAudience(audience: string) {
  let client = clientCache.get(audience);
  if (!client) {
    client = await auth.getIdTokenClient(audience);
    clientCache.set(audience, client);
  }
  return client;
}

export interface FetchWithOidcInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  // string covers JSON bodies; FormData covers multipart uploads (e.g.
  // POST /api/generated-files for surfacing Anchor PDFs / browser
  // downloads through the existing FileOutputCard render surface);
  // Buffer covers raw-binary callers if anyone needs it.
  body?: string | FormData | Buffer;
  timeoutMs?: number;
}

export async function fetchWithOidc(url: string, init: FetchWithOidcInit = {}): Promise<Response> {
  const audience = new URL(url).origin;
  const client = await getClientForAudience(audience);
  const oidcHeaders = await client.getRequestHeaders();
  const merged: Record<string, string> = {
    ...(init.headers ?? {}),
    ...Object.fromEntries(
      Object.entries(oidcHeaders).filter(([_, v]) => typeof v === 'string'),
    ) as Record<string, string>,
  };
  const controller = init.timeoutMs ? new AbortController() : undefined;
  const timeout = controller ? setTimeout(() => controller.abort(), init.timeoutMs) : null;
  try {
    // For FormData, do NOT set Content-Type — fetch's underlying
    // multipart encoder generates the boundary and sets the right
    // Content-Type header. Manually setting it strips the boundary
    // and the server fails to parse.
    if (init.body instanceof FormData) {
      delete merged['Content-Type'];
      delete merged['content-type'];
    }
    return await fetch(url, {
      method: init.method ?? 'GET',
      headers: merged,
      // BodyInit isn't part of @types/node's global lib but Node 18+'s
      // native fetch accepts string / FormData / Buffer / Uint8Array
      // at runtime. Cast to `unknown` then to fetch's expected `body`
      // shape — TS in CI runs the @types/node lib resolution and the
      // explicit BodyInit alias isn't visible. RequestInit['body']
      // resolves to the right union at the public boundary.
      body: init.body as unknown as RequestInit['body'],
      signal: controller?.signal,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
