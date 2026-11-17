// Kill Switch Middleware
// Per Section 12: Enforce tenant kill switch status from control plane.
//
// Source of truth: the tenant's entitlement record on the control plane.
// /api/admin/kill-switch/tenant/:tenantId/{disable,enable} on platform-backend
// toggles entitlement.tenantOperationalStatus + agentExecutionAllowed; this
// middleware reads those flags via the entitlements client cache. No separate
// "explicit kill switch" endpoint exists or is needed — the kill-switch state
// IS the entitlement state.

import { Request, Response, NextFunction } from 'express';
import { getEntitlementsClient } from '../entitlements-client/service';
import { logger } from '../infrastructure/logging';

// Cache for kill switch status with short TTL
const killSwitchCache = new Map<string, { status: KillSwitchStatus; cachedAt: number }>();
const CACHE_TTL_MS = 30000; // 30 seconds

export interface KillSwitchStatus {
  active: boolean;
  reason?: string;
  activatedAt?: Date;
  expiresAt?: Date;
}

export interface KillSwitchMiddlewareOptions {
  // Skip kill switch check for certain paths
  skipPaths?: string[];
  // Custom tenant ID extractor
  tenantIdExtractor?: (req: Request) => string | undefined;
  // Custom error handler
  onKillSwitchActive?: (
    req: Request,
    res: Response,
    status: KillSwitchStatus,
    /** The tenant the block was decided on — the same value the extractor
     *  produced, passed through so the handler cannot disagree with the
     *  decision about who was blocked. */
    tenantId: string,
  ) => void;
  // Whether to cache the kill switch status
  enableCache?: boolean;
  // Cache TTL in milliseconds
  cacheTtlMs?: number;
}

const DEFAULT_OPTIONS: Required<KillSwitchMiddlewareOptions> = {
  skipPaths: ['/health', '/metrics'],
  tenantIdExtractor: defaultTenantIdExtractor,
  onKillSwitchActive: defaultOnKillSwitchActive,
  enableCache: true,
  cacheTtlMs: CACHE_TTL_MS,
};

function defaultTenantIdExtractor(req: Request): string | undefined {
  return (
    req.headers['x-tenant-id'] as string ||
    req.params.tenantId ||
    req.body?.tenantId ||
    req.query.tenantId as string
  );
}

function defaultOnKillSwitchActive(
  req: Request,
  res: Response,
  status: KillSwitchStatus,
  tenantId: string,
): void {
  // The tenant comes from the argument, not from `x-tenant-id`. The extractor
  // that DECIDES the block already falls back to params/body/query, and the
  // platform backend passes the tenant as a query parameter — so reading the
  // header here logged `tenantId: undefined` on every block, omitting the one
  // field an operator needs to act on it.
  logger.warn('Request blocked by kill switch', {
    tenantId,
    path: req.path,
    method: req.method,
    reason: status.reason,
  });

  res.status(503).json({
    error: 'Service Unavailable',
    code: 'KILL_SWITCH_ACTIVE',
    message: 'This tenant is currently suspended. Please contact support.',
    reason: status.reason,
    retryAfter: status.expiresAt ? Math.ceil((status.expiresAt.getTime() - Date.now()) / 1000) : null,
  });
}

/**
 * Check kill switch status for a tenant.
 * This queries the control plane or uses cached status.
 */
export async function checkKillSwitchStatus(
  tenantId: string,
  options: KillSwitchMiddlewareOptions = {}
): Promise<KillSwitchStatus> {
  const { enableCache = true, cacheTtlMs = CACHE_TTL_MS } = options;

  // Check cache first
  if (enableCache) {
    const cached = killSwitchCache.get(tenantId);
    if (cached && Date.now() - cached.cachedAt < cacheTtlMs) {
      return cached.status;
    }
  }

  // Try to get status from entitlements client (local cache)
  const entitlementsClient = getEntitlementsClient();
  const entitlement = await entitlementsClient.getEntitlement(tenantId);

  // Check if tenant is suspended or agent execution is blocked
  if (entitlement.operationalStatus === 'suspended' || !entitlement.agentExecutionAllowed) {
    const status: KillSwitchStatus = {
      active: true,
      reason: entitlement.operationalStatus === 'suspended'
        ? 'Tenant suspended'
        : 'Agent execution disabled',
    };

    if (enableCache) {
      killSwitchCache.set(tenantId, { status, cachedAt: Date.now() });
    }

    return status;
  }

  // Entitlement says the tenant is healthy. The kill-switch admin endpoints
  // (POST /api/admin/kill-switch/tenant/:id/{disable,enable} on platform-backend)
  // mutate exactly these two flags and publish tenant.suspended / tenant.reactivated,
  // so the entitlement check above is the authoritative answer.
  const status: KillSwitchStatus = { active: false };
  if (enableCache) {
    killSwitchCache.set(tenantId, { status, cachedAt: Date.now() });
  }
  return status;
}

/**
 * Create kill switch enforcement middleware.
 */
export function createKillSwitchMiddleware(options: KillSwitchMiddlewareOptions = {}) {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };

  return async function killSwitchMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // Skip for certain paths
    if (mergedOptions.skipPaths.some(path => req.path.startsWith(path))) {
      next();
      return;
    }

    // Extract tenant ID
    const tenantId = mergedOptions.tenantIdExtractor(req);

    if (!tenantId) {
      // No tenant ID - let other middleware handle authentication
      next();
      return;
    }

    try {
      const status = await checkKillSwitchStatus(tenantId, mergedOptions);

      if (status.active) {
        mergedOptions.onKillSwitchActive(req, res, status, tenantId);
        return;
      }

      next();
    } catch (error) {
      logger.error('Kill switch middleware error', { error, tenantId });
      // Fail open on error - don't block requests due to kill switch check failure
      next();
    }
  };
}

/**
 * Clear the kill switch cache for a specific tenant.
 * Called when we receive an event indicating kill switch status changed.
 */
export function clearKillSwitchCache(tenantId: string): void {
  killSwitchCache.delete(tenantId);
  logger.info('Cleared kill switch cache', { tenantId });
}

/**
 * Clear the entire kill switch cache.
 */
export function clearAllKillSwitchCache(): void {
  killSwitchCache.clear();
  logger.info('Cleared all kill switch cache');
}

// Pre-configured middleware with default options
export const killSwitchMiddleware = createKillSwitchMiddleware();

// Middleware for critical paths that should always check kill switch
export const strictKillSwitchMiddleware = createKillSwitchMiddleware({
  enableCache: false, // Always check fresh status
  skipPaths: [], // Never skip
});
