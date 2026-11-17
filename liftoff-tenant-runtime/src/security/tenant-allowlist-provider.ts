// Tenant Allowlist Provider.
//
// Pulls the per-tenant MCP URL allowlist snapshot from platform-backend's
// internal endpoint:
//
//   GET /api/internal/tenants/:id/mcp-allowlist
//
// Maintains an in-memory cache keyed by tenantId with a 60s TTL. A Pub/Sub
// invalidation hook is exposed (invalidate(tenantId) — called from a
// subscriber wired up at process start) so route additions surface within
// seconds rather than 60s.

import { logger } from '../infrastructure/logging';
import type { TenantAllowlistContext } from './mcp-url-guard';
import { getManagedSecret } from '../infrastructure/secret-store';

const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  ctx: TenantAllowlistContext;
  expiresAt: number;
}

export interface TenantAllowlistProviderOptions {
  /** Base URL of platform-backend. Required. */
  platformBackendUrl: string;
  /** Internal service token sent as X-Service-Auth. Required. */
  serviceToken: string;
  /** Cache TTL in ms. Defaults to 60s. */
  ttlMs?: number;
  /** Fetch implementation (override for tests). */
  fetchImpl?: typeof fetch;
}

export class TenantAllowlistProvider {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<TenantAllowlistContext>>();
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TenantAllowlistProviderOptions) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Get the snapshot for a tenant, refreshing if stale. */
  async get(tenantId: string): Promise<TenantAllowlistContext> {
    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > now) return cached.ctx;

    const pending = this.inFlight.get(tenantId);
    if (pending) return pending;

    const promise = this.fetchSnapshot(tenantId)
      .then((ctx) => {
        this.cache.set(tenantId, { ctx, expiresAt: Date.now() + this.ttlMs });
        return ctx;
      })
      .catch((err) => {
        // On fetch failure, fall back to the stale snapshot if we have one;
        // otherwise surface an empty allowlist so the URL guard rejects unless
        // the URL is in the global vendor list. This is the safe default.
        if (cached) {
          logger.warn('tenant_allowlist_fetch_failed_using_stale', { tenantId, err: String(err) });
          return cached.ctx;
        }
        logger.error('tenant_allowlist_fetch_failed_empty_snapshot', { tenantId, err: String(err) });
        const empty: TenantAllowlistContext = { tenantId, urls: [], version: 'v-error' };
        // Cache empty for a short window so we don't hammer the backend.
        this.cache.set(tenantId, { ctx: empty, expiresAt: Date.now() + Math.min(this.ttlMs, 10_000) });
        return empty;
      })
      .finally(() => {
        this.inFlight.delete(tenantId);
      });

    this.inFlight.set(tenantId, promise);
    return promise;
  }

  /** Drop the cached entry for a tenant. Called from Pub/Sub subscribers. */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  /** Drop everything (used in tests and on shutdown). */
  invalidateAll(): void {
    this.cache.clear();
  }

  private async fetchSnapshot(tenantId: string): Promise<TenantAllowlistContext> {
    const url = `${this.options.platformBackendUrl.replace(/\/$/, '')}/api/internal/tenants/${encodeURIComponent(
      tenantId,
    )}/mcp-allowlist`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        'x-service-auth': this.options.serviceToken,
        accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`allowlist fetch failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as {
      tenantId: string;
      urls: string[];
      version: string;
    };
    return {
      tenantId: json.tenantId,
      urls: Array.isArray(json.urls) ? [...json.urls] : [],
      version: json.version ?? 'v-unknown',
    };
  }
}

let _singleton: TenantAllowlistProvider | null = null;

/**
 * Module-level singleton. Construct lazily so test code can construct its
 * own instance via the class. Reads env vars at first call.
 */
export function getTenantAllowlistProvider(): TenantAllowlistProvider {
  if (_singleton) return _singleton;
  const platformBackendUrl = process.env.PLATFORM_BACKEND_URL;
  // PB's allowlist endpoint accepts a list including CONNECTOR_SERVICE_TOKEN,
  // so the old fallback chain worked through that fallback. Switching to
  // TENANT_RUNTIME_SERVICE_TOKEN aligns with every other TR -> PB caller and
  // removes coupling to a brittle PLATFORM_BACKEND_SERVICE_TOKEN env var
  // that no TR deployment has ever set.
  const serviceToken = getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN');
  if (!platformBackendUrl) {
    throw new Error('PLATFORM_BACKEND_URL is required for the tenant allowlist provider');
  }
  if (!serviceToken) {
    throw new Error('TENANT_RUNTIME_SERVICE_TOKEN is required for the tenant allowlist provider');
  }
  _singleton = new TenantAllowlistProvider({ platformBackendUrl, serviceToken });
  return _singleton;
}

/** Test hook — reset the singleton between tests. */
export function _resetTenantAllowlistProviderForTesting(): void {
  _singleton = null;
}
