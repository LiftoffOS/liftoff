// The operator half of "Liftoff may investigate and disqualify".
//
// That clause is the enforcement backstop the programme rests on, and it is
// there because the obvious alternative was rejected: automatic clawback
// against future earnings misses fraudsters — a negative balance is only
// collectable from somebody who intends to keep earning, which describes the
// honest referrer and not the attacker who abandons the workspace — and it is a
// griefing vector, because referral links are public by design and anyone can
// sign up through one, pay, and charge back.
//
// What replaces it is a human decision, recorded. Repetition is the fraud
// signal worth acting on — a shared payment fingerprint, a shared email domain,
// circular referrals — and these are the two levers that act on it. Without
// them the clause is written in the customer terms and enforced nowhere, which
// is worse than not claiming it.
//
// Mounted under /api/admin, behind adminAuthMiddleware: every route here moves
// money that somebody earned, so the caller must be a platform admin and every
// call leaves an audit row naming them.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getBillingAdminClient } from '../billing/billing-admin-client';
import { log, logAudit } from '../infrastructure/logging';
import { ReferralService } from './service';

export const referralsAdminRouter = Router();

const service = new ReferralService();

const referralIdSchema = z.string().uuid();
const tenantIdSchema = z.string().uuid();

/** Why an operator is taking credit back. Recorded on the audit row; the
 *  reason the CREDIT carries is decided by which endpoint was called. */
const noteSchema = z.object({ note: z.string().min(1).max(500) });

function adminActor(req: Request): { id: string; email: string } | undefined {
  return (req as { adminAccount?: { id: string; email: string } }).adminAccount;
}

/**
 * POST /api/admin/referrals/:referralId/disqualify
 *
 * Takes back the credit ONE referral earned.
 *
 * Spent credit is absorbed, never reclaimed — a disqualification does not
 * create a negative balance or re-bill, any more than a chargeback does — so
 * the response splits what was recovered from what was already gone. An
 * operator told "disqualified" when $20 had already been applied would believe
 * something happened that did not.
 */
referralsAdminRouter.post('/:referralId/disqualify', async (req: Request, res: Response) => {
  if (!referralIdSchema.safeParse(req.params.referralId).success) {
    return res.status(400).json({ error: 'invalid_referral_id' });
  }
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) {
    // The note is required rather than optional. This is a discretionary
    // decision about somebody's money, and the audit row is worth nothing if it
    // does not say why.
    return res.status(400).json({ error: 'note_required', details: parsed.error.issues });
  }

  const actor = adminActor(req);
  try {
    const result = await getBillingAdminClient().disqualifyReferralCredit(req.params.referralId);
    if (!result.found) {
      return res.status(404).json({ error: 'no_credit_for_referral' });
    }

    logAudit('admin.referral.disqualified', req.ctx, {
      referralId: req.params.referralId,
      reversedCredits: result.reversed,
      absorbedCredits: result.absorbed,
      note: parsed.data.note,
      adminId: actor?.id,
      adminEmail: actor?.email,
    });

    return res.json({
      reversed: result.reversed,
      absorbed: result.absorbed,
    });
  } catch (error) {
    log.error(
      { referralId: req.params.referralId, error: (error as Error).message },
      'referrals.admin: disqualify failed',
    );
    return res.status(502).json({ error: 'disqualify_failed' });
  }
});

/**
 * POST /api/admin/referrals/tenants/:tenantId/forfeit
 *
 * Forfeits a workspace's whole unspent balance, for termination for cause or a
 * terms violation.
 *
 * Immediate and with no grace period, matching what cancellation already does:
 * the reason a workspace stops being a customer does not change what happens to
 * credit that was never money.
 */
referralsAdminRouter.post(
  '/tenants/:tenantId/forfeit',
  async (req: Request, res: Response) => {
    if (!tenantIdSchema.safeParse(req.params.tenantId).success) {
      return res.status(400).json({ error: 'invalid_tenant_id' });
    }
    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'note_required', details: parsed.error.issues });
    }

    const actor = adminActor(req);
    try {
      const { forfeited } = await getBillingAdminClient().forfeitReferralCredit(
        req.params.tenantId,
      );

      logAudit('admin.referral.forfeited', req.ctx, {
        tenantId: req.params.tenantId,
        forfeitedCredits: forfeited,
        note: parsed.data.note,
        adminId: actor?.id,
        adminEmail: actor?.email,
      });

      return res.json({ forfeited });
    } catch (error) {
      log.error(
        { tenantId: req.params.tenantId, error: (error as Error).message },
        'referrals.admin: forfeit failed',
      );
      return res.status(502).json({ error: 'forfeit_failed' });
    }
  },
);

/**
 * GET /api/admin/referrals/tenants/:tenantId
 *
 * What a workspace's link has produced, for the investigation that has to come
 * before either decision above. Reads the same page the customer sees, because
 * an operator acting on different numbers than the customer is looking at is
 * how a support conversation goes wrong.
 */
referralsAdminRouter.get('/tenants/:tenantId', async (req: Request, res: Response) => {
  if (!tenantIdSchema.safeParse(req.params.tenantId).success) {
    return res.status(400).json({ error: 'invalid_tenant_id' });
  }
  try {
    const [program, referrals] = await Promise.all([
      service.getProgram(req.params.tenantId),
      service.listReferrals(req.params.tenantId, 100, null),
    ]);
    return res.json({ program, referrals });
  } catch (error) {
    log.error(
      { tenantId: req.params.tenantId, error: (error as Error).message },
      'referrals.admin: workspace read failed',
    );
    return res.status(500).json({ error: 'read_failed' });
  }
});
