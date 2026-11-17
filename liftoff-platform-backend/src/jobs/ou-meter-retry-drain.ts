// Hourly Cloud Scheduler job — re-fires failed Stripe OU meter events from
// ou_meter_event_retries (populated by fireOuMeterEventDurable on the
// cost-attribution ingest path, which has no other recovery mechanism).
//
// Semantics:
//   - Success → row deleted. Stripe's per-identifier idempotency makes a
//     re-fire of an event that actually landed a no-op, so crash-between-
//     fire-and-delete cannot double-charge.
//   - Failure → attempts incremented, row retained. Rows are NEVER dropped
//     on failure — billable usage must not be silently discarded. Rows that
//     exceed the attempt ceiling are logged at ERROR (ou_meter_retry_exhausted)
//     every run so the condition stays loud until an operator resolves it.

import { Router, Request, Response } from 'express';
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { validateServiceAuth } from './_serviceAuth';
import { fireOuMeterEvent } from '../billing/ou-meter-event';

const BATCH_LIMIT = 200;
const ATTEMPT_ALERT_CEILING = 20;

export const ouMeterRetryDrainRouter = Router();

interface RetryRow {
  identifier: string;
  stripe_customer_id: string;
  cost_usd: string;
  occurred_at: Date;
  attempts: number;
}

ouMeterRetryDrainRouter.post('/ou-meter-retry-drain', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;

  const pool = getPool();
  const { rows } = await pool.query<RetryRow>(
    `SELECT identifier, stripe_customer_id, cost_usd, occurred_at, attempts
       FROM ou_meter_event_retries
      ORDER BY created_at ASC
      LIMIT $1`,
    [BATCH_LIMIT],
  );

  let drained = 0;
  let stillFailing = 0;
  let exhausted = 0;

  for (const row of rows) {
    const ok = await fireOuMeterEvent({
      stripeCustomerId: row.stripe_customer_id,
      costUsd: parseFloat(row.cost_usd),
      identifier: row.identifier,
      occurredAt: row.occurred_at,
    });
    if (ok) {
      await pool.query(`DELETE FROM ou_meter_event_retries WHERE identifier = $1`, [row.identifier]);
      drained++;
      continue;
    }
    await pool.query(
      `UPDATE ou_meter_event_retries
          SET attempts = attempts + 1, updated_at = NOW()
        WHERE identifier = $1`,
      [row.identifier],
    );
    stillFailing++;
    if (row.attempts + 1 >= ATTEMPT_ALERT_CEILING) {
      exhausted++;
      log.error(
        { identifier: row.identifier, stripeCustomerId: row.stripe_customer_id, attempts: row.attempts + 1 },
        'ou_meter_retry_exhausted',
      );
    }
  }

  const summary = { batch: rows.length, drained, stillFailing, exhausted };
  log.info(summary, 'ou-meter-retry-drain: completed');
  res.status(200).json(summary);
});
