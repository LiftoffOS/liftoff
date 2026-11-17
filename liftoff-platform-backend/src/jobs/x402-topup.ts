// Hourly Cloud Scheduler job — the Coinbase → treasury top-up, the last
// manual leg of the x402 float automated.
//
// 200 when nothing needed doing or a top-up was sent; 409 when a needed
// top-up could not be covered by the Coinbase balance — the one residual
// human signal ("raise the Recurring Buy"), paged via the scheduler-failure
// net. Before the transfer-scoped Coinbase key exists it reports itself
// skipped at 200, and the manual funding walkthrough remains the path.

import { Router, Request, Response } from 'express';
import { log } from '../infrastructure/logging';
import { validateServiceAuth } from './_serviceAuth';
import { runX402Topup } from '../billing/x402-topup-service';

export const x402TopupRouter = Router();

x402TopupRouter.post('/x402-topup', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;

  try {
    const result = await runX402Topup();
    if (result.coinbaseShort) {
      // 409, not 500: the job ran correctly and the source of funds is dry.
      res.status(409).json({ success: false, reason: 'coinbase_short', ...result });
      return;
    }
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'x402_topup: job failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
