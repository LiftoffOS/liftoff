// Turn execution events (migration 014) — the durable side of letting somebody
// other than the sender watch a CAIO turn happen.
//
// Written by the turn recorder as a turn streams, read back by cursor. See the
// migration for why this is a written log rather than a second live pipe.
//
// Ported from platform-backend src/agent-chat/turn-events-repository.ts.

import { withTenantContext } from '../infrastructure/rls.js';

/** Mirrors the SSE vocabulary the sender receives, plus 'done'. 'text' carries
 *  a coalesced chunk rather than a single token — see the recorder. */
export type TurnEventKind =
  | 'text'
  | 'thinking'
  | 'tool_call'
  | 'content_block'
  | 'delegation_started'
  | 'error'
  | 'done';

export interface TurnEvent {
  seq: number;
  kind: TurnEventKind;
  payload: Record<string, unknown> | null;
}

/**
 * Append a batch in one round trip. Batched because the recorder coalesces —
 * a flush carries the text accumulated since the last one plus any discrete
 * events that happened in between.
 */
export async function appendTurnEvents(
  tenantId: string,
  threadId: string,
  turnId: string,
  events: TurnEvent[],
): Promise<void> {
  if (events.length === 0) return;

  const values: unknown[] = [];
  const tuples = events.map((e, i) => {
    const base = i * 6;
    values.push(turnId, e.seq, tenantId, threadId, e.kind, e.payload ?? null);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });

  await withTenantContext(tenantId, (client) =>
    client.query(
      `INSERT INTO team_plan_turn_events
         (turn_id, seq, tenant_id, thread_id, kind, payload)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (turn_id, seq) DO NOTHING`,
      values,
    ),
  );
}

/**
 * Everything on a turn after `afterSeq`, in order. The consumer concatenates
 * 'text' payloads to rebuild the assistant's output, which is why order and
 * gap-freedom matter more here than latency.
 */
export async function listTurnEventsAfter(
  tenantId: string,
  turnId: string,
  afterSeq: number,
  limit = 500,
): Promise<TurnEvent[]> {
  return withTenantContext(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT seq, kind, payload
       FROM team_plan_turn_events
       WHERE turn_id = $1 AND seq > $2
       ORDER BY seq ASC
       LIMIT $3`,
      [turnId, afterSeq, limit],
    );
    return rows.map((r) => ({
      seq: r.seq as number,
      kind: r.kind as TurnEventKind,
      payload: (r.payload as Record<string, unknown> | null) ?? null,
    }));
  });
}

/**
 * Drop events for turns that finished a while ago. Opportunistic and scoped to
 * one thread, the same shape as the presence sweep: this is transient data and
 * a scheduled job would be one more thing to own for no benefit.
 */
export async function pruneTurnEvents(tenantId: string, threadId: string): Promise<void> {
  await withTenantContext(tenantId, (client) =>
    client.query(
      `DELETE FROM team_plan_turn_events
       WHERE thread_id = $1 AND created_at < NOW() - INTERVAL '1 hour'`,
      [threadId],
    ),
  );
}
