// Notification service — entry point for event sources.
//
// enqueueNotification reads the recipient's preferences, applies type-toggle +
// cadence rules, inserts a row, and either sends realtime or leaves it for the
// hourly digest tick. NEVER throws — caller's transaction must not roll back
// because of an email failure.

import { log } from '../infrastructure/logging';
import { armNextDigest } from './digest-schedule';
import { AccountRepository } from '../accounts/repository';
import * as repo from './repository';
import { sendRealtimeNotificationEmail } from './email';
import { sendPushNotification } from '../push';
import type { EnqueueNotificationInput, NotificationCadence } from './types';
import { TYPE_TO_PREF_KEY } from './types';

const accountsRepo = new AccountRepository();

/**
 * What actually happened, so a caller can report it rather than guess.
 *
 * pushOutOfTurnMessage needs this: its contract promises `pushed` means a
 * notification reached the reader, and every other channel it fans out to
 * answers that honestly. Without a result here the web branch could only ever
 * say "I tried", which is exactly the kind of claim that makes a delivery
 * pipeline look healthy while nobody is being told anything.
 */
export interface EnqueueResult {
  /** Browsers a push actually reached. Zero is the normal case for an account
   *  that has never turned browser notifications on. */
  pushedDevices: number;
  /** True only when a realtime email was sent AND accepted. A row queued for a
   *  digest is not delivery. */
  emailed: boolean;
  /** Set when nothing was delivered on any channel, naming the rule that
   *  stopped it. */
  suppressed?: 'kill_switch' | 'account_missing' | 'type_off' | 'cadence_none' | 'no_channel';
}

const NOTHING = (
  reason: NonNullable<EnqueueResult['suppressed']>,
): EnqueueResult => ({ pushedDevices: 0, emailed: false, suppressed: reason });

export async function enqueueNotification(
  input: EnqueueNotificationInput,
): Promise<EnqueueResult> {
  // Master kill switch. Set to 'true' in Cloud Run env only after the FE
  // GlobalUnsubscribeHandler is live in prod, otherwise unsubscribe links 404 quietly.
  //
  // The drop is LOUD on purpose. A silent `return` here makes every caller
  // upstream look like it is working: the code runs, nothing throws, and a
  // feature can be built, shipped and reported as delivering while every
  // notification it produces is discarded at this line. `escalation` is called
  // out separately because it is the type that means an agent is blocked and
  // waiting on a person — dropping one of those is a person not being told.
  if (process.env.NOTIFICATION_DELIVERY_ENABLED !== 'true') {
    log.warn(
      {
        metric: 'notification.dropped_by_kill_switch',
        type: input.type,
        tenantId: input.tenantId,
        accountId: input.accountId,
        blocksAPerson: input.type === 'escalation',
      },
      'notification discarded — NOTIFICATION_DELIVERY_ENABLED is not "true" in this environment',
    );
    return NOTHING('kill_switch');
  }

  // findById already filters deleted_at IS NULL, but the extra deletedAt check
  // is defensive: if the repository ever stops filtering at the SQL layer,
  // we still must not email a soft-deleted account.
  const account = await accountsRepo.findById(input.accountId);
  if (!account || account.deletedAt) return NOTHING('account_missing');

  const prefs = (account.preferences ?? {}) as {
    notificationTypes?: Record<string, boolean>;
    notificationFrequency?: NotificationCadence;
    notificationDelivery?: { email?: boolean; browser?: boolean };
  };

  // Defaults: type toggles default ON, cadence defaults to 'daily'. Matches the
  // DB column default (migration 206) — app-level fallback covers any
  // race where an account row predates the backfill.
  const typeOn = prefs.notificationTypes?.[TYPE_TO_PREF_KEY[input.type]] !== false;
  if (!typeOn) return NOTHING('type_off');

  // ── Delivery channels ───────────────────────────────────────────────────
  // Which types you get is `notificationTypes`; where they go is
  // `notificationDelivery`. Email defaults ON, matching every account that
  // predates the field. Browser defaults OFF and must be turned on explicitly:
  // it cannot work without an OS permission the person has to grant, and
  // defaulting it on would put a permission prompt in front of the entire user
  // base at once.
  const emailOn = prefs.notificationDelivery?.email !== false;
  const browserOn = prefs.notificationDelivery?.browser === true;

  // Push happens HERE, before the cadence rules, on purpose.
  //
  // Cadence is an email concept and always has been — the None option reads
  // "Do not send email notifications" in Settings. Somebody on Daily digest
  // asked for slower mail, not for silence. Running push through the cadence
  // branch below would also strand it entirely for cadence='none', which
  // returns before anything is inserted, and a digest of push notifications is
  // meaningless anyway: a push either interrupts you now or it is pointless.
  //
  // Push reads no notifications row and writes none. That table exists to batch
  // digests, which push does not do.
  //
  // Awaited, not fired and forgotten. It costs one FCM round trip ahead of the
  // email, and it is the only way this function can tell its caller what was
  // actually delivered. deliverPush swallows its own failures, so awaiting adds
  // latency but no new failure mode.
  const pushedDevices = browserOn ? await deliverPush(input) : 0;

  if (!emailOn) {
    return pushedDevices > 0
      ? { pushedDevices, emailed: false }
      : { ...NOTHING('no_channel'), pushedDevices };
  }

  // Cadence rule — 'none' suppresses ALL types (including escalations).
  // User explicitly opted out; we honor it. They can re-enable any time.
  const userCadence = prefs.notificationFrequency ?? 'daily';
  if (userCadence === 'none') {
    return pushedDevices > 0
      ? { pushedDevices, emailed: false }
      : { ...NOTHING('cadence_none'), pushedDevices };
  }

  // Otherwise: escalations bypass to realtime; everything else uses the user's cadence.
  const cadence: Exclude<NotificationCadence, 'none'> =
    input.type === 'escalation' ? 'realtime' : (userCadence as 'realtime' | 'daily' | 'weekly');

  const row = await repo.insertNotification({
    accountId: input.accountId,
    tenantId: input.tenantId,
    type: input.type,
    payload: input.payload,
    cadence,
  });

  if (cadence !== 'realtime') {
    // Queued for a digest: make sure a tick comes at this account's 09:00.
    armNextDigest([account.timezone]);
    return { pushedDevices, emailed: false };
  }

  try {
    await sendRealtimeNotificationEmail(account, row);
    await repo.markDelivered([row.id]);
    return { pushedDevices, emailed: true };
  } catch (err) {
    const msg = (err as Error).message;
    log.warn(
      { rowId: row.id, err: msg, accountId: account.id, type: row.type },
      'realtime notification send failed; row left undelivered for ops review',
    );
    await repo.markFailed(row.id, msg);
    // Intentionally do not throw — caller's transaction must not roll back due to email failure.
    return { pushedDevices, emailed: false };
  }
}

/**
 * Render an enqueued notification as a push and deliver it.
 *
 * Separate from enqueueNotification so the fire-and-forget call site stays one
 * line, and so this can swallow its own errors: sendPushNotification already
 * never throws, but the payload shaping above it can (a malformed link), and
 * that must not surface as an unhandled rejection in the caller's turn.
 */
async function deliverPush(input: EnqueueNotificationInput): Promise<number> {
  try {
    const p = input.payload;
    const link = typeof p.eventLink === 'string' ? p.eventLink : '';

    // No link, no push. A notification whose click goes nowhere is worse than
    // no notification: it interrupts and then strands. Email still carries the
    // same message with its own fallback copy.
    if (!link) return 0;

    const title =
      (typeof p.eventTitle === 'string' && p.eventTitle) ||
      (typeof p.internalAgentName === 'string' && p.internalAgentName) ||
      'Liftoff';

    // FCM caps a message at 4KB and every OS truncates long bodies anyway, but
    // eventSummary carries up to 2000 characters of escalation reason. Trim
    // here rather than letting the platform decide where to cut.
    const rawBody = typeof p.eventSummary === 'string' ? p.eventSummary : '';
    const body = rawBody.length > 240 ? `${rawBody.slice(0, 239)}\u2026` : rawBody;

    // Collapse key. Two notifications about the same thread replace each other
    // rather than stacking, so an agent posting three times while you are
    // away leaves one notification, not three.
    const threadId = typeof p.threadId === 'string' ? p.threadId : null;
    const escalationId = typeof p.escalationId === 'string' ? p.escalationId : null;
    const tag = `${input.type}:${threadId ?? escalationId ?? input.accountId}`;

    return await sendPushNotification(input.accountId, { title, body, link, tag });
  } catch (err) {
    log.warn(
      { accountId: input.accountId, type: input.type, err: (err as Error).message },
      'push: could not build a message from the notification payload',
    );
    return 0;
  }
}
