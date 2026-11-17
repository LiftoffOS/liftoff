// Tenant Runtime URL resolution and request header construction.
// Shared by TenantRuntimeClient (HITL/insights) and TenantRuntimeFeedClient
// (cost-attribution ingestion) so both can be moved independently.

import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { log } from '../infrastructure/logging';

const runtimeUrlCache = new Map<string, { url: string; expiry: number }>();
const RUNTIME_URL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get the tenant runtime URL. Async: looks up from DB with caching.
 * Shared tenants have their runtime_url set in the tenants table.
 * Dedicated tenants also have it set after provisioning.
 * Falls back to TENANT_RUNTIME_URL env var if DB lookup fails or returns null.
 */
export async function getTenantRuntimeUrl(tenantId: string): Promise<string> {
  const cached = runtimeUrlCache.get(tenantId);
  if (cached && cached.expiry > Date.now()) {
    return cached.url;
  }

  try {
    // Dynamic import to avoid circular dependency at module load time
    const { TenantRepository } = await import('../tenants/repository');
    const tenantRepo = new TenantRepository();
    const tenant = await tenantRepo.findById(tenantId);

    if (tenant?.runtimeUrl) {
      runtimeUrlCache.set(tenantId, {
        url: tenant.runtimeUrl,
        expiry: Date.now() + RUNTIME_URL_CACHE_TTL_MS,
      });
      return tenant.runtimeUrl;
    }
  } catch (err) {
    log.warn({ tenantId, error: (err as Error).message }, 'Failed to look up tenant runtime URL, using fallback');
  }

  const fallback = process.env.TENANT_RUNTIME_URL || 'http://localhost:4000';
  runtimeUrlCache.set(tenantId, {
    url: fallback,
    expiry: Date.now() + RUNTIME_URL_CACHE_TTL_MS,
  });
  return fallback;
}

/**
 * Resolve and validate the tenant runtime base URL.
 * Runtime assertion: catches missed awaits that would produce "[object Promise]".
 */
export async function resolveRuntimeBaseUrl(tenantId: string): Promise<string> {
  const url = await getTenantRuntimeUrl(tenantId);
  if (!url.startsWith('http')) {
    throw new Error(`Invalid runtime URL for tenant ${tenantId}: "${url}" — possible missed await`);
  }
  return url;
}

/**
 * Build standard headers for Tenant Runtime requests.
 * Includes X-Service-Auth for application-level auth and
 * Authorization: Bearer <token> for Cloud Run IAM (OIDC identity token).
 */
export async function buildRuntimeHeaders(tenantId: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-tenant-id': tenantId,
  };

  const serviceToken = process.env.TENANT_RUNTIME_SERVICE_TOKEN;
  if (serviceToken) {
    headers['X-Service-Auth'] = serviceToken;
  }

  const targetUrl = await resolveRuntimeBaseUrl(tenantId);
  Object.assign(headers, await buildOidcAuthHeader(targetUrl));

  return headers;
}
