// Every-10-minutes Cloud Scheduler job — the x402 spending wallet's
// prepaid-card reload (treasury → spending wallet, on-chain USDC on Base).
//
// 200 when nothing needed doing or a reload succeeded; 409 when a reload is
// NEEDED and refused — the per-day pump bound tripped, or the treasury
// cannot cover one reload — so the refusal surfaces as a FAILED scheduler
// execution the estate's scheduled-work net pages on. Before the wallet or
// the CDP credentials are live it reports itself skipped at 200, and so
// does a wallet held by the Circle custodian (`circle_float`): that wallet
// is funded by hand and has no treasury to reload from, so the reload leg
// is Coinbase-only and the low-balance job carries the refill signal.

import { Router, Request, Response } from 'express';
import { log } from '../infrastructure/logging';
import { validateServiceAuth } from './_serviceAuth';
import { runX402Reload } from '../billing/x402-wallet-service';

export const x402ReloadRouter = Router();

x402ReloadRouter.post('/x402-reload', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;

  try {
    const result = await runX402Reload();
    if (result.capped || result.treasuryShort) {
      // 409, not 500: the job ran correctly and is refusing on purpose.
      res.status(409).json({
        success: false,
        reason: result.capped ? 'reload_capped' : 'treasury_short',
        ...result,
      });
      return;
    }
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'x402_reload: job failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
