// Agent Lifecycle Service
// Per Section 8: Agent lifecycle states

import { Router, type Request, type Response } from 'express';
import { AgentLifecycleService } from './service';
import { verifyOidcToken } from '../infrastructure/oidc';
import { logger } from '../infrastructure/logging';
import { forEachTenant } from '../infrastructure/tenant-registry';
import { reconcileTenant } from './canonical-reconciler';

export const agentLifecycleRouter = Router();
const service = new AgentLifecycleService();

agentLifecycleRouter.post('/', async (req, res) => {
  const agent = await service.create(req.body);
  res.status(201).json(agent);
});

agentLifecycleRouter.get('/:id', async (req, res) => {
  const agent = await service.getById(req.params.id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  res.json(agent);
});

// Per Section 8: Lifecycle transitions
agentLifecycleRouter.post('/:id/activate', async (req, res) => {
  await service.activate(req.params.id);
  res.json({ status: 'active' });
});

agentLifecycleRouter.post('/:id/pause', async (req, res) => {
  await service.pause(req.params.id);
  res.json({ status: 'paused' });
});

agentLifecycleRouter.post('/:id/archive', async (req, res) => {
  await service.archive(req.params.id);
  res.json({ status: 'archived' });
});

// POST /api/agents/reconcile
// Called by Cloud Scheduler every 5 min. OIDC-authenticated by the
// tenant-runtime service account (same SA pattern as scheduled-invoke).
// Triggers a full reconcile-against-canonical for this tenant.
//
// Trust model: the OIDC token confirms the caller is Cloud Scheduler in this
// project. The tick covers EVERY tenant in this runtime's database, because a
// runtime serves as many tenants as its database holds rows — a reconcile that
// resolved "the" tenant would leave every other tenant's agents drifting from
// canonical indefinitely, and report success while doing it.
//
// Tenant ids come from the `tenants` table, never from process.env.TENANT_ID:
// that variable holds the tenant SLUG (`liftoffos`), and PB's canonical-agents
// endpoint validates its query param as a UUID, so a slug is a 400 on every
// tick and the reconciler errors silently.
agentLifecycleRouter.post('/reconcile', async (req: Request, res: Response) => {
  const ok = await verifyOidcToken(req);
  if (!ok) return res.status(403).json({ error: 'Unauthorized: invalid OIDC token' });

  try {
    // Per-tenant failures are collected rather than thrown: one tenant whose
    // reconcile fails must not stop the tenants after it in the ordering.
    const fanout = await forEachTenant('canonical-reconcile', (tenantId) =>
      reconcileTenant(tenantId));
    logger.info(
      { tenants: fanout.tenants, ok: fanout.ok, failed: fanout.failed },
      'canonical reconcile complete',
    );
    return res.json(fanout);
  } catch (err) {
    // Only reached when the tenant list itself is unreadable — a per-tenant
    // reconcile failure is already contained inside the fan-out.
    logger.error({ err: (err as Error).message }, 'canonical reconcile failed');
    return res.status(500).json({ error: 'reconcile_failed' });
  }
});
