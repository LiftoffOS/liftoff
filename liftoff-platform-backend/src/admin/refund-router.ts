// Returning money for a subscription invoice.
//
// The opposite number of the Operating Unit credit door: that one hands compute
// back and never touches Stripe, this one sends cash and never touches a
// counter. They share no code on purpose.
//
// Everything that decides an amount lives in liftoff-billing, which owns Stripe
// (INV-PB-010). This router is the operator's door to it: it proves who is
// calling, records why, and forwards. It computes no money of its own — a
// second opinion here would be a second authority, and the two would drift.
//
// Two routes because an operator should be able to see the number before
// committing to it. Both resolve to the same eligibility function on the
// billing side, so a quote and the refund that follows cannot disagree.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { logAdminAction } from './middleware';
import { adminError, wrapAdminResponse } from './conventions';
import { getBillingAdminClient } from '../billing/billing-admin-client';

export const refundAdminRouter = Router();

const accountIdSchema = z.string().uuid();

const quoteSchema = z.object({
  stripeInvoiceId: z.string().min(1).max(200),
});

const refundSchema = z.object({
  stripeInvoiceId: z.string().min(1).max(200),
  amountCents: z.number().int().positive(),
  // Required. A discretionary decision about somebody's money, and an audit row
  // that does not say why is worth very little.
  reason: z.string().min(1).max(500),
  // Forwarded to Stripe, so a replay returns the original credit note instead
  // of issuing a second one.
  idempotencyKey: z.string().min(1).max(200),
});

function adminActor(req: Request): { id: string; email: string } | undefined {
  return (req as { adminAccount?: { id: string; email: string } }).adminAccount;
}

/** The account's primary workspace, which is what billing is keyed on. */
async function primaryTenantId(accountId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM tenants WHERE account_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [accountId],
  );
  return rows[0]?.id ?? null;
}

/**
 * POST /api/admin/accounts/:accountId/refund-quote
 *
 * What could be refunded on one invoice, and why not when the answer is
 * nothing. Moves no money and writes no audit row: asking is not an act.
 */
refundAdminRouter.post('/:accountId/refund-quote', async (req: Request, res: Response) => {
  const { accountId } = req.params;
  if (!accountIdSchema.safeParse(accountId).success) {
    return res.status(400).json(adminError('invalid_account_id', undefined, 'accountId'));
  }
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(adminError('invalid_request', parsed.error.issues[0]?.message));
  }

  const tenantId = await primaryTenantId(accountId);
  if (!tenantId) return res.status(404).json(adminError('tenant_not_found'));

  try {
    const quote = await getBillingAdminClient().refundQuote({
      tenantId,
      stripeInvoiceId: parsed.data.stripeInvoiceId,
    });
    return res.json(wrapAdminResponse({ accountId, tenantId, ...quote }, null));
  } catch (error) {
    log.error(
      { accountId, tenantId, error: (error as Error).message },
      'admin.refund: quote failed',
    );
    return res.status(502).json(adminError('refund_quote_failed'));
  }
});

/**
 * POST /api/admin/accounts/:accountId/refunds
 *
 * Issues the refund. Billing enforces the ceiling — the amount cannot exceed
 * what the policy allows, and a genuine exception goes through the Stripe
 * dashboard where it is visible as one — and cancels the subscription, because
 * the Terms say a refund ends access immediately.
 */
refundAdminRouter.post('/:accountId/refunds', async (req: Request, res: Response) => {
  const { accountId } = req.params;
  if (!accountIdSchema.safeParse(accountId).success) {
    return res.status(400).json(adminError('invalid_account_id', undefined, 'accountId'));
  }
  const parsed = refundSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return res.status(400).json(
      adminError('invalid_refund', issue?.message, issue?.path.join('.') || undefined),
    );
  }

  const tenantId = await primaryTenantId(accountId);
  if (!tenantId) return res.status(404).json(adminError('tenant_not_found'));

  const actor = adminActor(req);

  // Audited BEFORE the money moves, so an operator's intent is on the record
  // even when the refund then fails.
  const audit = await logAdminAction(
    actor?.id ?? 'admin:no-id',
    'billing.refund.issue',
    'account',
    accountId,
    { tenantId, ...parsed.data },
    req,
  );

  try {
    const result = await getBillingAdminClient().issueRefund({ tenantId, ...parsed.data });
    log.info(
      { accountId, tenantId, ...result, adminId: actor?.id },
      'admin.refund: issued',
    );
    return res.json(wrapAdminResponse({ accountId, tenantId, ...result }, audit));
  } catch (error) {
    const err = error as Error & { status?: number; body?: string };
    // A refusal is not a failure. Billing answers 409 with the reason it will
    // not refund — outside the window, allowance consumed, term used up, amount
    // over the ceiling — and passing that through is the difference between an
    // operator learning why and an operator retrying blindly.
    if (err.status === 409) {
      log.info({ accountId, tenantId, body: err.body }, 'admin.refund: refused by policy');
      return res.status(409).json(adminError('refund_refused', err.body?.slice(0, 300)));
    }
    log.error({ accountId, tenantId, error: err.message }, 'admin.refund: failed');
    return res.status(502).json(adminError('refund_failed'));
  }
});
