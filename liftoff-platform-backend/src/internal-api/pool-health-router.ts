// Connection-pool health, polled by the `connection-pool-health-${env}` scheduler.
//
// Exhaustion of the control-plane pool degrades every tenant at once, so the
// numbers are worth exporting even though nothing reads them interactively.
//
// Auth: Cloud Run admits allUsers on this service, so the platform layer does
// not gate by identity and every scheduler endpoint verifies OIDC itself.

import { Router } from 'express';
import { getPoolStats } from '../infrastructure/database';
import { requireSchedulerOidc } from '../infrastructure/scheduler-auth';
import { log } from '../infrastructure/logging';

export const poolHealthRouter = Router();

export interface PoolHealthReport {
  healthy: boolean;
  pools: Record<string, { total: number; idle: number; waiting: number }>;
  totalWaiting: number;
}

// `waiting` is the only one of the three numbers that means trouble on its own:
// clients are queued for a connection. A high `total` with nothing waiting is a
// warm pool doing its job.
export function buildPoolHealthReport(
  stats: Record<string, { total: number; idle: number; waiting: number }>,
): PoolHealthReport {
  const totalWaiting = Object.values(stats).reduce((sum, s) => sum + s.waiting, 0);
  return { healthy: totalWaiting === 0, pools: stats, totalWaiting };
}

// GET /api/internal/health/connection-pool
poolHealthRouter.get(
  '/connection-pool',
  requireSchedulerOidc({
    // Fails closed when BACKEND_URL is unset rather than defaulting to the prod
    // URL: a dev backend that accepts prod-minted tokens is a cross-environment
    // trust bug. requireSchedulerOidc reads '' as "not configured" and 500s.
    expectedAudience: () => process.env.BACKEND_URL ?? '',
    allowedEmails: () => [process.env.CLOUD_SCHEDULER_SA_EMAIL ?? ''],
  }),
  (_req, res) => {
    const report = buildPoolHealthReport(getPoolStats());

    // The scheduler discards the body, so saturation has to reach an operator
    // through the log rather than the response.
    if (!report.healthy) {
      log.warn(
        { pools: report.pools, totalWaiting: report.totalWaiting },
        'connection_pool_saturated',
      );
    }

    // 200 even when saturated. The scheduler's status must report whether it
    // could reach the endpoint; folding a health verdict into the HTTP status
    // makes a busy pool indistinguishable from a broken cron.
    res.json(report);
  },
);
