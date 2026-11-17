// Hourly Cloud Scheduler job — the x402 float's low-balance check.
//
// With the auto-reload running, the balance a human must act on is the
// TREASURY's (USDC refill float + the ETH gas tank); the spending wallet
// self-heals from it. Returns 409 when the human-owned float is under its
// threshold, so the scheduler run shows FAILED and pages, exactly the
// ou-meter-reconcile convention: a quiet 200 over an emptying float would be
// the ou-report mistake all over again. Before the wallet is live
// (X402_WALLET_ADDRESS unset) it reports itself skipped at 200.
//
// The same hourly tick keeps the Apify prepaid float: retire what expired,
// re-read EVERY live token's balance from the vendor, buy the next one when
// the live one is nearly spent or a day from expiry
// (billing/apify-prepaid-token-service). That float is bought through LOCUS,
// not from this wallet — Apify has no per-run rail, and its prepaid token is
// something Locus can pay for — so the upkeep rides here for the cadence
// rather than for the money: its outcome is reported beside the balance under
// `apifyPrepaid`, and a purchase the per-day cap or the funder refused is a
// 409 of its own (`apify_prepaid_refused`) so it pages too. The wallet
// balance is handed over for the emergency path alone
// (APIFY_PREPAID_WALLET_FALLBACK), which reads it only when Locus could not
// pay.

import { Router, Request, Response } from 'express';
import { log } from '../infrastructure/logging';
import { validateServiceAuth } from './_serviceAuth';
import { runX402LowBalanceCheck } from '../billing/x402-wallet-service';
import { ensureApifyPrepaidToken } from '../billing/apify-prepaid-token-service';

export const x402LowBalanceRouter = Router();

x402LowBalanceRouter.post('/x402-low-balance', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;

  try {
    const result = await runX402LowBalanceCheck();
    // The token upkeep never fails the balance check: its own failure is
    // logged and reported, and the balance verdict stands on its own.
    const apifyPrepaid = await ensureApifyPrepaidToken(new Date(), { walletBalanceUsd: result.spendingBalanceUsd }).catch((err: Error) => {
      log.error({ error: err.message }, 'x402_low_balance: apify prepaid token upkeep failed');
      return { error: err.message };
    });
    if (result.low) {
      // 409, not 500: the check ran correctly and the balance really is low.
      res.status(409).json({ success: false, reason: 'low_balance', ...result, apifyPrepaid });
      return;
    }
    if (('capped' in apifyPrepaid && apifyPrepaid.capped) || ('refused' in apifyPrepaid && apifyPrepaid.refused)) {
      res.status(409).json({ success: false, reason: 'apify_prepaid_refused', ...result, apifyPrepaid });
      return;
    }
    res.status(200).json({ success: true, ...result, apifyPrepaid });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'x402_low_balance: job failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
