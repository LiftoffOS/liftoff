// Hourly reconciliation: compare invocations vs agent_trajectories over the
// last RECONCILIATION_WINDOW_HOURS and surface the gap as a structured-log
// metric Cloud Monitoring picks up via a log-based metric.
//
// Run as a Cloud Run Job per tenant project, triggered by Cloud Scheduler.
// See terraform/projects/tenant-runtime-template/trajectory_reconciliation.tf.

import { getPoolForService } from '../src/infrastructure/database';
import { logger } from '../src/infrastructure/logging';

interface ReconciliationResult {
  invocationsCount: number;
  trajectoriesCount: number;
  gapAbsolute: number;
  gapRatio: number;
  windowHours: number;
}

async function reconcile(): Promise<ReconciliationResult> {
  const windowHours = parseInt(process.env.RECONCILIATION_WINDOW_HOURS ?? '2', 10);
  const pool = getPoolForService('default');

  const invQ = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM invocations
     WHERE created_at >= NOW() - $1::interval AND outcome != 'error'`,
    [`${windowHours} hours`],
  );
  const trajQ = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM agent_trajectories
     WHERE created_at >= NOW() - $1::interval`,
    [`${windowHours} hours`],
  );

  const invocationsCount = parseInt(invQ.rows[0]?.n ?? '0', 10);
  const trajectoriesCount = parseInt(trajQ.rows[0]?.n ?? '0', 10);
  const gapAbsolute = invocationsCount - trajectoriesCount;
  const gapRatio = invocationsCount === 0 ? 0 : gapAbsolute / invocationsCount;
  return { invocationsCount, trajectoriesCount, gapAbsolute, gapRatio, windowHours };
}

async function main(): Promise<void> {
  const result = await reconcile();
  const allowedGap = parseFloat(process.env.ALLOWED_GAP_PERCENT ?? '0.1') / 100;
  logger.info({
    metric_name: 'trajectory_reconciliation_gap',
    metric_kind: 'gauge',
    metric_value: result.gapRatio,
    window_hours: result.windowHours,
    invocations: result.invocationsCount,
    trajectories: result.trajectoriesCount,
  });
  if (result.gapRatio > allowedGap) {
    logger.warn({
      message: 'trajectory reconciliation gap exceeds threshold',
      ...result,
      allowedGap,
    });
    process.exit(2);
  }
  // Exit 0 means a Cloud Scheduler retry attempt will not fire — gap was healthy.
}

void main().catch((err: Error) => {
  logger.error({ message: 'reconciliation job failed', err: err.message });
  process.exit(1);
});
