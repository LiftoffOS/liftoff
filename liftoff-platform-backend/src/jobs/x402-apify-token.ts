// On-demand run of the Apify prepaid token upkeep — the same work the
// hourly low-balance tick does (billing/apify-prepaid-token-service), for an
// operator who does not want to wait an hour for the first token, or wants to
// see the purchase happen. 409 when a purchase was needed and refused (the
// per-day cap, the funder, the vendor), 200 otherwise, skipped at 200 while
// nobody can pay for one.
//
// There is no amount to ask for: every purchase is the vendor's $1, which is
// also the monthly ceiling of the Apify account each token IS, so a larger
// one would strand the difference. `{ force: true }` buys even while a live
// token is healthy, under the same per-day cap: the way to watch a purchase
// happen without draining a token.

import { Router, Request, Response } from 'express';
import { log } from '../infrastructure/logging';
import { validateServiceAuth } from './_serviceAuth';
import { ensureApifyPrepaidToken } from '../billing/apify-prepaid-token-service';

export const x402ApifyTokenRouter = Router();

x402ApifyTokenRouter.post('/x402-apify-token', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;

  try {
    const body = (req.body ?? {}) as { force?: unknown };
    const force = body.force === true;
    const result = await ensureApifyPrepaidToken(new Date(), { ...(force ? { force } : {}) });
    if (result.capped || result.refused) {
      res.status(409).json({ success: false, reason: result.capped ? 'purchase_capped' : `refused:${result.refused}`, ...result });
      return;
    }
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'x402_apify_token: job failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
