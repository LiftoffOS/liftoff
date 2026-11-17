// Turn execution events (migration 309) — the durable side of letting somebody
// other than the sender watch a turn happen.
//
// Written by the turn recorder as a turn streams, read back by cursor. See the
// migration for why this is a written log rather than a second live pipe.

import { withTenantScope } from '../infrastructure/database';

/** Mirrors the SSE vocabulary the sender receives, plus 'done'. 'text' carries
 *  a coalesced chunk rather than a single token — see the recorder. */
export type TurnEventKind =
  | 'text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'awaiting_input'
  | 'hitl_required'
  /** A hand-over began; payload { author, authorLabel } as on the SSE frame,
   *  so a follower attributes the live reply exactly as the sender does. */
  | 'delegation_started'
  | 'error'
  | 'done';

export interface TurnEvent {
  seq: number;
  kind: TurnEventKind;
  payload: Record<string, unknown> | null;
}

export interface TurnEventRow extends TurnEvent {
  turnId: string;
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

  await withTenantScope(tenantId, (client) =>
    client.query(
      `INSERT INTO agent_chat_turn_events
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
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT seq, kind, payload
       FROM agent_chat_turn_events
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

// How recently a turn must have emitted to count as live. Comfortably longer
// than the recorder's flush interval so a quiet stretch mid-turn (a slow tool
// call) does not read as finished.
const LIVE_WINDOW_SECONDS = 30;

/**
 * The turn currently streaming on this thread, if any, so a viewer knows to
 * start following. Returns null once the turn emitted 'done' or went quiet.
 *
 * Asked by the presence poll, which every viewer already runs — that is why it
 * has to stay a single cheap indexed lookup.
 */
export async function getLiveTurnId(
  tenantId: string,
  threadId: string,
): Promise<string | null> {
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT e.turn_id
       FROM agent_chat_turn_events e
       WHERE e.thread_id = $1
         AND e.created_at > NOW() - INTERVAL '${LIVE_WINDOW_SECONDS} seconds'
         AND NOT EXISTS (
           SELECT 1 FROM agent_chat_turn_events d
           WHERE d.turn_id = e.turn_id AND d.kind = 'done'
         )
       ORDER BY e.created_at DESC
       LIMIT 1`,
      [threadId],
    );
    return (rows[0]?.turn_id as string | undefined) ?? null;
  });
}

/**
 * Drop events for turns that finished a while ago. Opportunistic and scoped to
 * one thread, the same shape as the presence sweep: this is transient data and
 * a scheduled job would be one more thing to own for no benefit.
 */
export async function pruneTurnEvents(tenantId: string, threadId: string): Promise<void> {
  await withTenantScope(tenantId, (client) =>
    client.query(
      `DELETE FROM agent_chat_turn_events
       WHERE thread_id = $1 AND created_at < NOW() - INTERVAL '1 hour'`,
      [threadId],
    ),
  );
}
