// Handing Operating Units back for work that failed.
//
// When a run produces nothing usable, or an outage burns an allowance, the
// remedy is compute rather than money: it costs COGS (~$0.01/unit) instead of
// revenue, it lands immediately, it needs no Stripe call, and it does not lose
// the processing fee Stripe keeps on a refund whether or not the refund
// succeeds.
//
// The grant is a NEGATIVE-COST EVENT through the ordinary consumption boundary,
// not a new allowance column and not a new cost bucket. `applyOuRefund` already
// does the hard part — both period counters moved together under FOR UPDATE,
// floored at zero, one negative ledger row — and had no caller a human could
// reach. This is that caller; everything underneath is the path every other
// consumption event already takes.
//
// Mounted under /api/admin behind adminAuthMiddleware: the grant is real
// compute, so the caller must be a platform admin and every call leaves an
// audit row naming them.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { logAdminAction } from './middleware';
import { adminError, wrapAdminResponse } from './conventions';
import { ingestEventWithBuckets } from '../cost-attribution/repository';
import { getOuDefinitionRateUsd } from '../cost-attribution/ou-bucket-service';

export const ouCreditAdminRouter = Router();

/**
 * Largest single grant, in Operating Units.
 *
 * A typo guard rather than a spending cap: an operator who genuinely needs more
 * issues a second grant, and both are audited. 50,000 units is roughly $500 of
 * raw compute and well above a Scale plan's entire monthly allowance (9,200), so
 * it refuses an extra digit without ever refusing a real remedy.
 *
 * Declared here rather than inline in the schema so raising it is one edit.
 */
export const MAX_OPERATOR_CREDIT_OUS = 50_000;

const grantSchema = z.object({
  operatingUnits: z.number().positive().max(MAX_OPERATOR_CREDIT_OUS),
  // Required, not optional. This is a discretionary grant of real compute, and
  // an audit row that does not say why is worth very little.
  reason: z.string().min(1).max(500),
  // Supplied by the caller when a retry must not double-credit. Absent, the
  // audit record's id is used, which makes each call its own grant.
  idempotencyKey: z.string().min(1).max(200).optional(),
});

const accountIdSchema = z.string().uuid();

function adminActor(req: Request): { id: string; email: string } | undefined {
  return (req as { adminAccount?: { id: string; email: string } }).adminAccount;
}

/**
 * POST /api/admin/accounts/:accountId/ou-credit
 *
 * Credits Operating Units to the account's current billing period by walking
 * the consumption counter back down.
 *
 * Operating Units on the wire, never dollars: units are the customer-facing
 * quantity and the only one billing surfaces expose. The conversion to the
 * boundary's USD and back is exact, because both directions use the same
 * `ou_definition_rate_usd`.
 *
 * IDEMPOTENT ON `idempotencyKey`. The boundary's refund branch dedups on
 * (source, event_type, source_id) before touching the counter, and the ledger
 * insert carries ON CONFLICT DO NOTHING, so a replayed grant reports
 * `credited: false` rather than crediting twice. That matters more here than
 * almost anywhere: a double credit is silent, and nothing downstream would
 * flag it.
 */
ouCreditAdminRouter.post('/:accountId/ou-credit', async (req: Request, res: Response) => {
  const { accountId } = req.params;
  if (!accountIdSchema.safeParse(accountId).success) {
    return res.status(400).json(adminError('invalid_account_id', undefined, 'accountId'));
  }

  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return res.status(400).json(
      adminError(
        'invalid_grant',
        issue?.message ?? 'invalid request body',
        issue?.path.join('.') ?? undefined,
      ),
    );
  }
  const { operatingUnits, reason, idempotencyKey } = parsed.data;

  const pool = getPool();

  // The account's primary workspace. The ledger row is tenant-scoped even
  // though the counter it moves is account-scoped, so both ids are needed.
  const tenantResult = await pool.query<{ id: string }>(
    `SELECT id FROM tenants WHERE account_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [accountId],
  );
  if (!tenantResult.rows[0]) {
    return res.status(404).json(adminError('tenant_not_found'));
  }
  const tenantId = tenantResult.rows[0].id;

  const actor = adminActor(req);

  // Audited BEFORE the credit, so an operator's intent is on the record even if
  // the grant then fails. The audit id doubles as the idempotency key when the
  // caller supplies none, which makes an un-keyed call its own distinct grant
  // rather than silently colliding with an earlier one.
  const audit = await logAdminAction(
    actor?.id ?? 'admin:no-id',
    'billing.ou_credit.grant',
    'account',
    accountId,
    { operatingUnits, reason, tenantId, idempotencyKey: idempotencyKey ?? null },
    req,
  );

  const sourceId = idempotencyKey ?? `admin-credit/${audit.actionId ?? Date.now()}`;

  try {
    const client = await pool.connect();
    let definitionRateUsd: number;
    try {
      definitionRateUsd = await getOuDefinitionRateUsd(client);
    } finally {
      client.release();
    }

    const inserted = await ingestEventWithBuckets(
      accountId,
      sourceId,
      -(operatingUnits * definitionRateUsd),
      {
        tenantId,
        eventType: 'credit',
        source: 'operator_credit',
        purpose: reason,
        occurredAt: new Date(),
      },
    );

    const credited = inserted > 0;
    log.info(
      { accountId, tenantId, operatingUnits, credited, sourceId, adminId: actor?.id },
      credited
        ? 'admin.ou_credit: granted'
        : 'admin.ou_credit: already granted for this key — no second credit',
    );

    return res.json(
      wrapAdminResponse(
        { accountId, tenantId, operatingUnits, credited, idempotencyKey: sourceId },
        audit,
      ),
    );
  } catch (error) {
    log.error(
      { accountId, tenantId, operatingUnits, error: (error as Error).message },
      'admin.ou_credit: grant failed',
    );
    return res.status(502).json(adminError('ou_credit_failed'));
  }
});
