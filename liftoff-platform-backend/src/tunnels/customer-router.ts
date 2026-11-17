// Tunnels Customer Router.
//
// Endpoints called by the customer's tunnel-client Docker container running
// inside their network. Not authenticated via the dashboard's user JWT or via
// the internal service-token — instead the container presents the per-tenant
// tunnel token (the same `tk_…` that the chisel handshake uses, sourced from
// Secret Manager under mcp-tunnel-token-{tenantPrefix}).
//
// Why this exists: the customer-side image polls this endpoint to fetch its
// assigned loopback port + the upstream URL the operator typed in the
// dashboard, then exec-s `chisel client … R:<port>:<host>:<port>`. This is
// what lets us keep the dashboard textbox as the single user-facing config
// and the docker command generic.
//
// Mounted BEFORE the regular auth middleware in src/index.ts.

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { tunnelsService } from './service';
import { pool } from '../infrastructure/database';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { log } from '../infrastructure/logging';

export const tunnelsCustomerRouter = Router();

const secretClient = new SecretManagerServiceClient();

interface TunnelTokenAuthContext {
  tenantPrefix: string;
  deploymentId: string;
  tenantId: string;
  loopbackPort: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    tunnelTokenAuth?: TunnelTokenAuthContext;
  }
}

/**
 * Validate the per-tenant tunnel token sent by the customer container.
 *
 * Headers:
 *   - Authorization: Bearer <tk_…>   (the tunnel token issued at deployment-create)
 *   - X-Tunnel-Prefix: <tenant-prefix>
 *
 * Checks the token value against ALL ENABLED versions of the
 * mcp-tunnel-token-{prefix} secret, so the 5-minute rotation grace window
 * keeps working without us tracking "current" vs "previous" here.
 */
async function tunnelTokenAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const prefix = req.header('x-tunnel-prefix');
  const authz = req.header('authorization') || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(authz);

  if (!prefix || !bearer) {
    res.status(401).json({ error: 'Missing X-Tunnel-Prefix or Authorization header' });
    return;
  }
  const token = bearer[1].trim();

  try {
    const deployment = await tunnelsService.getDeploymentByPrefix(prefix);
    if (!deployment) {
      res.status(401).json({ error: 'Unknown tunnel prefix' });
      return;
    }

    const projectId = process.env.GCP_PROJECT_ID;
    if (!projectId) {
      res.status(503).json({ error: 'Tunnel customer endpoint not configured' });
      return;
    }

    // Iterate ENABLED versions only — disabled = grace-window-expired prior versions.
    const [versions] = await secretClient.listSecretVersions({
      parent: `projects/${projectId}/secrets/${deployment.tunnelTokenSecretName}`,
      filter: 'state:ENABLED',
    });

    let matched = false;
    for (const version of versions ?? []) {
      if (!version.name) continue;
      try {
        const [accessed] = await secretClient.accessSecretVersion({ name: version.name });
        const value = accessed.payload?.data?.toString();
        if (!value) continue;
        if (
          Buffer.byteLength(token) === Buffer.byteLength(value) &&
          crypto.timingSafeEqual(Buffer.from(token), Buffer.from(value))
        ) {
          matched = true;
          break;
        }
      } catch (err) {
        log.warn({ err, version: version.name }, 'Failed to read tunnel token version');
      }
    }

    if (!matched) {
      res.status(401).json({ error: 'Invalid tunnel token' });
      return;
    }

    req.tunnelTokenAuth = {
      tenantPrefix: deployment.tenantPrefix,
      deploymentId: deployment.id,
      tenantId: deployment.tenantId,
      loopbackPort: deployment.loopbackPort,
    };
    next();
  } catch (err) {
    log.error({ err }, 'tunnelTokenAuth failed');
    res.status(500).json({ error: 'Auth check failed' });
  }
}

/**
 * GET /api/customer/tunnel-config
 *
 * Returns the runtime configuration the customer-side image needs to exec
 * `chisel client … R:<port>:<host>:<port>`:
 *
 * Response:
 *   { ready: true,  loopbackPort, upstreamHost, upstreamPort }
 *   { ready: false }                                              ← no route configured yet
 *
 * The customer image is expected to poll this on a loop (every few seconds)
 * so dashboard changes propagate without a docker restart.
 */
tunnelsCustomerRouter.get('/customer/tunnel-config', tunnelTokenAuth, async (req: Request, res: Response) => {
  const ctx = req.tunnelTokenAuth!;
  try {
    // 1:1 model: at most one route per deployment.
    const result = await pool.query(
      `SELECT upstream_url FROM mcp_tunnel_routes WHERE deployment_id = $1 LIMIT 1`,
      [ctx.deploymentId],
    );
    if (result.rows.length === 0) {
      res.status(200).json({ ready: false });
      return;
    }

    const upstreamUrl: string = result.rows[0].upstream_url;
    const parsed = parseUpstream(upstreamUrl);
    if (!parsed) {
      res.status(500).json({ error: 'Invalid upstream URL stored for this tunnel' });
      return;
    }

    res.status(200).json({
      ready: true,
      loopbackPort: ctx.loopbackPort,
      upstreamHost: parsed.host,
      upstreamPort: parsed.port,
    });
  } catch (err) {
    log.error({ err, deploymentId: ctx.deploymentId }, 'Failed to load tunnel-config');
    res.status(500).json({ error: 'Failed to load tunnel config' });
  }
});

function parseUpstream(raw: string): { host: string; port: number } | null {
  try {
    const u = new URL(raw);
    const host = u.hostname;
    const port = u.port
      ? Number(u.port)
      : u.protocol === 'https:'
        ? 443
        : u.protocol === 'http:'
          ? 80
          : NaN;
    if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return { host, port };
  } catch {
    return null;
  }
}
