// Team-plan chat presence (migration 014).
//
// Who is currently in a CAIO thread, and who is typing. The stored message
// answers "who wrote this"; this answers "who is here now".
//
// Ported from platform-backend src/agent-chat/presence-repository.ts, with one
// structural difference: the `accounts` table lives in platform-backend's
// database, not this one, so the query returns account ids and the router
// hydrates names and avatars through account-profiles.ts. Everything else —
// the windows, the opportunistic sweep, the single round trip per poll — is
// deliberately identical, because the frontend consumes one response shape for
// both chat surfaces.

import { withTenantContext } from '../infrastructure/rls.js';

// How long after their last heartbeat someone still counts as present. Clients
// poll every ~3s, so this tolerates a dropped poll or two without flicker.
const PRESENCE_WINDOW_SECONDS = 45;

// Typing decays faster than presence: a client that dies mid-compose should
// stop claiming to type long before it stops counting as present.
const TYPING_WINDOW_SECONDS = 8;

// How recently a turn must have emitted to count as live. Comfortably longer
// than the recorder's flush interval so a quiet stretch mid-turn (a slow tool
// call) does not read as finished.
const LIVE_TURN_WINDOW_SECONDS = 30;

export type PresenceState = 'viewing' | 'typing';

/** A viewer as this repository knows them: identity only, no profile. */
export interface ThreadPresenceViewer {
  accountId: string;
  typing: boolean;
}

export interface ThreadPresenceRaw {
  viewers: ThreadPresenceViewer[];
  /** Turn currently streaming on this thread, if any. Lets a viewer who is not
   *  the sender start following its execution events instead of watching a
   *  frozen thread until the reply lands. */
  liveTurnId: string | null;
  /** Newest message timestamp in the thread, or null when it has none. Lets a
   *  viewer notice somebody else's message landed without polling the message
   *  list separately. */
  latestMessageAt: string | null;
}

/**
 * Record that this account is on this thread, then return everyone currently
 * on it, the live turn, and the newest message timestamp.
 *
 * Returns the caller too. Whether you show yourself in a facepile is a UI
 * decision, and hiding it here would stop the client from confirming its own
 * heartbeat landed.
 */
export async function heartbeatAndListPresence(
  tenantId: string,
  threadId: string,
  accountId: string,
  state: PresenceState,
): Promise<ThreadPresenceRaw> {
  return withTenantContext(tenantId, async (client) => {
    await client.query(
      `INSERT INTO team_plan_presence (thread_id, account_id, tenant_id, state, last_seen_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (thread_id, account_id)
       DO UPDATE SET state = EXCLUDED.state, last_seen_at = NOW()`,
      [threadId, accountId, tenantId, state],
    );

    // Opportunistic cleanup, scoped to this thread so it stays a handful of
    // rows. Deliberately not a scheduled sweep: reads already filter on the
    // staleness window, so this only keeps the table from accumulating rows
    // for threads nobody visits.
    await client.query(
      `DELETE FROM team_plan_presence
       WHERE thread_id = $1 AND last_seen_at < NOW() - INTERVAL '1 hour'`,
      [threadId],
    );

    const viewers = await client.query(
      `SELECT account_id,
              (state = 'typing'
               AND last_seen_at > NOW() - INTERVAL '${TYPING_WINDOW_SECONDS} seconds') AS typing
       FROM team_plan_presence
       WHERE thread_id = $1
         AND last_seen_at > NOW() - INTERVAL '${PRESENCE_WINDOW_SECONDS} seconds'
       ORDER BY last_seen_at DESC`,
      [threadId],
    );

    const latest = await client.query(
      `SELECT MAX(m.created_at) AS latest_message_at
       FROM team_plan_messages m
       WHERE m.thread_id = $1`,
      [threadId],
    );
    const latestMessageAt = latest.rows[0]?.latest_message_at as Date | null | undefined;

    // Same transaction as the heartbeat so a viewer never learns about a turn
    // in one poll and loses it in the next through a read landing elsewhere.
    const live = await client.query(
      `SELECT e.turn_id
       FROM team_plan_turn_events e
       WHERE e.thread_id = $1
         AND e.created_at > NOW() - INTERVAL '${LIVE_TURN_WINDOW_SECONDS} seconds'
         AND NOT EXISTS (
           SELECT 1 FROM team_plan_turn_events d
           WHERE d.turn_id = e.turn_id AND d.kind = 'done'
         )
       ORDER BY e.created_at DESC
       LIMIT 1`,
      [threadId],
    );

    return {
      viewers: viewers.rows.map((r) => ({
        accountId: r.account_id as string,
        typing: r.typing === true,
      })),
      latestMessageAt: latestMessageAt ? latestMessageAt.toISOString() : null,
      liveTurnId: (live.rows[0]?.turn_id as string | undefined) ?? null,
    };
  });
}

/**
 * Drop this account's presence on a thread. Best effort: called when the tab
 * goes away, which is exactly when a request is least likely to complete, so
 * the staleness window remains the real guarantee.
 */
export async function clearPresence(
  tenantId: string,
  threadId: string,
  accountId: string,
): Promise<void> {
  await withTenantContext(tenantId, (client) =>
    client.query(
      `DELETE FROM team_plan_presence WHERE thread_id = $1 AND account_id = $2`,
      [threadId, accountId],
    ),
  );
}

/**
 * How many people other than the sender are currently on this thread.
 *
 * Used to decide whether a turn is worth recording for observers: with no
 * audience the recorder writes nothing, so the cost of the feature scales with
 * actual collaboration rather than with traffic.
 */
export async function countOtherViewers(
  tenantId: string,
  threadId: string,
  excludeAccountId: string | null,
): Promise<number> {
  return withTenantContext(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n
       FROM team_plan_presence
       WHERE thread_id = $1
         AND last_seen_at > NOW() - INTERVAL '${PRESENCE_WINDOW_SECONDS} seconds'
         AND ($2::uuid IS NULL OR account_id <> $2::uuid)`,
      [threadId, excludeAccountId],
    );
    return (rows[0]?.n as number | undefined) ?? 0;
  });
}

// Deliberately tighter than PRESENCE_WINDOW_SECONDS. That window answers "show
// this person in the roster", where 45s of tolerance stops an avatar flickering
// on a dropped poll. This one answers "did they watch the reply arrive", where
// the same tolerance suppresses the notification of somebody who left the tab
// half a minute ago — the exact person the notification exists for. A heartbeat
// is ~3s, so 8s still absorbs two missed polls.
const WATCHING_NOW_SECONDS = 8;

/**
 * Is this person watching this thread right now?
 *
 * Read before notifying: watching a reply appear is the same as having been
 * told, and a notification for it is noise. The frontend releases its seat when
 * the tab is hidden, so a background tab reads as absent here rather than as a
 * reader.
 */
export async function isAccountPresent(
  tenantId: string,
  threadId: string,
  accountId: string,
): Promise<boolean> {
  return withTenantContext(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT 1
       FROM team_plan_presence
       WHERE thread_id = $1
         AND account_id = $2
         AND last_seen_at > NOW() - INTERVAL '${WATCHING_NOW_SECONDS} seconds'
       LIMIT 1`,
      [threadId, accountId],
    );
    return rows.length > 0;
  });
}

/**
 * Is this person present in this thread, by the roster's own 45-second
 * window?
 *
 * Read by the control plane's stale-driver sweep for a browser session whose
 * driver is on this surface: the same window the other three chat surfaces
 * read from their own presence tables, so absence is noticed within about
 * two minutes everywhere. Deliberately NOT `isAccountPresent`, whose eight
 * seconds is a notification decision; a sweep on that window would take the
 * keyboard from a driver who dropped one poll.
 */
export async function isAccountRecentlyPresent(
  tenantId: string,
  threadId: string,
  accountId: string,
): Promise<boolean> {
  return withTenantContext(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT 1
       FROM team_plan_presence
       WHERE thread_id = $1
         AND account_id = $2
         AND last_seen_at > NOW() - INTERVAL '${PRESENCE_WINDOW_SECONDS} seconds'
       LIMIT 1`,
      [threadId, accountId],
    );
    return rows.length > 0;
  });
}
