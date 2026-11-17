// Daily Cloud Scheduler job — finds default payment methods (cards) that
// will expire in 30 days and fires the card-expiring reminder email via PB.
//
// Pivoted from the originally-planned customer.source.expiring webhook
// approach (Liftoff uses Stripe's PaymentMethod API exclusively, which does
// not emit source.expiring events). Queries the local payment_methods table
// which is kept in sync by payment_method.attached/updated webhooks.
//
// Dedupe table: card_expiring_reminders_sent. PK includes
// (tenant_id, exp_year, exp_month) so the 30-day reminder fires once per
// card per expiry.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { PlatformBackendClient } from '../infrastructure/platform-backend-client.js';

export function registerCardExpiringRemindersRouter(
  app: FastifyInstance,
  deps: { pool: Pool; pbClient: PlatformBackendClient; billingServiceToken: string },
): void {
  app.post(
    '/api/internal/jobs/card-expiring-reminders',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const token = req.headers['x-service-auth'];
      if (!token || token !== deps.billingServiceToken) {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      // Compute the target month 30 days from today. The local payment_methods
      // table stores exp_year + exp_month as SMALLINT; we match exactly that
      // (year, month) tuple so each card fires the reminder exactly once
      // (combined with the dedupe table below).
      const today = new Date();
      // Stripe's exp_month is 1-indexed; JS Date.getMonth() is 0-indexed.
      // current month (1-indexed) = today.getMonth() + 1; +1 again for ~30 days out.
      let targetMonth = today.getMonth() + 1 + 1;
      let targetYear = today.getFullYear();
      if (targetMonth > 12) {
        targetMonth -= 12;
        targetYear += 1;
      }

      const rows = await deps.pool.query<{ // rls-fence: allow (cross-tenant reminder sweep; no single tenant to scope to)
        tenant_id: string;
        brand: string;
        last4: string;
        exp_month: number;
        exp_year: number;
        stripe_customer_id: string | null;
      }>(
        `SELECT pm.tenant_id, pm.brand, pm.last4, pm.exp_month, pm.exp_year,
                s.stripe_customer_id
           FROM payment_methods pm
           LEFT JOIN LATERAL (
             SELECT stripe_customer_id FROM subscriptions
              WHERE tenant_id = pm.tenant_id
              ORDER BY updated_at DESC LIMIT 1
           ) s ON TRUE
          WHERE pm.is_default = TRUE
            AND pm.exp_year = $1
            AND pm.exp_month = $2`,
        [targetYear, targetMonth],
      );

      let sent = 0;
      let skipped = 0;
      let failed = 0;

      for (const row of rows.rows) {
        const reserved = await deps.pool.query( // rls-fence: allow (cross-tenant reminder dedupe, bg job)
          `INSERT INTO card_expiring_reminders_sent (tenant_id, exp_year, exp_month, sent_at)
           VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING RETURNING tenant_id`,
          [row.tenant_id, row.exp_year, row.exp_month],
        );
        if (reserved.rowCount === 0) {
          skipped++;
          continue;
        }
        if (!row.stripe_customer_id) {
          // No Stripe customer mapped — cannot fan out. Dedupe row retained
          // so we do not keep retrying.
          app.log.warn({ tenantId: row.tenant_id }, 'card-expiring-reminders: no stripe_customer_id, skipping');
          continue;
        }
        try {
          await deps.pbClient.cardExpiring(row.stripe_customer_id, {
            cardBrand: row.brand,
            cardLast4: row.last4,
            cardExpMonth: String(row.exp_month).padStart(2, '0'),
            cardExpYear: String(row.exp_year),
          });
          sent++;
        } catch (err) {
          failed++;
          app.log.warn({ tenantId: row.tenant_id, error: (err as Error).message },
            'card-expiring-reminders: send failed (dedupe row retained)');
        }
      }

      app.log.info({ processed: rows.rowCount, sent, skipped, failed },
        'card-expiring-reminders: completed');
      return reply.code(200).send({ processed: rows.rowCount, sent, skipped, failed });
    },
  );
}
