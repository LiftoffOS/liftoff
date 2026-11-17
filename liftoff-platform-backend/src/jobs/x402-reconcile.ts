// Daily Cloud Scheduler job — reconcile x402 wallet spend against the chain.
//
// Sums the wallet's outbound USDC transfers for the last complete UTC day and
// compares them to SUM(cost_usd) of that day's cost_bucket='x402_wallet_funded'
// rows. Returns 409 on drift so the scheduler run shows FAILED (the
// ou-meter-reconcile convention): drift in either direction is a defect — a
// payment with no usage record, or a record no payment backs. Before the
// wallet is live (X402_WALLET_ADDRESS unset) it reports itself skipped at 200.

import { Router, Request, Response } from 'express';
import { log } from '../infrastructure/logging';
import { validateServiceAuth } from './_serviceAuth';
import { runX402Reconciliation } from '../billing/x402-wallet-service';

export const x402ReconcileRouter = Router();

x402ReconcileRouter.post('/x402-reconcile', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;

  try {
    const result = await runX402Reconciliation();
    if (result.drifted) {
      // 409, not 500: the job ran correctly and found a real disagreement.
      res.status(409).json({ success: false, reason: 'reconciliation_drift', ...result });
      return;
    }
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'x402_reconcile: job failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
