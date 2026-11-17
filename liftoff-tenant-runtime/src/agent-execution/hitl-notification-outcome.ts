// Did anyone actually get told this approval is waiting?
//
// The fan-out helpers (`postReviewDm`, `postReviewCard`) have always returned
// `{ totalAssignees, delivered, unreachable }`, and every call site threw it
// away inside a `setImmediate`. So the only trace of a failed announcement was a
// `logger.warn`, and 24h later the expiry path wrote `24h expiry — no operator
// decision` — a claim about a person, recorded identically whether they ignored
// the request or were never sent it. Migration 366 adds the columns; this
// records into them.
//
// Accumulates rather than overwrites, because Slack and Teams fan out
// separately for the same approval and each knows only its own result.
//
// So the counters are ATTEMPTS (person x channel), not people. Both channels
// resolve the SAME assignee list — `listAgentAssignees` is called with the same
// arguments on both paths — so a workspace with two assignees and both channels
// wired records four targets for two humans. An approval recording
// `targets=4, delivered=2` reads as half the audience missed, when it can mean
// Slack delivered to both people and Teams to neither, because neither had a
// bot conversation to post into yet — the documented normal state for Teams,
// and not an error, which is why `notify_error` stays null.
//
// Read them as "was anyone told at all" (delivered > 0), which is the question
// the expiry path asks and the only one they answer correctly. Do NOT read
// delivered/targets as a coverage ratio. Making that ratio meaningful needs the
// distinct account ids, which these two integers cannot hold.
//
// And do not read them AT ALL until the fan-outs have settled. Slack and Teams
// each run under `setImmediate` with no ordering and no completion barrier, so
// a total read from inside one channel's callback counts only the channels that
// happen to have finished. The row is trustworthy to a later reader — the 24h
// expiry path — and to nothing inside the fan-out itself.
//
// Never throws. This is bookkeeping ABOUT a notification path, and it must not
// become a way for that path to fail — an approval that was delivered but not
// recorded is a reporting gap; an approval that was not delivered because the
// recorder threw is a stalled run.

import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

export interface NotificationOutcome {
  /** Recipients THIS CHANNEL intended to reach. Accumulated across channels
   *  into a per-approval attempt count, not a headcount — see the file header. */
  targets: number;
  /** Recipients THIS CHANNEL actually reached. */
  delivered: number;
  /** Set when the attempt threw instead of returning counts. */
  error?: string;
}

export async function recordApprovalNotificationOutcome(
  tenantId: string,
  approvalId: string,
  outcome: NotificationOutcome,
): Promise<void> {
  try {
    await withTenantScope(tenantId, (client) =>
      client.query(
        `UPDATE hitl_approval_requests
            SET notify_attempted_at    = COALESCE(notify_attempted_at, NOW()),
                notify_target_count    = COALESCE(notify_target_count, 0) + $3,
                notify_delivered_count = COALESCE(notify_delivered_count, 0) + $4,
                notify_error           = COALESCE($5, notify_error),
                updated_at             = NOW()
          WHERE id = $1 AND tenant_id = $2`,
        [approvalId, tenantId, outcome.targets, outcome.delivered, outcome.error ?? null],
      ),
    );

    // The case the columns exist for. Logged at warn so it is visible without
    // anyone having to run the query, because a run is paused behind it.
    //
    // SCOPED TO THIS CHANNEL, because that is all this call knows. Slack and
    // Teams fan out separately and this function ACCUMULATES, so a channel that
    // reached nobody could print "announced to nobody" while the row it had
    // just written said delivered=2 of 4, and the line would be read as the
    // approval reaching no one when someone had in fact been told.
    //
    // The row is the authority on the approval; this line is the authority on
    // one attempt. The wording now says which it is, and the accumulated
    // totals are read back so the two can never be quoted against each other.
    if (outcome.delivered === 0) {
      const totals = await readNotificationTotals(tenantId, approvalId);
      logger.warn('HITL approval: this notification channel reached nobody', {
        approval_id: approvalId,
        tenant_id: tenantId,
        channel_targets: outcome.targets,
        channel_delivered: 0,
        // SO FAR. Not a verdict on the approval.
        //
        // These totals are read while the OTHER channels may still be running:
        // Slack and Teams both fan out under `setImmediate`, with no ordering
        // and no completion barrier, so whichever finishes first sees a total
        // that counts only itself.
        //
        // A `reached_nobody_overall` boolean computed from this snapshot would
        // be wrong: Teams can record 2 targets / 0 delivered (no assignee has a
        // Teams conversation) and log "reached nobody overall", and Slack then
        // deliver to BOTH assignees a second later. A run would be reported as
        // having reached no one when in fact everyone was told.
        //
        // So there is no such boolean. Nothing at this
        // point CAN answer "did this approval reach anyone" — the question is
        // only answerable once every channel has settled, and the reader that
        // needs it (hitl-expiry-helpers, 24h later) reads the row when they
        // have. A per-channel line states what this channel did and stops.
        approval_delivered_total_so_far: totals?.delivered ?? null,
        approval_target_total_so_far: totals?.targets ?? null,
        err: outcome.error,
      });
    }
  } catch (err) {
    logger.warn('failed to record HITL approval notification outcome', {
      approval_id: approvalId, err: (err as Error).message,
    });
  }
}

/** Accumulated totals for the approval, so a per-channel warning can say
 *  whether ANYONE was reached. Returns null on any failure — this is
 *  bookkeeping about bookkeeping and must never throw into the caller. */
async function readNotificationTotals(
  tenantId: string,
  approvalId: string,
): Promise<{ targets: number; delivered: number } | null> {
  try {
    const res = await withTenantScope(tenantId, (client) =>
      client.query<{ notify_target_count: number | null; notify_delivered_count: number | null }>(
        `SELECT notify_target_count, notify_delivered_count
           FROM hitl_approval_requests WHERE id = $1 AND tenant_id = $2`,
        [approvalId, tenantId],
      ),
    );
    const row = res.rows[0];
    if (!row) return null;
    return { targets: row.notify_target_count ?? 0, delivered: row.notify_delivered_count ?? 0 };
  } catch {
    return null;
  }
}
