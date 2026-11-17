// Usage Ledger Service
// Per Section 1: Tenant runtime owns usage ledger
// Per Section 13: Tenant runtime owns usage events, action-credit ledger
// Per Section 20 Phase 4: Usage aggregation, forecast snapshots, operator visibility

import { Router } from 'express';
import { UsageLedgerService } from './service';
import { AggregationService } from './aggregation-service';
import { AggregationPeriod } from './aggregation-types';
import { getPool } from '../infrastructure/database';
import { requireServiceAuth } from '../security/service-auth';
import { scrubLogger } from '../observability/scrub-logger';

export const usageLedgerRouter = Router();
const service = new UsageLedgerService();
const aggregationService = new AggregationService();

// Cross-service usage-ledger feed for the platform-backend ingester.
// Service-auth gated; returns events newer than the given cursor in created_at order.
//
// WS-6.4 — under pool pressure, return 503 + Retry-After instead of 500 so
// the PB ingester back-off contract triggers cleanly. Bounded by a 30s
// statement_timeout to keep one slow query from blocking the pool.
// `tenantId` is REQUIRED, and the query filters on it.
//
// It did not, and the omission was not cosmetic. This database is shared by
// every tenant on the runtime, so an unfiltered feed returned all of them. The
// platform backend consumes this per tenant — it resolves a per-tenant runtime
// URL, keeps a per-tenant cursor (`usage_ledger_<tenantId>`), and its own header
// comment says it "polls each tenant's" feed — so every one of those callers was
// handed the same global stream.
//
// The damage was in the translation, not the read. The ingester maps each
// event's `agent_id` from the runtime id space into the control-plane one using
// the mapping of the tenant it is CURRENTLY iterating, then writes the row under
// the EVENT's tenant. With a global feed those are different tenants, so a
// lookup in the wrong tenant's map misses and falls through to pass-through,
// writing a runtime id into a column that must hold `internal_agents.id`
// (INV-TR-010 / ADR-039).
//
// Requiring the parameter rather than defaulting to global is deliberate. A
// caller that forgets it gets a 400, which the ingester treats as a failed page:
// it stops, does not advance its cursor, and resumes cleanly once fixed. The
// silent alternative is what produces bad rows.
usageLedgerRouter.get('/feed', requireServiceAuth(), async (req, res) => {
  const tenantId = req.query.tenantId as string | undefined;
  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId required' });
  }
  const cursor = req.query.cursor as string | undefined;
  const limit  = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const startTime = Date.now();

  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL statement_timeout = '30s'`);
      const rows = await client.query(
        `SELECT id, tenant_id, agent_id, workflow_id, action_id,
                event_type, credits, metadata, created_at
         FROM usage_events
         WHERE tenant_id = $3
           AND ($1::timestamptz IS NULL OR created_at > $1)
         ORDER BY created_at ASC
         LIMIT $2`,
        [cursor ?? null, limit, tenantId],
      );
      res.json({
        events: rows.rows,
        nextCursor: rows.rows.at(-1)?.created_at ?? cursor ?? null,
        hasMore: rows.rows.length === limit,
        latency_ms: Date.now() - startTime,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('statement_timeout')) {
      scrubLogger.warn({ event: 'pool_saturation_503', endpoint: '/api/usage-ledger/feed', pool_name: 'default' });
      res.set('Retry-After', '30');
      res.status(503).json({ error: 'feed query timed out; retry with smaller window' });
      return;
    }
    if (msg.includes('connection') || msg.includes('Pool')) {
      scrubLogger.warn({ event: 'pool_saturation_503', endpoint: '/api/usage-ledger/feed', pool_name: 'default' });
      res.set('Retry-After', '5');
      res.status(503).json({ error: 'pool saturation; retry' });
      return;
    }
    res.status(500).json({ error: msg });
  }
});

// Record usage event
usageLedgerRouter.post('/events', async (req, res) => {
  await service.recordUsage(req.body);
  res.status(201).json({ status: 'recorded' });
});

// Get current burn state (reporting snapshot; decides nothing)
usageLedgerRouter.get('/burn/:tenantId', async (req, res) => {
  const burn = await service.getBurnState(req.params.tenantId);
  res.json(burn);
});

// GET /credits/:tenantId is gone. It served burn_state.remaining_credits — a
// never-refilled counter over a mixed-unit column — as if it were a balance.
// Remaining spend is the control plane's `billing_controls` / OU buckets, and
// that is the only place it may be read from.

// Process refund/reversal
usageLedgerRouter.post('/refund', async (req, res) => {
  await service.processRefund(req.body);
  res.json({ status: 'refunded' });
});

// ============================================
// Per Section 20 Phase 4: Usage Aggregation APIs
// ============================================

// Run aggregation for a tenant
usageLedgerRouter.post('/aggregation/:tenantId/run', async (req, res) => {
  const { tenantId } = req.params;
  const { period, periodStart, periodEnd } = req.body;

  const snapshot = await aggregationService.runAggregation(
    tenantId,
    period as AggregationPeriod,
    new Date(periodStart),
    new Date(periodEnd)
  );

  res.json(snapshot);
});

// Run hourly aggregation
usageLedgerRouter.post('/aggregation/:tenantId/hourly', async (req, res) => {
  const snapshot = await aggregationService.runHourlyAggregation(req.params.tenantId);
  res.json(snapshot);
});

// Run daily aggregation
usageLedgerRouter.post('/aggregation/:tenantId/daily', async (req, res) => {
  const snapshot = await aggregationService.runDailyAggregation(req.params.tenantId);
  res.json(snapshot);
});

// Run scheduled aggregation for all tenants (called by Cloud Scheduler)
usageLedgerRouter.post('/aggregation/scheduled/:period', async (req, res) => {
  const { period } = req.params;
  await aggregationService.runScheduledAggregation(period as AggregationPeriod);
  res.json({ status: 'completed' });
});

// ============================================
// Per Section 20 Phase 4: Forecast APIs
// ============================================

// Generate forecast for a tenant
usageLedgerRouter.post('/forecast/:tenantId/generate', async (req, res) => {
  const forecast = await aggregationService.generateForecast(req.params.tenantId);
  res.json(forecast);
});

// ============================================
// Per Section 20 Phase 4: Operator Visibility APIs
// ============================================

// Get operator dashboard for a tenant
usageLedgerRouter.get('/dashboard/:tenantId', async (req, res) => {
  const dashboard = await aggregationService.getOperatorDashboard(req.params.tenantId);
  res.json(dashboard);
});
