// Internal (service-auth) operator surface for self-wakes. Called by platform-backend's
// tenant-admin operator endpoint (which adds the human authz + audit). Lists / cancels live wakes.
// Non-RLS infra table, accessed with explicit tenant_id filters.

import { Router, type Request, type Response } from 'express';
import { agentScheduledInvocationsRepo } from './agent-scheduled-invocations-repo';
import { wakeWaitSetRepo } from './wake-wait-set-repo';
import { logger } from '../infrastructure/logging';

export const wakeOperatorInternalRouter = Router();

function requireInternal(req: Request, res: Response): boolean {
  if (req.headers['x-internal-secret'] !== process.env.INTERNAL_SERVICE_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// GET /api/internal/wakes?tenantId=&agentId=
wakeOperatorInternalRouter.get('/', async (req: Request, res: Response) => {
  if (!requireInternal(req, res)) return;
  const tenantId = String(req.query.tenantId ?? '');
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
  const agentId = req.query.agentId ? String(req.query.agentId) : null;
  try {
    // Standalone wakes (members are excluded — they surface via their parent) + wait-set parents,
    // tagged wake_kind='waitset' so the caller presents + cost-enriches both uniformly.
    const [wakes, waitSets] = await Promise.all([
      agentScheduledInvocationsRepo.listWakesForOperator(tenantId, agentId),
      wakeWaitSetRepo.listForOperator(tenantId, agentId),
    ]);
    return res.json({ wakes: [...wakes, ...waitSets.map((w) => ({ ...w, wake_kind: 'waitset' }))] });
  } catch (err) {
    logger.error('operator list wakes failed', { tenantId, error: (err as Error).message });
    return res.status(500).json({ error: 'list failed' });
  }
});

// POST /api/internal/wakes/:id/cancel   body { tenantId }
wakeOperatorInternalRouter.post('/:id/cancel', async (req: Request, res: Response) => {
  if (!requireInternal(req, res)) return;
  const tenantId = String((req.body as { tenantId?: string } | undefined)?.tenantId ?? '');
  const wakeId = req.params.id;
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
  try {
    const { reactiveSubscriptionRepo } = await import('../reactive-subscriptions/repository');
    // Try a standalone wake first; if the id is a wait-set, cancel the parent + all its members.
    let cancelled = await agentScheduledInvocationsRepo.cancelWakeById(tenantId, wakeId);
    if (cancelled) {
      await reactiveSubscriptionRepo.deleteOneShotByBoundInvocation(wakeId).catch(() => {});
    } else if (await wakeWaitSetRepo.cancelById(tenantId, wakeId)) {
      cancelled = true;
      const members = await agentScheduledInvocationsRepo.cancelWaitSetMembers(wakeId);
      for (const m of members) {
        await reactiveSubscriptionRepo.deleteOneShotByBoundInvocation(m.id as string).catch(() => {});
      }
    }
    logger.info('operator cancelled wake', { tenantId, wakeId, cancelled });
    return res.json({ cancelled });
  } catch (err) {
    logger.error('operator cancel wake failed', { tenantId, wakeId, error: (err as Error).message });
    return res.status(500).json({ error: 'cancel failed' });
  }
});
