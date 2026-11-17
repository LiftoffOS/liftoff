// Authenticated cross-project HTTP fetch using google-auth-library's
// IdTokenClient. Used by the reconciler to call tenant-runtime endpoints which
// require OIDC service auth (see runtime's requireServiceAuth).
//
// Audience is the target Cloud Run service URL — Cloud Run validates that the
// OIDC token's aud claim matches the receiving service URL exactly.

import { GoogleAuth } from 'google-auth-library';

// Constructed lazily, not at module load — see the same note in
// packages/service-client/src/oidc-auth.ts. A module-level `new GoogleAuth()`
// makes every transitive importer untestable without a full
// google-auth-library mock, which is how adding an import to
// web-tool-spend-subscriber broke that suite. The per-audience client cache is
// unchanged.
let auth: GoogleAuth | null = null;
const clientCache = new Map<string, Awaited<ReturnType<GoogleAuth['getIdTokenClient']>>>();

async function getClientForAudience(audience: string) {
  let client = clientCache.get(audience);
  if (!client) {
    if (!auth) auth = new GoogleAuth();
    client = await auth.getIdTokenClient(audience);
    clientCache.set(audience, client);
  }
  return client;
}

export interface FetchWithOidcInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
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
    return await fetch(url, {
      method: init.method ?? 'GET',
      headers: merged,
      body: init.body,
      signal: controller?.signal,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
