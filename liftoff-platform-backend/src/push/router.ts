// Browser push subscriptions — one authed router.
//
// Mounted alongside notificationsAuthedRouter (between authMiddleware and
// accessGateMiddleware) for the same reason: every query is scoped by
// req.user.uid -> account.id, so it cannot leak across accounts, and a user
// whose access is still pending should still be able to unsubscribe a browser.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import { AccountRepository } from '../accounts/repository';
import * as repo from './repository';
import { pushOrigin } from './service';

export const pushAuthedRouter = Router();

const accountsRepo = new AccountRepository();

// A Firebase Installation ID is long and opaque. Bounded rather than pattern
// matched: the format is Google's and has changed before, so a regex here would
// reject valid values the day it changes.
const FID = z.string().min(8).max(4096);

// One identifier, both directions. The legacy `fcmToken` and `legacyToken`
// fields were removed with the column they addressed.
const deviceSchema = z.object({ fid: FID });

async function resolveAccountId(req: Request, res: Response): Promise<string | null> {
  const firebaseUid = req.user?.uid;
  if (!firebaseUid) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const account = await accountsRepo.findByFirebaseUid(firebaseUid);
  if (!account) {
    res.status(404).json({ error: 'Account not found' });
    return null;
  }
  return account.id;
}

// ── POST /api/push/subscriptions — register this browser ────────────────────
pushAuthedRouter.post('/subscriptions', async (req: Request, res: Response, next) => {
  try {
    const accountId = await resolveAccountId(req, res);
    if (!accountId) return;

    const parsed = deviceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
      return;
    }

    // Origin is derived here, never taken from the request. It decides which
    // environment may later send to this device, so a client-supplied value
    // would let a dev browser register itself as a production target.
    const origin = pushOrigin();
    if (!origin) {
      log.warn(
        { metric: 'push.subscribe_no_origin', frontendUrl: process.env.FRONTEND_URL },
        'push: FRONTEND_URL is unusable, refusing to register a device with no origin',
      );
      res.status(503).json({ error: 'Push notifications are not configured' });
      return;
    }

    const userAgent = req.headers['user-agent'] ?? null;
    const ua = typeof userAgent === 'string' ? userAgent.slice(0, 512) : null;

    const row = await repo.upsertSubscriptionByFid({
      accountId,
      fid: parsed.data.fid,
      origin,
      userAgent: ua,
    });

    // Registering a device IS opting into browser delivery, so this endpoint
    // owns both halves rather than trusting a caller to follow up with a
    // separate PATCH.
    //
    // That split is not hypothetical: the preferences schema is .strict(), it
    // did not yet know notificationDelivery, and the follow-up PATCH 400'd
    // while this write succeeded. The result was a live token with delivery
    // off — a state the UI cannot reach or repair, because the banner hides
    // once permission is granted and the token sync deliberately does not
    // touch preferences. One request, one outcome, no half-state.
    //
    // A path-targeted write, not the shallow merge in update(): it must not
    // clobber the email sibling.
    await accountsRepo.setPreferenceField(
      accountId,
      ['notificationDelivery', 'browser'],
      true,
    );

    res.status(201).json({ id: row.id });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/push/subscriptions — retire this browser ────────────────────
// Body rather than a path parameter: these identifiers are long enough to be
// awkward in a URL, and keeping them out of the path keeps them out of access
// logs.
pushAuthedRouter.delete('/subscriptions', async (req: Request, res: Response, next) => {
  try {
    const accountId = await resolveAccountId(req, res);
    if (!accountId) return;

    const parsed = deviceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
      return;
    }

    // Scoped to the calling account: without that, knowing an FID would be
    // enough to silence somebody else's device.
    const revoked = await repo.revokeDeviceForAccount(accountId, parsed.data.fid);

    // Symmetric with register. Retiring this device's token means browser
    // delivery is off for it, and leaving the preference on would advertise a
    // channel with nothing behind it.
    await accountsRepo.setPreferenceField(
      accountId,
      ['notificationDelivery', 'browser'],
      false,
    );

    // 204 whether or not a row matched. An unsubscribe that finds nothing has
    // still achieved what the caller asked for, and distinguishing the two
    // would confirm whether a given token exists.
    res.status(204).send();
    if (revoked === 0) {
      log.info({ accountId }, 'push: unsubscribe matched no live subscription');
    }
  } catch (err) {
    next(err);
  }
});
