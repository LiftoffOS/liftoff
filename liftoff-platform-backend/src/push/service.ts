// Push send path — the sibling of notifications/email.ts's
// sendRealtimeNotificationEmail.
//
// NEVER throws. A push is the least important of the delivery channels: an
// account may have no devices at all, and losing one must not fail the turn
// that produced it, roll back the caller's transaction, or suppress the email
// that carries the same message.

import { getMessaging } from 'firebase-admin/messaging';
import { log } from '../infrastructure/logging';
import { frontendOrigin } from '../infrastructure/frontend-url';
import * as repo from './repository';
import type { PushMessage, PushSubscriptionRow } from './types';

/**
 * The origin this environment sends to.
 *
 * Shared with every other link this service emits (infrastructure/frontend-url),
 * so dev sends only to devices registered on the dev host and prod only to
 * prod. Environments can share a Firebase project, so without this a dev run
 * could reach a real device.
 */
export function pushOrigin(): string | null {
  const origin = frontendOrigin();
  if (!origin) {
    log.warn(
      { frontendUrl: process.env.FRONTEND_URL },
      'push: FRONTEND_URL is not a valid URL; push disabled',
    );
  }
  return origin;
}

/** FCM rejects a multicast carrying more than 500 targets outright. An account
 *  that crossed the line would stop receiving anything at all rather than
 *  degrade, so the send is batched instead of assuming nobody gets there. */
const MULTICAST_BATCH_SIZE = 500;

/** FCM's codes for a device that can no longer receive. Those are not retryable
 *  and not errors in any useful sense: the person cleared site data, or the
 *  browser expired the subscription. Retiring them is the whole cleanup story.
 *
 *  `installation-id-not-registered` is the FID code. The two
 *  registration-token codes are kept because FCM still returns them for an
 *  installation whose underlying token is gone, and treating one of those as
 *  retryable would mean a dead device retried on every send forever. */
const DEAD_TARGET_CODES = new Set([
  'messaging/installation-id-not-registered',
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Deliver one message to every live browser an account has registered on this
 * environment's origin.
 *
 * Returns the number of devices reached, which is 0 for the common case of an
 * account that has never enabled browser notifications.
 */
export async function sendPushNotification(
  accountId: string,
  message: PushMessage,
): Promise<number> {
  try {
    const origin = pushOrigin();
    if (!origin) return 0;

    const subs = await repo.listLiveDevices(accountId, origin);
    if (subs.length === 0) {
      // Not an error — most accounts have never enabled push — but it is one of
      // the two ways this function returns 0 without sending, and telling them
      // apart from a failed send is the whole question when somebody reports
      // that nothing arrives.
      log.info(
        { accountId, origin, metric: 'push.no_targets' },
        'push: no live device for this account on this origin; nothing sent',
      );
      return 0;
    }

    const dead: string[] = [];
    let delivered = 0;

    for (let i = 0; i < subs.length; i += MULTICAST_BATCH_SIZE) {
      const batch = subs.slice(i, i + MULTICAST_BATCH_SIZE);

      // webpush rather than the top-level `notification` block: for a web target
      // FCM reads webpush.notification, and webpush.fcmOptions.link is the only
      // field that sets what a click opens. `data` carries the same link so the
      // service worker's own notificationclick handler can focus an existing tab
      // instead of opening a second one, which fcmOptions.link alone cannot do.
      const res = await getMessaging().sendEachForMulticast({
        fids: batch.map((r) => r.fid),
        data: { link: message.link },
        webpush: {
          notification: {
            title: message.title,
            body: message.body,
            tag: message.tag,
            icon: '/android-chrome-192x192.png',
            badge: '/favicon-96x96.png',
          },
          fcmOptions: { link: message.link },
        },
      });

      delivered += res.successCount;

      // Collect dead devices as we go. Without pruning, they are retried on
      // every future send forever, and each one costs a round trip.
      res.responses.forEach((r, j) => {
        if (r.success) return;
        const code = r.error?.code;
        if (code && DEAD_TARGET_CODES.has(code)) {
          dead.push(batch[j].id);
          return;
        }
        log.warn(
          { accountId, code, err: r.error?.message },
          'push: send failed for one device and it was not a dead-target error',
        );
      });
    }

    if (dead.length > 0) {
      // Its own guard. Pruning is cleanup, and letting it throw here would
      // abandon the count of what WAS delivered — which the caller reads as
      // `pushedDevices > 0` to decide whether the account had any channel at
      // all. A failed prune would be recorded as a failed send.
      try {
        await repo.revokeSubscriptions(dead);
        log.info({ accountId, revoked: dead.length }, 'push: retired unregistered devices');
      } catch (err) {
        log.warn(
          { accountId, err: (err as Error).message, metric: 'push.prune_failed' },
          'push: could not retire dead devices; they will be retried next send',
        );
      }
    }

    // Logged on success as well as failure. Without it the only observable
    // difference between "FCM accepted it" and "we never called FCM" is no log
    // either way, which is exactly the state that made a silent delivery
    // failure take days to place. `delivered` is FCM's acceptance count, not
    // proof a person saw anything: the browser and the OS can still drop it.
    log.info(
      {
        accountId,
        targets: subs.length,
        delivered,
        retired: dead.length,
        tag: message.tag,
        metric: 'push.sent',
      },
      'push: handed to FCM',
    );

    return delivered;
  } catch (err) {
    // Includes the cross-project 403 when the backend service account is
    // missing roles/firebasecloudmessaging.admin on YOUR_WEB_PROJECT. Logged
    // loudly because that failure is invisible from the browser: the user sees
    // permission granted and simply never receives anything.
    log.warn(
      { accountId, err: (err as Error).message, metric: 'push.send_failed' },
      'push: send threw; notification continues on its other channels',
    );
    return 0;
  }
}
