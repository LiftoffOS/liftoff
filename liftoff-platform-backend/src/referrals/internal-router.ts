// liftoff-billing → platform-backend, for the referral programme.
//
// The split follows the money boundary: this repo decides WHETHER a referral
// counts, billing decides what it is worth and when it can be spent, and is the
// only side that touches Stripe. That leaves billing needing three facts it
// cannot hold — was this paying workspace referred, by whom, and against which
// Stripe customers — plus two writes it must make when the invoice it sees
// settles the question.
//
// Authenticated with the same per-request HMAC as the billing-controls internal
// router, sharing its middleware so the two cannot drift apart.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validateBillingHmac } from '../billing/billing-controls-internal-router';
import { log } from '../infrastructure/logging';
import { ReferralService } from './service';

export const referralsInternalRouter = Router();

referralsInternalRouter.use(validateBillingHmac);

const service = new ReferralService();

const lookupSchema = z.object({ tenantId: z.string().uuid() });

/**
 * POST /api/internal/referrals/lookup
 *
 * A POST rather than a GET because the HMAC signs the body, and a GET would
 * have to sign an empty one — which would make every lookup's signature
 * interchangeable with every other lookup's.
 */
referralsInternalRouter.post('/lookup', async (req: Request, res: Response) => {
  const parsed = lookupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.issues });
  }
  try {
    const referral = await service.lookupForBilling(parsed.data.tenantId);
    // 200 with null rather than 404: "this workspace was not referred" is the
    // ordinary answer for almost every invoice, and a 404 would make billing's
    // client treat the common case as a failure.
    return res.json({ referral });
  } catch (error) {
    log.error(
      { tenantId: parsed.data.tenantId, error: (error as Error).message },
      'referrals.internal: lookup failed',
    );
    return res.status(500).json({ error: 'lookup_failed' });
  }
});

const subscribedSchema = z.object({ subscribedAt: z.string().datetime() });

/**
 * The referral id, checked before it reaches SQL.
 *
 * `referrals.id` is a uuid column, so anything else raises 22P02 and answers
 * 500 — a malformed id is a caller error and should say so.
 */
const referralIdSchema = z.string().uuid();

/** POST /api/internal/referrals/:referralId/subscribed */
referralsInternalRouter.post('/:referralId/subscribed', async (req: Request, res: Response) => {
  if (!referralIdSchema.safeParse(req.params.referralId).success) {
    return res.status(400).json({ error: 'invalid_referral_id' });
  }
  const parsed = subscribedSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.issues });
  }
  try {
    const row = await service.markSubscribed(
      req.params.referralId,
      new Date(parsed.data.subscribedAt),
    );
    if (!row) return res.status(404).json({ error: 'referral_not_found' });
    return res.json({ ok: true, subscribedAt: row.subscribedAt?.toISOString() ?? null });
  } catch (error) {
    log.error(
      { referralId: req.params.referralId, error: (error as Error).message },
      'referrals.internal: mark-subscribed failed',
    );
    return res.status(500).json({ error: 'mark_subscribed_failed' });
  }
});

const ineligibleSchema = z.object({
  reason: z.enum(['existing_account', 'already_referred', 'self_referral', 'discounted_signup']),
});

/**
 * POST /api/internal/referrals/:referralId/ineligible
 *
 * Disqualification must not silently drop the row: the referrer controls none
 * of these exclusions and cannot see any of them, so the reason is printed
 * where the amount would be.
 */
referralsInternalRouter.post('/:referralId/ineligible', async (req: Request, res: Response) => {
  if (!referralIdSchema.safeParse(req.params.referralId).success) {
    return res.status(400).json({ error: 'invalid_referral_id' });
  }
  const parsed = ineligibleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.issues });
  }
  try {
    const row = await service.markIneligible(req.params.referralId, parsed.data.reason);
    if (!row) return res.status(404).json({ error: 'referral_not_found' });
    return res.json({ ok: true, ineligibleReason: row.ineligibleReason });
  } catch (error) {
    log.error(
      { referralId: req.params.referralId, error: (error as Error).message },
      'referrals.internal: mark-ineligible failed',
    );
    return res.status(500).json({ error: 'mark_ineligible_failed' });
  }
});
