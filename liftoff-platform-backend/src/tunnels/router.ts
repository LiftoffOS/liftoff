// Tunnels REST API Router.
//
// Surfaces:
//   - /api/tunnel-deployments     CRUD over deployments + token rotation + deploy artifact
//   - /api/tunnel-routes          CRUD over routes within a deployment
//
// The plaintext tunnel token is included in the create + rotate responses
// only — never in any list or get response. Customers who lose the token
// must rotate it.
//
// Auth: every endpoint is gated by `tenantAuthMiddleware('manageConnectors')`
// (read paths use `viewDashboard`). The middleware also publishes the
// resolved accountId via `(req as any).actorAccountId`, which `auditCtx(req)`
// reads to set `audit_log.user_id` correctly (firebase UID would otherwise
// be NULLed by the buffered flush's UUID validation).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { tunnelsService } from './service';
import { log, logAudit } from '../infrastructure/logging';
import { tenantAuthMiddleware } from '../infrastructure/middleware';
import { auditCtx } from '../infrastructure/audit-context';
import type { TunnelRoute, TunnelDeployment, CreateTunnelDeploymentResult } from './types';

export const tunnelsRouter = Router();

function pickRouteAuditFields(route: TunnelRoute): Record<string, unknown> {
  return {
    deploymentId: route.deploymentId,
    subdomain: route.subdomain,
    publicUrl: route.publicUrl,
    upstreamUrl: route.upstreamUrl,
  };
}

function pickDeploymentAuditFields(d: TunnelDeployment): Record<string, unknown> {
  return {
    name: d.name,
    tenantPrefix: d.tenantPrefix,
    loopbackPort: d.loopbackPort,
  };
}

const dnsLabel = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const httpsUrl = /^https?:\/\//;

// E1 note — the SSRF guard in src/common/url-guard.ts is deliberately NOT
// applied to `upstreamUrl`, and that is not an oversight.
//
// A tunnel upstream is dialled by the CUSTOMER's own tunnel-client container,
// inside their network (see customer-router's /tunnel-config, which hands the
// host and port back to that container). Reaching a private address is the
// entire purpose: the feature exists to expose an internal service that has no
// public address. Blocking RFC1918 here would leave the feature intact in name
// and useless in practice.
//
// What IS guarded is the platform-issued `public_url` these routes derive,
// because that one is ours, we serve it, and it is published into the runtime's
// tenant allowlist — see internal-api/mcp-allowlist-router.ts.

const createDeploymentSchema = z.object({
  name: z.string().min(1).max(255),
  tenantPrefix: z
    .string()
    .min(3)
    .max(63)
    .regex(dnsLabel, 'tenantPrefix must be a DNS-safe label')
    .optional(),
});

const createRouteSchema = z.object({
  deploymentId: z.string().uuid(),
  upstreamUrl: z.string().max(2000).regex(httpsUrl, 'upstreamUrl must be an http(s) URL'),
});

const updateRouteSchema = z.object({
  upstreamUrl: z.string().max(2000).regex(httpsUrl).optional(),
});

// ---- Deployments -----------------------------------------------------------

tunnelsRouter.get(
  '/tunnel-deployments',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    try {
      const deployments = await tunnelsService.listDeployments(tenantId);
      res.json({ deployments });
    } catch (error) {
      log.error({ error }, 'Failed to list tunnel deployments');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

tunnelsRouter.get(
  '/tunnel-deployments/:id',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    try {
      const deployment = await tunnelsService.getDeployment(tenantId, req.params.id);
      if (!deployment) {
        return res.status(404).json({ error: 'Tunnel deployment not found' });
      }
      res.json(deployment);
    } catch (error) {
      log.error({ error }, 'Failed to get tunnel deployment');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

tunnelsRouter.post(
  '/tunnel-deployments',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    const parseResult = createDeploymentSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }
    try {
      const result: CreateTunnelDeploymentResult = await tunnelsService.createDeployment({
        tenantId,
        name: parseResult.data.name,
        tenantPrefix: parseResult.data.tenantPrefix,
      });
      logAudit('tunnel.deployment_created', auditCtx(req), {
        resourceType: 'tunnel_deployment',
        resourceId: result.deployment.id,
        newState: pickDeploymentAuditFields(result.deployment),
      });
      res.status(201).json(result);
    } catch (error) {
      log.error({ error }, 'Failed to create tunnel deployment');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

tunnelsRouter.delete(
  '/tunnel-deployments/:id',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    try {
      const prior = await tunnelsService.getDeployment(tenantId, req.params.id);
      const ok = await tunnelsService.deleteDeployment(tenantId, req.params.id);
      if (!ok) return res.status(404).json({ error: 'Tunnel deployment not found' });
      logAudit('tunnel.deployment_deleted', auditCtx(req), {
        resourceType: 'tunnel_deployment',
        resourceId: req.params.id,
        previousState: prior ? pickDeploymentAuditFields(prior) : undefined,
      });
      res.status(204).end();
    } catch (error) {
      log.error({ error }, 'Failed to delete tunnel deployment');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

tunnelsRouter.get(
  '/tunnel-deployments/:id/deploy-artifact',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    try {
      const artifact = await tunnelsService.getDeployArtifact(tenantId, req.params.id);
      if (!artifact) return res.status(404).json({ error: 'Tunnel deployment not found' });
      res.json(artifact);
    } catch (error) {
      log.error({ error }, 'Failed to fetch tunnel deploy artifact');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

tunnelsRouter.post(
  '/tunnel-deployments/:id/rotate-token',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    try {
      const rotated = await tunnelsService.rotateToken(tenantId, req.params.id);
      if (!rotated) return res.status(404).json({ error: 'Tunnel deployment not found' });
      logAudit('tunnel.token_rotated', auditCtx(req), {
        resourceType: 'tunnel_deployment',
        resourceId: req.params.id,
        // No `rotatedAt` — the audit row's own `timestamp` column is the
        // authoritative rotation moment.
        newState: {},
      });
      res.json(rotated);
    } catch (error) {
      log.error({ error }, 'Failed to rotate tunnel token');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

// ---- Routes ----------------------------------------------------------------

tunnelsRouter.get(
  '/tunnel-routes',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    try {
      const deploymentId = (req.query.deploymentId as string) || undefined;
      const onlyUnbound = req.query.unbound === 'true';
      const routes = onlyUnbound
        ? await tunnelsService.listUnboundRoutes(tenantId)
        : await tunnelsService.listRoutes(tenantId, deploymentId);
      res.json({ routes });
    } catch (error) {
      log.error({ error }, 'Failed to list tunnel routes');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

tunnelsRouter.post(
  '/tunnel-routes',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    const parseResult = createRouteSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }
    try {
      const route = await tunnelsService.createRoute(tenantId, parseResult.data);
      if (!route) return res.status(404).json({ error: 'Tunnel deployment not found' });
      logAudit('tunnel.route_created', auditCtx(req), {
        resourceType: 'tunnel_route',
        resourceId: route.id,
        newState: pickRouteAuditFields(route),
      });
      res.status(201).json(route);
    } catch (error) {
      log.error({ error }, 'Failed to create tunnel route');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

tunnelsRouter.patch(
  '/tunnel-routes/:id',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    const parseResult = updateRouteSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }
    try {
      const prior = await tunnelsService.getRoute(tenantId, req.params.id);
      const route = await tunnelsService.updateRoute(tenantId, req.params.id, parseResult.data);
      if (!route) return res.status(404).json({ error: 'Tunnel route not found' });
      logAudit('tunnel.route_updated', auditCtx(req), {
        resourceType: 'tunnel_route',
        resourceId: req.params.id,
        previousState: prior ? pickRouteAuditFields(prior) : undefined,
        newState: pickRouteAuditFields(route),
      });
      res.json(route);
    } catch (error) {
      log.error({ error }, 'Failed to update tunnel route');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

tunnelsRouter.delete(
  '/tunnel-routes/:id',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    try {
      const prior = await tunnelsService.getRoute(tenantId, req.params.id);
      const ok = await tunnelsService.deleteRoute(tenantId, req.params.id);
      if (!ok) return res.status(404).json({ error: 'Tunnel route not found' });
      logAudit('tunnel.route_deleted', auditCtx(req), {
        resourceType: 'tunnel_route',
        resourceId: req.params.id,
        previousState: prior ? pickRouteAuditFields(prior) : undefined,
      });
      res.status(204).end();
    } catch (error) {
      log.error({ error }, 'Failed to delete tunnel route');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

// Internal service-auth endpoints used by the terminator + Cloud Scheduler
// live in `./internal-router.ts` so they can be mounted BEFORE
// authMiddleware in src/index.ts.
