// wake_event_delivery — durable outbox for wake_on_event.
//
// The subscription-router STAGES a delivery row transactionally on match (does NOT enqueue and does
// NOT set the subscription consumed). A drain worker then claims <=N staged rows/tick under a fenced
// lease, creates a deterministic resume Cloud Task, marks the row enqueued, and only then consumes the
// one-shot subscription. This closes the claim->enqueue crash window and provides herd spreading.
// Non-RLS (service pool + explicit tenant_id), matching reactive_subscriptions.

import { getPool } from '../infrastructure/database';

export interface WakeEventDeliveryRow {
  id: string;
  tenantId: string;
  wakeScheduledInvocationId: string;
  sourceEventId: string;
  payloadRef: Record<string, unknown>;
  state: 'staged' | 'enqueued' | 'done' | 'dead';
  leaseToken: string | null;
  attempts: number;
  cloudTaskName: string | null;
}

const DELIVERY_MAX_ATTEMPTS = Number(process.env.WAKE_DELIVERY_MAX_ATTEMPTS ?? 8);

function mapRow(r: Record<string, unknown>): WakeEventDeliveryRow {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    wakeScheduledInvocationId: r.wake_scheduled_invocation_id as string,
    sourceEventId: r.source_event_id as string,
    payloadRef: (r.payload_ref ?? {}) as Record<string, unknown>,
    state: r.state as WakeEventDeliveryRow['state'],
    leaseToken: (r.lease_token ?? null) as string | null,
    attempts: (r.attempts ?? 0) as number,
    cloudTaskName: (r.cloud_task_name ?? null) as string | null,
  };
}

export const wakeEventDeliveryRepo = {
  /** Transactional exactly-once staging on event match. Duplicate (wake, source_event) is a no-op. */
  async stage(input: {
    tenantId: string; wakeScheduledInvocationId: string; sourceEventId: string;
    payloadRef: Record<string, unknown>; availableAt?: Date;
  }): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `INSERT INTO wake_event_delivery
         (tenant_id, wake_scheduled_invocation_id, source_event_id, payload_ref, state, available_at)
       VALUES ($1,$2,$3,$4::jsonb,'staged',$5)
       ON CONFLICT (wake_scheduled_invocation_id, source_event_id) DO NOTHING
       RETURNING id`,
      [input.tenantId, input.wakeScheduledInvocationId, input.sourceEventId,
       JSON.stringify(input.payloadRef ?? {}), input.availableAt ?? new Date()],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /** Drain worker: claim <=limit staged deliveries under a fenced lease (herd spreading). */
  async claimStaged(limit = 20, leaseSeconds = 300): Promise<WakeEventDeliveryRow[]> {
    const pool = getPool();
    const { rows } = await pool.query(
      `UPDATE wake_event_delivery
       SET state='enqueued', lease_token=gen_random_uuid(),
           lease_until=NOW() + ($2 || ' seconds')::interval, attempts=attempts+1, updated_at=NOW()
       WHERE id IN (
         SELECT id FROM wake_event_delivery
         WHERE state='staged' AND available_at <= NOW()
         ORDER BY available_at ASC
         LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit, String(leaseSeconds)],
    );
    return rows.map(mapRow);
  },

  async markEnqueued(id: string, leaseToken: string, cloudTaskName: string | null): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE wake_event_delivery SET cloud_task_name=$3, lease_token=NULL, lease_until=NULL, updated_at=NOW()
       WHERE id=$1 AND lease_token=$2`,
      [id, leaseToken, cloudTaskName],
    );
  },

  async markDone(id: string): Promise<void> {
    const pool = getPool();
    await pool.query(`UPDATE wake_event_delivery SET state='done', updated_at=NOW() WHERE id=$1`, [id]);
  },

  /** Reconciler: enqueue leases that expired without ACK go back to 'staged' (retry), unless the
   *  attempt budget is exhausted → 'dead' + alert. */
  async reclaimStale(limit = 100): Promise<{ retried: number; dead: number }> {
    const pool = getPool();
    const dead = await pool.query(
      `UPDATE wake_event_delivery SET state='dead', lease_token=NULL, lease_until=NULL, updated_at=NOW()
       WHERE state='enqueued' AND lease_until < NOW() AND attempts >= $1
       RETURNING id`,
      [DELIVERY_MAX_ATTEMPTS],
    );
    const retried = await pool.query(
      `UPDATE wake_event_delivery SET state='staged', lease_token=NULL, lease_until=NULL, updated_at=NOW()
       WHERE id IN (
         SELECT id FROM wake_event_delivery
         WHERE state='enqueued' AND lease_until < NOW() AND attempts < $2
         ORDER BY lease_until ASC LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       RETURNING id`,
      [limit, DELIVERY_MAX_ATTEMPTS],
    );
    return { retried: retried.rowCount ?? 0, dead: dead.rowCount ?? 0 };
  },
};
