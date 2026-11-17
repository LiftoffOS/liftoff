// Messages delivered into a Chief AI Officer turn that is already running
// (migration 018).
//
// The sibling of active-turn-repository.ts: that one carries the stop bit on
// the claim row, this one carries the messages a person types while the reply
// is still streaming. Same reasoning for both — the turn is an async generator
// inside somebody else's request, on an instance this one cannot address, so
// what has to reach it is written down and read back by the loop.
//
// Every function here is best-effort from the turn's point of view. A message
// that cannot be read is a turn that carries on as it was, which is what would
// have happened anyway — so nothing in this file may throw into the turn loop.

import { withTenantContext } from '../infrastructure/rls.js';
import { log } from '../infrastructure/logging.js';

/** How long a claim row stays worth delivering into. Matches the stoppable
 *  window in active-turn-repository.ts: past it, an instance killed mid-turn
 *  has left the row behind and there is nothing running to receive anything. */
const CLAIM_LIVE_MINUTES = 15;

export interface MidRunUserMessage {
  text: string;
  senderDisplayName: string | null;
  senderAccountId: string | null;
}

/** What happened to a message the caller tried to deliver.
 *
 *  'no_turn' is the honest answer to a race the foreign key makes visible: the
 *  turn ended between the caller reading the claim and writing the signal, so
 *  the row was rejected rather than left for nobody to read. The caller starts
 *  a fresh turn instead of reporting a conflict. */
export type SignalDelivery = 'delivered' | 'no_turn' | 'unavailable';

function isRelationMissingError(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01';
}

function isForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23503';
}

/** Wording for something delivered into a run that is already under way.
 *
 *  Copied verbatim from Liftoff-Tenant-Runtime
 *  src/agent-execution/interrupt-framing.ts. Both halves do real work: sender
 *  attribution changes how the agent reads the message, and the "mid-run
 *  addition to the current task" clause stops it from abandoning what it was
 *  doing and answering the new line as a fresh request. */
export function frameInterrupt(i: {
  text: string; senderDisplayName: string | null; senderAccountId: string | null;
}): string {
  const who = i.senderDisplayName?.trim();
  return (who ? `${who} just sent a message while you were working: ` : 'A user message arrived while you were working: ')
    + `"${i.text}"\n`
    + 'This is a mid-run addition to the current task, not a new task. Take it into '
    + 'account — adjust course, answer it, or acknowledge it in your reply as appropriate.';
}

/**
 * The turn running on this thread right now, or null.
 *
 * A claim older than the live window does not count: the instance that wrote it
 * is gone, and delivering into it would tell the person their message landed
 * somewhere when nothing is there to answer it.
 */
export async function findLiveTurnId(
  tenantId: string,
  threadId: string,
): Promise<string | null> {
  try {
    return await withTenantContext(tenantId, async (client) => {
      const result = await client.query(
        `SELECT turn_id FROM team_plan_active_turns
         WHERE thread_id = $1
           AND started_at > NOW() - INTERVAL '${CLAIM_LIVE_MINUTES} minutes'`,
        [threadId],
      );
      return (result.rows[0]?.turn_id as string | undefined) ?? null;
    });
  } catch (err) {
    // A failed read must read as "nothing is running", never as a conflict:
    // the worst case is one extra turn, not a message that goes nowhere.
    log.warn(
      { threadId, error: (err as Error).message },
      'CAIO: live-turn lookup failed - treating the thread as idle',
    );
    return null;
  }
}

/** Deliver a message into a running turn. */
export async function deliverUserMessage(
  tenantId: string,
  turnId: string,
  message: MidRunUserMessage,
): Promise<SignalDelivery> {
  try {
    await withTenantContext(tenantId, (client) =>
      client.query(
        `INSERT INTO team_plan_turn_signals (turn_id, signal_kind, payload)
         VALUES ($1, 'user_message', $2)`,
        [turnId, JSON.stringify({ ...message, sentAt: new Date().toISOString() })],
      ),
    );
    return 'delivered';
  } catch (err) {
    if (isForeignKeyViolation(err)) return 'no_turn';
    if (isRelationMissingError(err)) return 'unavailable';
    log.warn(
      { turnId, error: (err as Error).message },
      'CAIO: could not deliver the mid-run message',
    );
    return 'unavailable';
  }
}

/**
 * Claim the oldest message waiting for this turn, if any.
 *
 * The UPDATE ... RETURNING is the claim: the end-of-iteration poll and the
 * poll at the break cannot both deliver the same message.
 */
export async function claimUserMessage(
  tenantId: string,
  turnId: string,
): Promise<MidRunUserMessage | null> {
  try {
    return await withTenantContext(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE team_plan_turn_signals SET consumed_at = NOW()
         WHERE id IN (
           SELECT id FROM team_plan_turn_signals
           WHERE turn_id = $1 AND signal_kind = 'user_message' AND consumed_at IS NULL
           ORDER BY created_at ASC
           LIMIT 1)
         RETURNING payload`,
        [turnId],
      );
      const payload = result.rows[0]?.payload as
        | { text?: string; senderDisplayName?: string | null; senderAccountId?: string | null }
        | undefined;
      if (!payload) return null;
      return {
        text: payload.text ?? '',
        senderDisplayName: payload.senderDisplayName ?? null,
        senderAccountId: payload.senderAccountId ?? null,
      };
    });
  } catch (err) {
    // Same rule as the stop check: a failed read is "nothing waiting", never a
    // reason to end the turn.
    log.warn(
      { turnId, error: (err as Error).message },
      'CAIO: mid-run message check failed - treating as nothing waiting',
    );
    return null;
  }
}
