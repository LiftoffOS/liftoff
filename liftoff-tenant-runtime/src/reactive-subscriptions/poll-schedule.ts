// When the computed-metric poller runs next.
//
// The poller used to run on a Cloud Scheduler tick whether or not any
// computed-metric subscription existed. Each subscription already stores its
// own next_poll_at, so the poller is now armed for the earliest one: after
// every cycle, and whenever a subscription is created or reactivated. No
// subscriptions, no polling.
//
// Never more often than hourly. A chain tighter than the always-allocated
// instance's ~15-minute idle tail keeps agent-service up around the clock, so a
// one-minute poll interval would quietly cost the whole service; hourly is what
// these subscriptions got under the scheduler.

import { getPool } from '../infrastructure/database';
import { armDue, MAINTENANCE_PATHS } from '../infrastructure/maintenance-tasks';
import { logger } from '../infrastructure/logging';

export const POLL_FLOOR_MS = 60 * 60 * 1000;

/** Arm the poller for the earliest due subscription. `minDelayMs` is the floor
 *  after a cycle; a new subscription passes a short one so its first poll is
 *  not an hour away. */
export async function armNextComputedMetricPoll(minDelayMs: number = POLL_FLOOR_MS): Promise<void> {
  try {
    const { rows } = await getPool().query<{ next: Date | null }>(
      `SELECT MIN(next_poll_at) AS next FROM reactive_subscriptions
        WHERE status = 'active' AND source_kind = 'computed_metric'`,
    );
    const next = rows[0]?.next;
    if (!next) return;
    armDue('computed-metric', MAINTENANCE_PATHS.computedMetricPoller, new Date(next), { minDelayMs });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Non-fatal: next computed-metric poll not armed');
  }
}
