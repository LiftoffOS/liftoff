// Daily Cloud Scheduler job — marks referral signups that have sat past the
// horizon without ever converting.
//
// WHAT THIS IS NOT. It does not disqualify anything and it does not stop a
// referral earning. The conversion event is the referred workspace's first
// full-priced paid invoice whenever it arrives, so a signup that subscribes on
// day 200 moves straight back to `subscribed` and pays the referrer exactly as
// it would have on day 20. `expired` says only "this one has gone quiet".
//
// WHY IT EXISTS. Without it, `signed_up` is a terminal state for everybody who
// never bought, so `pendingCount` accumulates forever and stops describing
// anything a referrer could act on. The row itself stays in the list either
// way, on purpose: dropping a sign-up that never converted would make the list
// silently shrink under somebody who is counting.
//
// Triggered with the shared X-Service-Auth / PLATFORM_CALLBACK_TOKEN
// convention used by the other PB internal jobs. Safe to run repeatedly: the
// flip only selects rows still `signed_up`, so a second run the same day finds
// nothing and a missed day catches up on the next one.

import { Router, Request, Response } from 'express';
import { log } from '../infrastructure/logging';
import { validateServiceAuth } from './_serviceAuth';
import { ReferralService } from '../referrals/service';

export const referralSignupExpiryRouter = Router();

referralSignupExpiryRouter.post(
  '/jobs/referral-signup-expiry',
  async (req: Request, res: Response) => {
    if (!validateServiceAuth(req, res)) return;

    try {
      const { expired } = await new ReferralService().expireStaleSignups();
      log.info({ expired }, 'referral-signup-expiry: sweep complete');
      res.status(200).json({ expired });
    } catch (err) {
      log.error(
        { error: (err as Error).message },
        'referral-signup-expiry: sweep failed',
      );
      res.status(500).json({ error: 'sweep_failed' });
    }
  },
);
