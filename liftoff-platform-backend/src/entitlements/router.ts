// Entitlements Router
// Per Section 13: Entitlement snapshots, runtime-facing entitlement fields

import { Router } from 'express';
import { EntitlementService } from './service';
import { log, logAudit } from '../infrastructure/logging';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { withIdempotencyMiddleware } from '../infrastructure/idempotency-middleware';
import { tenantAuthMiddleware } from '../infrastructure/middleware';

export const entitlementsRouter = Router();
const service = new EntitlementService();

// Service-auth router for tenant-runtime to fetch entitlements
// Mounted BEFORE authMiddleware in index.ts
export const entitlementsServiceRouter = Router();

/** An entitlement still at version 1 this long after its last write has
 *  almost certainly never been updated by anything — not subscription
 *  activation, not a plan change, not a suspension. */
const STALE_SNAPSHOT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// PB has no prom-client; metrics are structured log lines Cloud Monitoring
// turns into log-based metrics — same convention as
// injection-detection/gating.ts here and TR's observability module.
function emitStaleSnapshotMetric(tenantId: string, version: number, ageMs: number): void {
  log.warn(
    {
      metric_name: 'entitlement_snapshot_stale',
      metric_kind: 'counter',
      metric_value: 1,
      tenant_id: tenantId,
      entitlement_version: version,
      entitlement_age_ms: ageMs,
    },
    'entitlements: serving a snapshot still at version 1 and over 30 days old',
  );
}

entitlementsServiceRouter.get('/tenant/:tenantId', verifyServiceAuth(), async (req, res, next) => {
  try {
    const entitlement = await service.getByTenantId(req.params.tenantId);
    if (!entitlement) {
      return res.status(404).json({ error: 'Entitlement not found' });
    }
    // A snapshot frozen at version 1 is the exact shape that let a dead
    // entitlement row gate execution for four months: every consumer treated it
    // as current because nothing ever said otherwise, and the runtime's
    // version-guarded cache refresh could never move past it. Serving one is
    // now a signal, so the next occurrence is a graph rather than archaeology.
    const ageMs = Date.now() - new Date(entitlement.updatedAt).getTime();
    if (entitlement.version <= 1 && ageMs > STALE_SNAPSHOT_AGE_MS) {
      emitStaleSnapshotMetric(req.params.tenantId, entitlement.version, ageMs);
    }
    res.json(entitlement);
  } catch (error) {
    next(error);
  }
});

// List all entitlements
entitlementsRouter.get('/', async (req, res, next) => {
  try {
    const entitlements = await service.listAll();
    res.json(entitlements);
  } catch (error) {
    next(error);
  }
});

// Get entitlement snapshot for a tenant
entitlementsRouter.get('/tenant/:tenantId', tenantAuthMiddleware('viewDashboard'), async (req, res, next) => {
  try {
    const entitlement = await service.getByTenantId(req.params.tenantId);
    if (!entitlement) {
      res.status(404).json({ error: 'Entitlement not found' });
      return;
    }
    res.json(entitlement);
  } catch (error) {
    next(error);
  }
});

// Update entitlement (triggers tenant.entitlement.updated event)
entitlementsRouter.put('/tenant/:tenantId', tenantAuthMiddleware('manageBilling'), withIdempotencyMiddleware({ endpoint: 'PUT /api/entitlements/tenant/:tenantId' }), async (req, res, next) => {
  try {
    const entitlement = await service.update(req.params.tenantId, req.body);

    logAudit('entitlement.updated', req.ctx, {
      tenantId: req.params.tenantId,
      entitlementId: entitlement.id,
      version: entitlement.version,
    });

    res.json(entitlement);
  } catch (error) {
    next(error);
  }
});

// Per Section 13: Entitlement snapshot endpoints for billing disputes

// Get snapshot history for a tenant
entitlementsRouter.get('/tenant/:tenantId/snapshots', tenantAuthMiddleware('viewDashboard'), async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
    const snapshots = await service.getSnapshotHistory(req.params.tenantId, limit);
    res.json(snapshots);
  } catch (error) {
    next(error);
  }
});

// Get entitlement state at a specific point in time
entitlementsRouter.get('/tenant/:tenantId/snapshots/at-time', tenantAuthMiddleware('viewDashboard'), async (req, res, next) => {
  try {
    const targetTime = req.query.time ? new Date(req.query.time as string) : new Date();
    const snapshot = await service.getEntitlementAtTime(req.params.tenantId, targetTime);
    if (!snapshot) {
      res.status(404).json({ error: 'No snapshot found for specified time' });
      return;
    }
    res.json(snapshot);
  } catch (error) {
    next(error);
  }
});

// Get snapshots for a billing period
entitlementsRouter.get('/tenant/:tenantId/snapshots/billing-period', tenantAuthMiddleware('viewDashboard'), async (req, res, next) => {
  try {
    const { periodStart, periodEnd } = req.query;
    if (!periodStart || !periodEnd) {
      res.status(400).json({ error: 'periodStart and periodEnd query params required' });
      return;
    }
    const snapshots = await service.getSnapshotsForBillingPeriod(
      req.params.tenantId,
      new Date(periodStart as string),
      new Date(periodEnd as string)
    );
    res.json(snapshots);
  } catch (error) {
    next(error);
  }
});

// Create billing cycle snapshot
entitlementsRouter.post('/tenant/:tenantId/snapshots/billing-cycle', tenantAuthMiddleware('manageBilling'), withIdempotencyMiddleware({ endpoint: 'POST /api/entitlements/tenant/:tenantId/snapshots/billing-cycle' }), async (req, res, next) => {
  try {
    const { billingPeriodStart, billingPeriodEnd } = req.body;
    if (!billingPeriodStart || !billingPeriodEnd) {
      res.status(400).json({ error: 'billingPeriodStart and billingPeriodEnd required' });
      return;
    }
    const snapshot = await service.createBillingCycleSnapshot(
      req.params.tenantId,
      new Date(billingPeriodStart),
      new Date(billingPeriodEnd)
    );

    logAudit('entitlement.snapshot.created', req.ctx, {
      tenantId: req.params.tenantId,
      snapshotId: snapshot.id,
      reason: 'billing_cycle',
    });

    res.status(201).json(snapshot);
  } catch (error) {
    next(error);
  }
});

// Create dispute snapshot
entitlementsRouter.post('/tenant/:tenantId/snapshots/dispute', tenantAuthMiddleware('manageBilling'), withIdempotencyMiddleware({ endpoint: 'POST /api/entitlements/tenant/:tenantId/snapshots/dispute' }), async (req, res, next) => {
  try {
    const snapshot = await service.createDisputeSnapshot(req.params.tenantId);

    logAudit('entitlement.snapshot.created', req.ctx, {
      tenantId: req.params.tenantId,
      snapshotId: snapshot.id,
      reason: 'dispute_request',
    });

    res.status(201).json(snapshot);
  } catch (error) {
    next(error);
  }
});
