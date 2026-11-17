/**
 * Tool Catalog Router
 *
 * HTTP endpoints for querying the per-tenant tool catalog. Called by
 * platform-backend's TenantRuntimeClient during distill to feed real,
 * aliased tool names into the LLM for agent/workflow classification.
 *
 * Endpoints:
 *   GET /api/v1/tool-catalog/tenant/:tenantId/manifest/:manifestId/tools
 *   GET /api/v1/tool-catalog/tenant/:tenantId/manifests
 *
 * Auth: relies on x-tenant-id header + Cloud Run internal-only ingress.
 * The tenant path param is cross-checked against the header to prevent
 * reconnaissance from a compromised internal caller.
 */

import { Router, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { getAvailableTools, getTenantManifests } from './catalog-service';
import { logger } from '../infrastructure/logging';

/**
 * Simple in-memory per-tenant rate limiter (100 req/min).
 * Resets counters each minute. Acceptable for an internal endpoint
 * with Cloud Run ingress — no persistence or distributed coordination needed.
 */
const rateLimitWindow = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(tenantId: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const entry = rateLimitWindow.get(tenantId);

  if (!entry || now >= entry.resetAt) {
    rateLimitWindow.set(tenantId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfterMs: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count++;
  return { allowed: true, retryAfterMs: 0 };
}

/** Generate a weak ETag from the response body for cache validation. */
function generateETag(body: unknown): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(body))
    .digest('hex')
    .slice(0, 16);
  return `W/"${hash}"`;
}

export const toolCatalogRouter = Router();

/**
 * GET /tenant/:tenantId/manifest/:manifestId/tools
 *
 * Returns the full tool catalog for a specific manifest, with tool names
 * in the exact aliased form the executor will use at runtime.
 */
toolCatalogRouter.get(
  '/tenant/:tenantId/manifest/:manifestId/tools',
  async (req: Request, res: Response) => {
    const { tenantId, manifestId } = req.params;

    // Cross-check: the path tenantId must match the header tenantId.
    const headerTenantId = req.ctx?.tenantId;
    if (headerTenantId && headerTenantId !== tenantId) {
      logger.warn({
        header_tenant_id: headerTenantId,
        path_tenant_id: tenantId,
      }, 'Tool catalog tenant mismatch — possible reconnaissance attempt');
      return res.status(403).json({ error: 'Tenant mismatch' });
    }

    // Rate limit: 100 req/tenant/min
    const rateCheck = checkRateLimit(tenantId);
    if (!rateCheck.allowed) {
      return res.status(429)
        .set('Retry-After', String(rateCheck.retryAfterMs))
        .json({ error: 'Too many requests' });
    }

    try {
      const result = await getAvailableTools(tenantId, manifestId);

      if (!result) {
        return res.status(404).json({ error: 'Manifest not found for this tenant' });
      }

      const body = {
        schemaVersion: 1,
        connectorType: result.connectorType,
        alias: result.alias,
        tools: result.tools,
      };

      const etag = generateETag(body);

      // If-None-Match: client already has this version → 304
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      return res
        .set('Cache-Control', 'private, max-age=300')
        .set('ETag', etag)
        .set('Vary', 'Authorization')
        .json(body);
    } catch (err) {
      logger.error({ err, tenant_id: tenantId, manifest_id: manifestId },
        'Tool catalog lookup failed');
      return res.status(500).json({ error: 'Internal error fetching tool catalog' });
    }
  },
);

/**
 * GET /tenant/:tenantId/manifests
 *
 * Lists all connected manifests for a tenant (summary view). Used by
 * distill to enumerate which integrations have tools to offer.
 */
toolCatalogRouter.get(
  '/tenant/:tenantId/manifests',
  async (req: Request, res: Response) => {
    const { tenantId } = req.params;

    const headerTenantId = req.ctx?.tenantId;
    if (headerTenantId && headerTenantId !== tenantId) {
      return res.status(403).json({ error: 'Tenant mismatch' });
    }

    const rateCheck = checkRateLimit(tenantId);
    if (!rateCheck.allowed) {
      return res.status(429)
        .set('Retry-After', String(rateCheck.retryAfterMs))
        .json({ error: 'Too many requests' });
    }

    try {
      const manifests = await getTenantManifests(tenantId);
      const body = { schemaVersion: 1, manifests };
      const etag = generateETag(body);

      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      return res
        .set('Cache-Control', 'private, max-age=300')
        .set('ETag', etag)
        .set('Vary', 'Authorization')
        .json(body);
    } catch (err) {
      logger.error({ err, tenant_id: tenantId }, 'Tenant manifests lookup failed');
      return res.status(500).json({ error: 'Internal error fetching manifests' });
    }
  },
);
