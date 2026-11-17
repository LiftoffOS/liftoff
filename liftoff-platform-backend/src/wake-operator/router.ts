// Operator surface for self-wakes. Tenant-admin (human) auth via tenantAuthMiddleware;
// proxies to TR's internal /api/internal/wakes for the actual state. Cancels are audited.

import { Router, type Request, type Response } from 'express';
import { requireMinRole } from '../infrastructure/tenant-role-auth';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { agentAuditLogsService } from '../agent-audit-logs';
import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

export const wakeOperatorRouter = Router();
// CALLED, not passed. `tenantAuthMiddleware` is a factory: handing Express the
// factory itself meant it ran as middleware, returned the real handler, and that
// handler was discarded — nothing authorized and nothing called next(), so every
// request here hung instead of being answered. requireMinRole IS the handler and
// states the floor the header above always claimed.
wakeOperatorRouter.use(requireMinRole('admin'));

/** Attach the customer-facing cost of each wake's originating turn: Operating Units consumed +
 *  customer-rated USD. Sourced from billing_spend_events (keyed by invocation_id) — the OU-native,
 *  bucket-rated figures the customer is billed on. Never the raw provider cost. Best-effort: a wake
 *  with no billing row (or a lookup failure) simply reports zero. */
async function enrichWithOuCost(
  tenantId: string, wakes: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const invIds = Array.from(new Set(
    wakes.map((w) => w.scheduled_by_invocation_id).filter((v): v is string => typeof v === 'string'),
  ));
  if (invIds.length === 0) return wakes.map((w) => ({ ...w, ouConsumed: 0, customerCostUsd: 0 }));
  const byInv = new Map<string, { ou: number; usd: number }>();
  try {
    const { rows } = await withTenantScope(tenantId, (c) => c.query<{ invocation_id: string; ou_consumed: string; customer_cost_usd: string }>(
      `SELECT invocation_id, ou_consumed, customer_cost_usd
         FROM billing_spend_events
        WHERE tenant_id = $1 AND invocation_id = ANY($2::text[])`,
      [tenantId, invIds],
    ));
    for (const r of rows) byInv.set(r.invocation_id, { ou: Number(r.ou_consumed), usd: Number(r.customer_cost_usd) });
  } catch (err) {
    logger.warn('operator wake cost enrichment failed; reporting zero', { tenantId, error: (err as Error).message });
  }
  return wakes.map((w) => {
    const hit = typeof w.scheduled_by_invocation_id === 'string' ? byInv.get(w.scheduled_by_invocation_id) : undefined;
    return { ...w, ouConsumed: hit?.ou ?? 0, customerCostUsd: hit?.usd ?? 0 };
  });
}

// GET /api/wakes?agentId=  — list a tenant's live wakes (operator observability), each annotated with
// its Operating-Unit / customer-rated cost.
wakeOperatorRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId ? String(req.query.tenantId) : undefined;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenant context' });
  const agentId = req.query.agentId ? String(req.query.agentId) : null;
  try {
    const { wakes } = await tenantRuntimeClient.listWakes(tenantId, agentId);
    const enriched = await enrichWithOuCost(tenantId, (wakes as Array<Record<string, unknown>>) ?? []);
    return res.json({ wakes: enriched });
  } catch (err) {
    logger.error('operator list wakes failed', { tenantId, error: (err as Error).message });
    return res.status(502).json({ error: 'runtime unavailable' });
  }
});

// POST /api/wakes/:id/cancel — operator cancel; audited.
wakeOperatorRouter.post('/:id/cancel', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId ? String(req.query.tenantId) : undefined;
  const userId = (req as { user?: { uid?: string } }).user?.uid;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenant context' });
  const wakeId = req.params.id;
  try {
    const { cancelled } = await tenantRuntimeClient.cancelWake(tenantId, wakeId);
    void agentAuditLogsService.insertAuditLog({
      tenantId,
      action: 'wake_cancelled_by_operator',
      inputArgs: { wakeId },
      outcome: cancelled ? 'success' : 'noop',
      triggeredBy: `operator:${userId ?? 'unknown'}`,
    } as unknown as Parameters<typeof agentAuditLogsService.insertAuditLog>[0]).catch(() => undefined);
    return res.json({ cancelled });
  } catch (err) {
    logger.error('operator cancel wake failed', { tenantId, wakeId, error: (err as Error).message });
    return res.status(502).json({ error: 'runtime unavailable' });
  }
});
