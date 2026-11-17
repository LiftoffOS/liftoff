// Not sending to somewhere confirmed dead.
//
// The fan-out already RECORDS who it could not reach
// (`slack_dm_delivery_attempts`, migration 321). Nothing read it back, so the
// same deactivated account, the same person who never installed the app, was
// retried on every single notification — burning flood-control budget on a
// message that cannot arrive, forever.
//
// Two rules keep this from becoming a way to lose real notifications:
//
//   * It takes several consecutive failures to latch. One failure is a blip —
//     a transient Slack error, a token mid-refresh — and treating it as death
//     would silence someone permanently over a bad minute.
//   * ANY success un-latches, immediately and completely. Someone who installs
//     the app on Tuesday starts receiving on Tuesday, with no cleanup job and
//     nobody having to notice. That self-heal is what makes the latch safe to
//     have at all.
//
// Whole-target deaths only. A single message failing for its own reasons is the
// adapter's retry problem, not this.

import { log } from '../infrastructure/logging';
import { withTenantScope } from '../infrastructure/database';

/** Consecutive failures before a target is treated as dead.
 *
 *  Three, because the cost asymmetry runs the other way from most thresholds
 *  here: latching too early silences a real person, while latching too late
 *  merely wastes a few sends. */
export const DEAD_TARGET_THRESHOLD = Number(process.env.DEAD_TARGET_THRESHOLD ?? 3);

export type DeliveryKind = 'review' | 'draft';

/** Which surface the fan-out went out on.
 *
 *  Part of a target's identity, not a label: the same person can be reachable
 *  on Slack and dead on Teams, and collapsing the two would let one channel's
 *  failures silence the other. */
export type DeliveryChannel = 'slack' | 'teams';

/**
 * Account ids that have failed enough consecutive times to be treated as dead
 * for this kind of delivery.
 *
 * Fails OPEN — an unreadable table returns an empty set, so the fan-out behaves
 * exactly as it did before this existed. A wasted send is recoverable; a
 * notification suppressed by a database error is not.
 */
export async function getDeadTargets(
  tenantId: string,
  kind: DeliveryKind,
  channel: DeliveryChannel,
): Promise<Set<string>> {
  try {
    const rows = await withTenantScope(tenantId, (client) =>
      client.query<{ assignee_account_id: string }>(
        `SELECT assignee_account_id
           FROM dm_delivery_attempts
          WHERE tenant_id = $1
            AND kind = $2
            AND channel = $4
            AND delivered = false
            AND consecutive_failures >= $3`,
        [tenantId, kind, DEAD_TARGET_THRESHOLD, channel],
      ),
    );
    return new Set(rows.rows.map((r) => r.assignee_account_id));
  } catch (err) {
    log.warn(
      { tenantId, kind, channel, error: (err as Error).message },
      'dead-targets: lookup failed, sending to everyone',
    );
    return new Set();
  }
}

/**
 * Split a recipient list into who to send to and who to skip.
 *
 * Returns both, rather than just the filtered list, so the caller can say in
 * its log how many it skipped — a silent filter looks identical to nobody being
 * assigned, and that is the kind of thing people spend an afternoon on.
 */
export async function partitionLiveTargets(
  tenantId: string,
  kind: DeliveryKind,
  accountIds: string[],
  channel: DeliveryChannel,
): Promise<{ live: string[]; skipped: string[] }> {
  if (accountIds.length === 0) return { live: [], skipped: [] };

  const dead = await getDeadTargets(tenantId, kind, channel);
  if (dead.size === 0) return { live: accountIds, skipped: [] };

  const live: string[] = [];
  const skipped: string[] = [];
  for (const id of accountIds) {
    (dead.has(id) ? skipped : live).push(id);
  }

  if (skipped.length > 0) {
    log.info(
      { tenantId, kind, channel, skipped: skipped.length, live: live.length },
      'dead-targets: skipped recipients that have failed repeatedly; any successful send un-latches them',
    );
  }
  return { live, skipped };
}

/**
 * Record who a fan-out reached and who it could not.
 *
 * The write side of the registry, shared by every channel. It lives here rather
 * than in an adapter because nothing about it is channel-shaped, and the one
 * thing that must not drift is the relationship between what is WRITTEN and
 * what `getDeadTargets` READS — a threshold means nothing if the two halves
 * disagree about how a failure is counted.
 *
 * Record ONLY targets that were actually attempted. Counting a skipped target
 * as another failure would deepen a latch nothing tested: the count would climb
 * forever on its own and the target could never recover even once it came back.
 */
export async function recordFanoutOutcome(args: {
  tenantId: string;
  kind: DeliveryKind;
  channel: DeliveryChannel;
  deliveredAccountIds: string[];
  unreachableAccountIds: string[];
  failureReason?: string;
}): Promise<void> {
  const { tenantId, kind, channel } = args;
  if (args.deliveredAccountIds.length === 0 && args.unreachableAccountIds.length === 0) return;
  const reason = args.failureReason ?? 'unreachable';
  try {
    await withTenantScope(tenantId, async (client) => {
      for (const accountId of args.deliveredAccountIds) {
        await client.query(
          `INSERT INTO dm_delivery_attempts
             (tenant_id, assignee_account_id, kind, channel, delivered,
              consecutive_failures, last_attempt_at, last_success_at)
           VALUES ($1, $2, $3, $4, true, 0, NOW(), NOW())
           ON CONFLICT (tenant_id, assignee_account_id, channel, kind) DO UPDATE
             SET delivered = true, consecutive_failures = 0, failure_reason = NULL,
                 last_attempt_at = NOW(), last_success_at = NOW()`,
          [tenantId, accountId, kind, channel],
        );
      }
      for (const accountId of args.unreachableAccountIds) {
        await client.query(
          `INSERT INTO dm_delivery_attempts
             (tenant_id, assignee_account_id, kind, channel, delivered,
              failure_reason, consecutive_failures, last_attempt_at)
           VALUES ($1, $2, $3, $4, false, $5, 1, NOW())
           ON CONFLICT (tenant_id, assignee_account_id, channel, kind) DO UPDATE
             SET delivered = false,
                 failure_reason = $5,
                 consecutive_failures = dm_delivery_attempts.consecutive_failures + 1,
                 last_attempt_at = NOW()`,
          [tenantId, accountId, kind, channel, reason],
        );
      }
    });
  } catch (err) {
    log.warn(
      { tenantId, kind, channel, error: (err as Error).message },
      'fan-out: could not record delivery outcomes',
    );
  }
}
