// Daily Cloud Scheduler job — finds accounts whose plan ends in 7 or 1 days
// and sends the 7-day / 1-day reminder email respectively. Dedupes per-day
// via the subscription_ending_reminders_sent table so re-invocation in the
// same day is a no-op.
//
// Triggered by Cloud Scheduler (subscription-ending-reminders-daily) which
// fires at 09:00 UTC daily with the shared X-Service-Auth /
// PLATFORM_CALLBACK_TOKEN convention used by other PB internal jobs.

import { Router, Request, Response } from 'express';
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { validateServiceAuth } from './_serviceAuth';
import {
  sendSubscriptionEnding7dEmail,
  sendSubscriptionEnding1dEmail,
} from '../infrastructure/email';
import { composePlanDisplay, STANDARD_PLAN_JOIN_SQL, type PlanRow } from '../billing/plan-display';

export const subscriptionEndingRemindersRouter = Router();

interface ReminderRow {
  account_id: string;
  access_ends_at: Date;
  days_until: number;
}

subscriptionEndingRemindersRouter.post('/subscription-ending-reminders', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;

  const pool = getPool();
  const { rows } = await pool.query<ReminderRow>(
    `SELECT bc.account_id, bc.access_ends_at,
            (bc.access_ends_at::date - CURRENT_DATE) AS days_until
       FROM billing_controls bc
      WHERE bc.access_ends_at IS NOT NULL
        AND (bc.access_ends_at::date - CURRENT_DATE) IN (7, 1)`,
  );

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    // Idempotency: try to reserve the (account_id, days_until_end, today) tuple.
    // Composite PK includes sent_at::date so re-cancel after a resubscribe cycle
    // is not permanently blocked.
    const reserved = await pool.query(
      `INSERT INTO subscription_ending_reminders_sent (account_id, days_until_end, sent_at)
       VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING RETURNING account_id`,
      [row.account_id, row.days_until],
    );
    if (reserved.rowCount === 0) {
      skipped++;
      continue;
    }

    try {
      const planRows = await pool.query<PlanRow>(STANDARD_PLAN_JOIN_SQL, [row.account_id]);
      if (!planRows.rows[0]) {
        log.warn({ accountId: row.account_id }, 'subscription-ending-reminders: account not found, skipping');
        continue;
      }
      const r = planRows.rows[0];
      const { planName } = composePlanDisplay(r);
      const sendFn = row.days_until === 7
        ? sendSubscriptionEnding7dEmail
        : sendSubscriptionEnding1dEmail;
      await sendFn(r.email, r.first_name ?? 'there', {
        planName,
        accessEndsDate: row.access_ends_at,
      });
      sent++;
    } catch (err) {
      failed++;
      log.warn(
        { accountId: row.account_id, daysUntil: row.days_until, error: (err as Error).message },
        'subscription-ending-reminders: send failed (dedupe row retained so we do not spam)',
      );
    }
  }

  log.info({ processed: rows.length, sent, skipped, failed }, 'subscription-ending-reminders: completed');
  res.status(200).json({ processed: rows.length, sent, skipped, failed });
});
