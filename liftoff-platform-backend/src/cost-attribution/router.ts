// Cost Attribution REST API
//
// GET /api/cost-attribution/tenants/:tenantId/summary
//   ?since=&until=   — tenant-level cost breakdown
//
// GET /api/cost-attribution/tenants/:tenantId/agents
//   ?since=&until=   — per-agent cost breakdown list
//
// GET /api/cost-attribution/tenants/:tenantId/agents/:agentId
//   ?since=&until=   — single-agent cost breakdown
//
// GET /api/cost-attribution/tenants/:tenantId/operating-units
//   ?since=&until=   — OU consumption (customer-visible; no cost_usd exposed)

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getTenantCostSummary,
  getAgentCostSummary,
  getAllAgentsCosts,
  getActionCosts,
} from './attribution-service';
import { runAllIngesters } from './ingestion/ingest-runner';
import { getOperatingUnitsForPeriod } from '../billing/operating-unit-service';
import { log } from '../infrastructure/logging';
import { verifyTenantOwnership } from '../infrastructure/tenant-role-auth';

export const costAttributionRouter = Router({ mergeParams: true });

function parseDateParam(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(value);
  return isNaN(d.getTime()) ? fallback : d;
}

function defaultSince(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d;
}

// ── GET /api/cost-attribution/tenants/:tenantId/summary ───────────────

costAttributionRouter.get('/tenants/:tenantId/summary', verifyTenantOwnership, async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const since = parseDateParam(req.query['since'] as string, defaultSince());
  const until = parseDateParam(req.query['until'] as string, new Date());

  try {
    const summary = await getTenantCostSummary(tenantId, since, until);
    res.json({ tenantId, since, until, ...summary });
  } catch (err) {
    log.error({ error: (err as Error).message, tenantId }, 'Failed to get tenant cost summary');
    res.status(500).json({ error: 'Failed to retrieve cost summary' });
  }
});

// ── GET /api/cost-attribution/tenants/:tenantId/agents ────────────────

costAttributionRouter.get('/tenants/:tenantId/agents', verifyTenantOwnership, async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const since = parseDateParam(req.query['since'] as string, defaultSince());
  const until = parseDateParam(req.query['until'] as string, new Date());

  try {
    const agents = await getAllAgentsCosts(tenantId, since, until);
    res.json({ tenantId, since, until, agents });
  } catch (err) {
    log.error({ error: (err as Error).message, tenantId }, 'Failed to get per-agent costs');
    res.status(500).json({ error: 'Could not load costs by agent. Please try again.' });
  }
});

// ── GET /api/cost-attribution/tenants/:tenantId/actions ──────────────
//  ?agent_id=&since=&until=&limit=&cursor=

costAttributionRouter.get('/tenants/:tenantId/actions', verifyTenantOwnership, async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const agentId = (req.query['agent_id'] as string) || null;
  const since   = parseDateParam(req.query['since'] as string, defaultSince());
  const until   = parseDateParam(req.query['until'] as string, new Date());
  const limit   = parseInt(req.query['limit'] as string || '100', 10);
  const cursor  = (req.query['cursor'] as string) || null;

  try {
    const result = await getActionCosts(tenantId, agentId, since, until, limit, cursor);
    res.json({ tenantId, since, until, ...result });
  } catch (err) {
    log.error({ error: (err as Error).message, tenantId }, 'Failed to get action costs');
    res.status(500).json({ error: 'Failed to retrieve action costs' });
  }
});

// ── GET /api/cost-attribution/tenants/:tenantId/agents/:agentId ───────

costAttributionRouter.get('/tenants/:tenantId/agents/:agentId', verifyTenantOwnership, async (req: Request, res: Response) => {
  const { tenantId, agentId } = req.params;
  const since = parseDateParam(req.query['since'] as string, defaultSince());
  const until = parseDateParam(req.query['until'] as string, new Date());

  try {
    const summary = await getAgentCostSummary(tenantId, agentId, since, until);
    res.json({ tenantId, agentId, since, until, ...summary });
  } catch (err) {
    log.error({ error: (err as Error).message, tenantId, agentId }, 'Failed to get agent cost summary');
    res.status(500).json({ error: 'Could not load the cost summary. Please try again.' });
  }
});

// ── POST /api/internal/cost-attribution/ingest ───────────────────────
// Internal-only endpoint for triggering a manual ingestion run.
// Used by Cloud Scheduler and for on-demand backfill. Not exposed externally.

costAttributionRouter.post('/internal/ingest', async (_req: Request, res: Response) => {
  try {
    const stats = await runAllIngesters();
    log.info(stats as unknown as Record<string, unknown>, 'cost-attribution: manual ingest triggered via internal endpoint');
    res.json({ ok: true, stats });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'cost-attribution: manual ingest failed');
    res.status(500).json({ error: 'Ingest failed' });
  }
});

// ── GET /api/cost-attribution/tenants/:tenantId/operating-units ───────────────
// Customer-facing OU consumption. Returns OUs only — never exposes cost_usd,
// token counts, model names, or provider names.
//
// After PR 1 (OU-native billing): per-OU rates are tenant-specific and live on
// billing_controls (included/precommit/reload). Customers no longer see a
// single "price per OU"; the per-bucket rates are surfaced separately by
// /api/internal/billing/controls/:accountId/status when needed.

costAttributionRouter.get('/tenants/:tenantId/operating-units', verifyTenantOwnership, async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const since = parseDateParam(req.query['since'] as string, defaultSince());
  const until = parseDateParam(req.query['until'] as string, new Date());

  try {
    const result = await getOperatingUnitsForPeriod(tenantId, since, until);

    res.json({
      tenantId,
      since,
      until,
      totalOusConsumed:             result.totalOusConsumed,
      platformAnalyticsOusConsumed: result.platformAnalyticsOusConsumed,
      byAgent:                      result.byAgent.map(a => ({
        agentId:     a.agentId,
        agentName:   a.agentName,
        ousConsumed: a.ousConsumed,
      })),
    });
  } catch (err) {
    log.error({ error: (err as Error).message, tenantId }, 'Failed to get operating units');
    res.status(500).json({ error: 'Failed to retrieve operating units' });
  }
});
