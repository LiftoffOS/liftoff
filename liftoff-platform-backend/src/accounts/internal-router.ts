// Accounts internal router — HMAC-protected endpoints called by other
// services. Mounted at /api/internal/accounts.
//
// The only inhabitant today is /check-deletion-history, called by liftoff-
// billing's promo-eligibility helper to determine whether a re-signup's
// email hash matches a previously-deleted account. The hash check is held
// in platform-backend (alongside the accounts table) per the architectural
// split set out in the deletion plan: identity hashes here, payment-method
// fingerprints in billing.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AccountRepository } from './repository';
import { log } from '../infrastructure/logging';

export const accountsInternalRouter = Router();

function validateBillingHmac(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.BILLING_SERVICE_TOKEN;
  if (!token) {
    log.error({}, 'accounts.internal: BILLING_SERVICE_TOKEN not configured');
    res.status(503).json({ error: 'misconfigured' });
    return;
  }

  const timestampHeader = req.headers['x-billing-timestamp'] as string | undefined;
  const signatureHeader = req.headers['x-billing-signature'] as string | undefined;
  if (!timestampHeader || !signatureHeader) {
    res.status(401).json({ error: 'missing_billing_signature_headers' });
    return;
  }

  const timestamp = parseInt(timestampHeader, 10);
  if (isNaN(timestamp) || Math.abs(Date.now() - timestamp) > 60_000) {
    res.status(401).json({ error: 'signature_expired' });
    return;
  }

  const bodyStr = JSON.stringify(req.body ?? {});
  const signingString = `${req.method}\n${req.originalUrl.split('?')[0]}\n${timestamp}\n${bodyStr}`;
  const expected = createHmac('sha256', token).update(signingString).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    log.warn({ path: req.path }, 'accounts.internal: invalid HMAC signature');
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }
  next();
}

accountsInternalRouter.use(validateBillingHmac);

const repository = new AccountRepository();

// POST /api/internal/accounts/check-deletion-history
// Called by liftoff-billing's promo-eligibility helper to check whether
// a re-signing-up user's email hash matches a previously-deleted account.
accountsInternalRouter.post('/check-deletion-history', async (req: Request, res: Response): Promise<void> => {
  const emailHash = (req.body as { emailHash?: string })?.emailHash;
  if (!emailHash) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const match = await repository.findDeletionLedgerByEmailHash(emailHash);
  res.status(200).json({
    matched: match !== null,
    ...(match ? { deletedAt: match.deleted_at.toISOString() } : {}),
  });
});
