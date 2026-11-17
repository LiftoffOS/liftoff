// Tunnels Internal Service Router.
//
// Service-token authenticated endpoints used by liftoff-tunnel-service to
// bootstrap its route table, emit deployment status heartbeats, and run
// the stale-pending / disconnected sweep jobs. Mounted BEFORE the regular
// authMiddleware in src/index.ts.

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../infrastructure/database';
import { tunnelsService } from './service';
import { log } from '../infrastructure/logging';

export const tunnelsInternalRouter = Router();

const INTERNAL_SERVICE_TOKEN_VARS = [
  'CONNECTOR_SERVICE_TOKEN',
  'WORKFORCE_SERVICE_TOKEN',
  'GOVERNANCE_EVAL_SERVICE_TOKEN',
  'HARVEST_SERVICE_TOKEN',
  'TUNNEL_SERVICE_TOKEN',
] as const;

function serviceAuth(req: Request, res: Response, next: () => void): void {
  const token = req.headers['x-service-auth'] as string | undefined;
  if (!token) {
    res.status(401).json({ error: 'Missing service authentication' });
    return;
  }
  const candidates = INTERNAL_SERVICE_TOKEN_VARS
    .map((v) => process.env[v])
    .filter((t): t is string => Boolean(t));
  if (candidates.length === 0) {
    res.status(503).json({ error: 'Tunnel internal endpoint not configured' });
    return;
  }
  const matched = candidates.some((expected) => {
    try {
      return (
        Buffer.byteLength(token) === Buffer.byteLength(expected) &&
        crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
      );
    } catch {
      return false;
    }
  });
  if (!matched) {
    res.status(401).json({ error: 'Invalid service authentication' });
    return;
  }
  next();
}

// GET /api/internal/tunnel-routes/all
//
// Includes the deployment's inner_tls_enabled flag so the terminator's
// dispatcher can pick between HTTPReverseProxy and SniPassthrough planes per
// route without a second round-trip.
tunnelsInternalRouter.get('/internal/tunnel-routes/all', serviceAuth, async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.deployment_id, d.tenant_id, d.tenant_prefix, d.inner_tls_enabled,
              d.loopback_port, r.subdomain, r.upstream_url, r.public_url
       FROM mcp_tunnel_routes r
       INNER JOIN mcp_tunnel_deployments d ON r.deployment_id = d.id`,
    );
    res.json({
      routes: result.rows.map((row) => ({
        id: row.id,
        deploymentId: row.deployment_id,
        tenantId: row.tenant_id,
        tenantPrefix: row.tenant_prefix,
        innerTlsEnabled: row.inner_tls_enabled,
        // Per-tenant in-container loopback port (migration 229). The
        // tunnel-service dispatcher dials localhost:<loopbackPort> when an
        // HTTP request arrives for this route's public hostname; stock
        // chisel server-side has bound that port when the customer's
        // chisel client opened R:<loopbackPort>:upstreamHost:upstreamPort.
        loopbackPort: row.loopback_port,
        subdomain: row.subdomain,
        upstreamUrl: row.upstream_url,
        publicUrl: row.public_url,
      })),
    });
  } catch (error) {
    log.error({ error }, 'Failed to fetch all tunnel routes');
    res.status(500).json({ error: 'Failed to fetch tunnel routes' });
  }
});

// GET /api/internal/tunnel-deployments/active-tokens
//
// Returns the current { tenantPrefix, token } pairs the terminator's chisel
// UserSource pre-populates and refreshes against. Returning a token here
// (vs. just a list of prefixes) lets the terminator skip a Secret Manager
// access per first-connection. Tokens are still validated against Secret
// Manager directly on rotation grace-window edges by the terminator.
tunnelsInternalRouter.get(
  '/internal/tunnel-deployments/active-tokens',
  serviceAuth,
  async (_req: Request, res: Response) => {
    try {
      const tokens = await tunnelsService.listActiveTokens();
      res.json({ tokens });
    } catch (error) {
      log.error({ error }, 'Failed to fetch active tunnel tokens');
      res.status(500).json({ error: 'Failed to fetch active tunnel tokens' });
    }
  },
);

// POST /api/internal/tunnels/sweep-token-grace
//
// Cloud Scheduler (every minute) calls this so any prior token version whose
// 5-minute grace window has expired is disabled in Secret Manager — recovers
// from process restarts mid-rotation.
tunnelsInternalRouter.post(
  '/internal/tunnels/sweep-token-grace',
  serviceAuth,
  async (_req: Request, res: Response) => {
    try {
      const disabled = await tunnelsService.sweepExpiredTokenVersions();
      res.json({ disabled });
    } catch (error) {
      log.error({ error }, 'Failed to sweep expired tunnel token versions');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

const heartbeatSchema = z.object({
  tenantPrefix: z.string().min(1).max(63),
  status: z.enum(['active', 'disconnected']),
  observedAt: z.string().optional(),
});

tunnelsInternalRouter.post(
  '/internal/tunnel-deployments/heartbeat',
  serviceAuth,
  async (req: Request, res: Response) => {
    const parseResult = heartbeatSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }
    const { tenantPrefix, status } = parseResult.data;
    try {
      if (status === 'active') {
        await tunnelsService.markDeploymentActive(tenantPrefix);
      } else {
        await pool.query(
          `UPDATE mcp_tunnel_deployments
             SET status = 'disconnected', updated_at = NOW()
           WHERE tenant_prefix = $1`,
          [tenantPrefix],
        );
      }
      res.json({ ok: true });
    } catch (error) {
      log.error({ error }, 'Failed to record tunnel heartbeat');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

tunnelsInternalRouter.post('/internal/tunnels/sweep-pending', serviceAuth, async (_req: Request, res: Response) => {
  try {
    const count = await tunnelsService.sweepStalePending();
    res.json({ swept: count });
  } catch (error) {
    log.error({ error }, 'Failed to sweep stale pending tunnel deployments');
    res.status(500).json({ error: (error as Error).message });
  }
});

tunnelsInternalRouter.post('/internal/tunnels/sweep-disconnected', serviceAuth, async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `UPDATE mcp_tunnel_deployments
         SET status = 'disconnected', updated_at = NOW()
       WHERE status = 'active' AND last_seen_at < NOW() - INTERVAL '90 seconds'
       RETURNING id`,
    );
    res.json({ marked: result.rowCount ?? 0 });
  } catch (error) {
    log.error({ error }, 'Failed to sweep disconnected tunnel deployments');
    res.status(500).json({ error: (error as Error).message });
  }
});
