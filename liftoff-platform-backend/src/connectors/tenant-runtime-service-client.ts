// Connect-RPC client for TenantRuntimeService.
//
// Per-tenant base URL resolved via resolveRuntimeBaseUrl (same source used by
// the legacy REST client). Instances are cached by base URL so a single HTTP/2
// connection pool is reused across concurrent RPC calls to the same tenant runtime.
//
// Auth: every request carries
//   - X-Service-Auth: <TENANT_RUNTIME_SERVICE_TOKEN>  (constant-time compare on callee)
//   - Authorization: Bearer <OIDC id token>           (Cloud Run IAM)

import {
  createClient,
  ConnectError,
  Code,
  type Interceptor,
  type Client,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { TenantRuntimeService } from '@liftoffos/proto-gen';
import { BrowserSessionsService } from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';
import { resolveRuntimeBaseUrl } from './tenant-runtime-url';

export { ConnectError, Code };

// PR3: shared transport builder so BrowserSessionsService client reuses the
// same auth interceptor + HTTP/2 pool as the TenantRuntimeService client.
function buildTenantRuntimeTransport(baseUrl: string) {
  return createConnectTransport({
    baseUrl,
    httpVersion: '2',
    interceptors: [defaultAuthInterceptor()],
    pingIntervalMs: 30_000,
    pingIdleConnection: false,
    pingTimeoutMs: 5_000,
    idleConnectionTimeoutMs: 10 * 60 * 1000,
  });
}

function defaultAuthInterceptor(): Interceptor {
  return (next) => async (req) => {
    const token = process.env.TENANT_RUNTIME_SERVICE_TOKEN;
    if (token) req.header.set('X-Service-Auth', token);
    try {
      const oidc = await buildOidcAuthHeader(req.url);
      for (const [k, v] of Object.entries(oidc)) req.header.set(k, v);
    } catch {
      // Local dev — metadata server not available. Cloud Run always succeeds.
    }
    return next(req);
  };
}

const clientCache = new Map<string, Client<typeof TenantRuntimeService>>();

export function createTenantRuntimeServiceClient(
  baseUrl: string,
): Client<typeof TenantRuntimeService> {
  const cached = clientCache.get(baseUrl);
  if (cached) return cached;
  const client = createClient(TenantRuntimeService, buildTenantRuntimeTransport(baseUrl));
  clientCache.set(baseUrl, client);
  return client;
}

export async function getTenantRuntimeServiceClient(
  tenantId: string,
): Promise<Client<typeof TenantRuntimeService>> {
  const url = await resolveRuntimeBaseUrl(tenantId);
  return createTenantRuntimeServiceClient(url);
}

// PR3: parallel client for the BrowserSessionsService surface.
const browserClientCache = new Map<string, Client<typeof BrowserSessionsService>>();

export function createBrowserSessionsServiceClient(
  baseUrl: string,
): Client<typeof BrowserSessionsService> {
  const cached = browserClientCache.get(baseUrl);
  if (cached) return cached;
  const client = createClient(BrowserSessionsService, buildTenantRuntimeTransport(baseUrl));
  browserClientCache.set(baseUrl, client);
  return client;
}

export async function getBrowserSessionsServiceClient(
  tenantId: string,
): Promise<Client<typeof BrowserSessionsService>> {
  const url = await resolveRuntimeBaseUrl(tenantId);
  return createBrowserSessionsServiceClient(url);
}

export function resetTenantRuntimeServiceClientCache(): void {
  clientCache.clear();
  browserClientCache.clear();
}

export { TenantRuntimeService, BrowserSessionsService };
