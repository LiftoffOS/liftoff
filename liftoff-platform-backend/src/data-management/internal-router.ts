// Retention cleanup as invoked by the weekly `retention-cleanup-${env}` scheduler.
//
// Separate from dataManagementRouter because that one is mounted after the
// global `app.use('/api', authMiddleware)`, which rejects a Cloud Scheduler OIDC
// token before any route-level guard can inspect it. Scheduler-driven routes
// mount ahead of authMiddleware and verify the token themselves.

import { Router } from 'express';
import { RetentionService } from './retention-service';
import { requireSchedulerOidc } from '../infrastructure/scheduler-auth';
import { log } from '../infrastructure/logging';

export const dataManagementInternalRouter = Router();

const retentionService = new RetentionService();

// POST /api/internal/data-management/retention/run-cleanup
dataManagementInternalRouter.post(
  '/retention/run-cleanup',
  requireSchedulerOidc({
    // Fails closed when BACKEND_URL is unset rather than defaulting to the prod
    // URL: a dev backend that accepts prod-minted tokens is a cross-environment
    // trust bug.
    expectedAudience: () => process.env.BACKEND_URL ?? '',
    allowedEmails: () => [process.env.CLOUD_SCHEDULER_SA_EMAIL ?? ''],
  }),
  async (_req, res) => {
    try {
      const result = await retentionService.runRetentionCleanup();
      log.info({ result }, 'retention_cleanup_completed');
      res.json(result);
    } catch (error) {
      // Surfaced rather than swallowed: this is the only enforcement pass for
      // the retention schedules, so a silent failure means data is kept past
      // its policy with nothing recording that it happened.
      log.error({ err: (error as Error).message }, 'retention_cleanup_failed');
      res.status(500).json({ error: 'Retention cleanup failed' });
    }
  },
);
