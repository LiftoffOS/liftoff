// Outbound delivery obligations for Slack and Teams (C1).
//
// The gap this closes: ADR-041 made the inbound half durable, but once a turn
// had RUN, nothing tracked whether its reply actually reached the surface. A
// failed post meant Cloud Tasks re-ran the whole turn (paying for the model
// again, and re-invoking the runtime), and once the attempts ran out the reply
// was lost outright.
//
// Two mechanisms, both small:
//
//  1. An obligation row per turn-delivery, so "we owe this thread a reply" is
//     durable rather than living only in the worker's stack frame.
//  2. A short-circuit: if a worker retry finds the turn already completed, it
//     re-delivers the stored reply instead of re-running the turn.
//
// The reply text is never copied here — agent_chat_messages already holds it,
// keyed by turn id. Duplicating it would create a second source of truth for
// the same sentence.

import { withTenantScope } from '../infrastructure/database';
import { armChatDeliverySweep } from '../jobs/maintenance-targets';
import { log } from '../infrastructure/logging';

/** After this many attempts an obligation is abandoned rather than retried
 *  forever. Matches the inbound queue's maxAttempts so the two halves of a
 *  delivery give up at the same point. */
export const MAX_DELIVERY_ATTEMPTS = 4;

/** Prefix on a redelivered reply.
 *
 *  We cannot know whether the first attempt landed — the crash happened
 *  somewhere around the send — so this says so plainly rather than posting what
 *  might be a silent duplicate. Honest at-least-once. */
export const RECOVERED_REPLY_MARKER =
  '_(Recovered reply — my earlier attempt to send this may not have arrived.)_\n\n';

export type DeliveryChannel = 'slack' | 'teams';

export interface DeliveryObligationInput {
  tenantId: string;
  agentId: string;
  threadId: string;
  turnId: string;
  channel: DeliveryChannel;
  targetRef: string;
}

/**
 * Record that a reply is owed, before any send is attempted. Idempotent on
 * turn id: a worker retry updates the existing row rather than adding one.
 *
 * Best-effort — bookkeeping must never be the reason a reply is not sent.
 */
export async function recordObligation(input: DeliveryObligationInput): Promise<void> {
  try {
    await withTenantScope(input.tenantId, (client) =>
      client.query(
        `INSERT INTO chat_delivery_obligations
           (tenant_id, agent_id, thread_id, turn_id, channel, target_ref, status, attempts)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', 1)
         ON CONFLICT (turn_id) DO UPDATE
           SET attempts = chat_delivery_obligations.attempts + 1,
               status = 'pending',
               updated_at = NOW()`,
        [input.tenantId, input.agentId, input.threadId, input.turnId, input.channel, input.targetRef],
      ),
    );
    // The sweep that re-posts a reply still owed after 10 minutes.
    armChatDeliverySweep();
  } catch (err) {
    log.warn(
      { tenantId: input.tenantId, turnId: input.turnId, error: (err as Error).message },
      'delivery-obligations: could not record the obligation (delivery proceeds)',
    );
  }
}

export async function markDelivered(tenantId: string, turnId: string): Promise<void> {
  try {
    await withTenantScope(tenantId, (client) =>
      client.query(
        `UPDATE chat_delivery_obligations
         SET status = 'delivered', delivered_at = NOW(), updated_at = NOW()
         WHERE turn_id = $1`,
        [turnId],
      ),
    );
  } catch (err) {
    log.warn(
      { tenantId, turnId, error: (err as Error).message },
      'delivery-obligations: could not mark delivered',
    );
  }
}

export async function markFailed(tenantId: string, turnId: string, reason: string): Promise<void> {
  try {
    await withTenantScope(tenantId, (client) =>
      client.query(
        `UPDATE chat_delivery_obligations
         SET status = CASE WHEN attempts >= $3 THEN 'abandoned' ELSE 'failed' END,
             last_error = $2,
             updated_at = NOW()
         WHERE turn_id = $1`,
        [turnId, reason.slice(0, 500), MAX_DELIVERY_ATTEMPTS],
      ),
    );
  } catch (err) {
    log.warn(
      { tenantId, turnId, error: (err as Error).message },
      'delivery-obligations: could not mark failed',
    );
  }
}

export interface OutstandingObligation {
  id: string;
  tenantId: string;
  agentId: string;
  threadId: string;
  turnId: string;
  channel: DeliveryChannel;
  targetRef: string;
  attempts: number;
}

/**
 * Obligations left behind by a process that died mid-delivery.
 *
 * `olderThanMinutes` is what makes this safe to run alongside live traffic: a
 * row younger than that may well belong to a delivery still in flight, and
 * redelivering it would create the duplicate this design is trying to avoid.
 */
export async function findOutstanding(
  tenantId: string,
  olderThanMinutes = 10,
  limit = 50,
): Promise<OutstandingObligation[]> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{
      id: string; tenant_id: string; agent_id: string; thread_id: string;
      turn_id: string; channel: DeliveryChannel; target_ref: string; attempts: number;
    }>(
      `SELECT id, tenant_id, agent_id, thread_id, turn_id, channel, target_ref, attempts
       FROM chat_delivery_obligations
       WHERE status IN ('pending', 'failed')
         AND attempts < $1
         AND updated_at < NOW() - ($2 || ' minutes')::interval
       ORDER BY updated_at ASC
       LIMIT $3`,
      [MAX_DELIVERY_ATTEMPTS, String(olderThanMinutes), limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      agentId: r.agent_id,
      threadId: r.thread_id,
      turnId: r.turn_id,
      channel: r.channel,
      targetRef: r.target_ref,
      attempts: r.attempts,
    }));
  });
}
