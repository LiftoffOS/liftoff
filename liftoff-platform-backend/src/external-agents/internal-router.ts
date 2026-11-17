// External Agents Internal Service Router
// Handles Cloud Scheduler calls for health checks (EA-001) and token refresh (EA-002)

import { Router, Request, Response, RequestHandler } from 'express';
import { runHealthChecks } from './health-check-service';
import { refreshExpiringTokens } from './credential-refresh-service';
import { ExternalAgentService } from './service';
import { log } from '../infrastructure/logging';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { requireSchedulerOidc } from '../infrastructure/scheduler-auth';

const externalAgentService = new ExternalAgentService();

export const externalAgentInternalRouter = Router();

const serviceAuthMiddleware = verifyServiceAuth();

// The two sweeps below are invoked by Cloud Scheduler, which authenticates with
// a Google-issued OIDC bearer token; verifyServiceAuth() only understands the
// X-Service-Auth shared token. Both credentials are accepted so the scheduler
// and any service-to-service caller can each reach these routes.
const schedulerOidcMiddleware = requireSchedulerOidc({
  // Fails closed when unset rather than defaulting to the prod URL: a dev
  // backend that accepts prod-minted tokens is a cross-environment trust bug.
  expectedAudience: () => process.env.BACKEND_URL ?? '',
  allowedEmails: () => [process.env.CLOUD_SCHEDULER_SA_EMAIL ?? ''],
});

// Dispatches on the credential the request actually carries; neither middleware
// is safe to run twice, so they cannot simply be chained.
const schedulerOrServiceAuth: RequestHandler = (req, res, next) => {
  const authz = req.headers['authorization'];
  if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
    return schedulerOidcMiddleware(req, res, next);
  }
  return serviceAuthMiddleware(req, res, next);
};

// POST /api/internal/external-agents/health-check
// Check health of all connected external agents (called by Cloud Scheduler every 15 min)
externalAgentInternalRouter.post(
  '/internal/external-agents/health-check',
  schedulerOrServiceAuth,
  async (req: Request, res: Response) => {
    try {
      const startTime = Date.now();
      await runHealthChecks();
      const duration = Date.now() - startTime;

      log.info({ durationMs: duration }, 'External agent health checks completed');
      res.json({ success: true, durationMs: duration });
    } catch (error) {
      log.error({ error }, 'Failed to run external agent health checks');
      res.status(500).json({ error: 'Health check failed' });
    }
  }
);

// POST /api/internal/external-agents/refresh-tokens
// Refresh OAuth tokens for external agents (called by Cloud Scheduler every hour)
externalAgentInternalRouter.post(
  '/internal/external-agents/refresh-tokens',
  schedulerOrServiceAuth,
  async (req: Request, res: Response) => {
    try {
      const startTime = Date.now();
      await refreshExpiringTokens();
      const duration = Date.now() - startTime;

      log.info({ durationMs: duration }, 'External agent token refresh completed');
      res.json({ success: true, durationMs: duration });
    } catch (error) {
      log.error({ error }, 'Failed to refresh external agent tokens');
      res.status(500).json({ error: 'Token refresh failed' });
    }
  }
);

// GET /api/external-agents/for-internal-agent (service-auth)
// Same endpoint as the Firebase-auth version in router.ts, but accessible
// with X-Service-Auth for tenant-runtime service-to-service calls.
// Mounted BEFORE authMiddleware via externalAgentInternalRouter.
externalAgentInternalRouter.get(
  '/external-agents/for-internal-agent',
  serviceAuthMiddleware,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId as string;
      const internalAgentId = req.query.internalAgentId as string;

      if (!tenantId || !internalAgentId) {
        return res.status(400).json({ error: 'tenantId and internalAgentId required' });
      }

      const agents = await externalAgentService.getForInternalAgent(tenantId, internalAgentId);
      res.json({ agents });
    } catch (error) {
      log.error({ error }, 'Failed to get external agents for internal agent');
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// GET /api/external-agents/by-id (service-auth)
// Fetch a single external agent's full config (including rawMcpTools, transport, auth).
// Used by the tenant runtime tool gateway to resolve an external agent at execution
// time. The Firebase-auth user-facing endpoint at /api/external-agents/:id does NOT
// have an equivalent service-auth path on the user router — this is the only one.
//
// IMPORTANT: query params, not URL params, so the route doesn't collide with any
// future user-facing /:id pattern on the same prefix.
//
// The `id` query param MUST be a UUID. The external_agents.id column is a UUID
// type, so passing a non-UUID string causes Postgres to throw 22P02
// (invalid_text_representation). We catch that case explicitly here and return
// a 400 with a clear error message rather than letting it surface as a 500 —
// otherwise a runtime bug that sends an alias instead of a UUID produces an
// opaque "Failed to fetch external agent by id" 500 response that's hard to
// trace back to the actual mistake.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

externalAgentInternalRouter.get(
  '/external-agents/by-id',
  serviceAuthMiddleware,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId as string;
      const id = req.query.id as string;

      if (!tenantId || !id) {
        return res.status(400).json({ error: 'tenantId and id required' });
      }

      if (!UUID_REGEX.test(id)) {
        log.warn(
          { tenantId, id },
          'Rejecting external-agents/by-id request: id is not a UUID. ' +
            'This usually means the caller sent a connector alias instead of the canonical platform UUID.',
        );
        return res.status(400).json({
          error: `id must be a UUID, got '${id}'. The caller likely sent an alias instead of the platform external_agents.id.`,
        });
      }

      if (!UUID_REGEX.test(tenantId)) {
        return res.status(400).json({ error: `tenantId must be a UUID, got '${tenantId}'` });
      }

      const agent = await externalAgentService.get(id, tenantId);
      if (!agent) {
        return res.status(404).json({ error: 'External agent not found' });
      }

      // 1b: the effect class per tool, appended by the runtime to the tool's
      // categories as a declared class. Omitted (empty) while the classifier
      // kill is off, so the runtime maps the payload with nothing appended.
      const toolEffectClasses = await externalAgentService.effectClassesFor(agent);
      res.json({ ...agent, toolEffectClasses });
    } catch (error) {
      log.error({ error, tenantId: req.query.tenantId, id: req.query.id }, 'Failed to fetch external agent by id');
      res.status(500).json({ error: (error as Error).message });
    }
  }
);
