// Agent Chat Presence Repository
//
// Who is currently in a thread, and who is typing. Migration 306.
//
// Delivery is polling, not a live connection. platform-backend runs on Cloud
// Run with min_instances=0, concurrency=80, a 900s request cap and no session
// affinity, so a long-lived SSE/WebSocket per viewer is not viable: it would be
// killed at 15 minutes, would hold a concurrency slot for its whole life, and
// would land on an arbitrary instance with no way to address it. The heartbeat
// pattern here mirrors the tunnel deployments one (src/tunnels/*), which uses
// a 90s staleness window.
//
// One call does both halves of a poll — write my heartbeat, read everyone
// else's — so a viewer costs one request per interval rather than two.
//
// RLS: agent_chat_presence is tenant-scoped and FORCE RLS, so every path here
// goes through withTenantScope. `accounts` is platform-global and RLS-exempt
// (migration 095), so joining it inside that scope is safe.

import { withTenantScope } from '../infrastructure/database';

// How long after their last heartbeat someone still counts as present. Clients
// poll every ~3s, so this tolerates a dropped poll or two without flicker.
const PRESENCE_WINDOW_SECONDS = 45;

/** How recent a heartbeat must be to count as actively watching, for the one
 *  decision that suppresses a notification. Just over one 3s client poll, so a
 *  visible tab always qualifies and a hidden one stops qualifying almost at
 *  once. The client now clears its seat on visibilitychange as well; this is
 *  the backstop for when that request does not arrive. */
const WATCHING_NOW_SECONDS = 8;

// Typing decays faster than presence: a client that dies mid-compose should
// stop claiming to type long before it stops counting as present.
const TYPING_WINDOW_SECONDS = 8;

export type PresenceState = 'viewing' | 'typing';

export interface ThreadPresenceEntry {
  accountId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatarUrl: string | null;
  typing: boolean;
}

export interface ThreadPresence {
  viewers: ThreadPresenceEntry[];
  /** Turn currently streaming on this thread, if any. Lets a viewer who is not
   *  the sender start following its execution events instead of watching a
   *  frozen thread until the reply lands. */
  liveTurnId: string | null;
  /** Newest message timestamp in the thread, or null when it has none. Lets a
   *  viewer notice somebody else's message landed without polling the message
   *  list separately. */
  latestMessageAt: string | null;
}

function mapPresenceRow(row: Record<string, unknown>): ThreadPresenceEntry {
  return {
    accountId: row.account_id as string,
    firstName: (row.first_name as string | null) ?? null,
    lastName: (row.last_name as string | null) ?? null,
    email: row.email as string,
    avatarUrl: (row.avatar_url as string | null) ?? null,
    typing: row.typing === true,
  };
}

/**
 * Record that this account is on this thread, then return everyone currently
 * on it plus the newest message timestamp.
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
): Promise<ThreadPresence> {
  return withTenantScope(tenantId, async (client) => {
    await client.query(
      `INSERT INTO agent_chat_presence (thread_id, account_id, tenant_id, state, last_seen_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (thread_id, account_id)
       DO UPDATE SET state = EXCLUDED.state, last_seen_at = NOW()`,
      [threadId, accountId, tenantId, state],
    );

    // Opportunistic cleanup, scoped to this thread so it stays a handful of
    // rows. Deliberately not a Cloud Scheduler sweep: reads already filter on
    // the staleness window, so this only keeps the table from accumulating
    // rows for threads nobody visits, and doing it here avoids a Terraform
    // change for a table that would otherwise need one.
    await client.query(
      `DELETE FROM agent_chat_presence
       WHERE thread_id = $1 AND last_seen_at < NOW() - INTERVAL '1 hour'`,
      [threadId],
    );

    const viewers = await client.query(
      `SELECT p.account_id, a.first_name, a.last_name, a.email, a.avatar_url,
              (p.state = 'typing'
               AND p.last_seen_at > NOW() - INTERVAL '${TYPING_WINDOW_SECONDS} seconds') AS typing
       FROM agent_chat_presence p
       JOIN accounts a ON a.id = p.account_id
       WHERE p.thread_id = $1
         AND p.last_seen_at > NOW() - INTERVAL '${PRESENCE_WINDOW_SECONDS} seconds'
       ORDER BY p.last_seen_at DESC`,
      [threadId],
    );

    const latest = await client.query(
      `SELECT MAX(created_at) AS latest_message_at
       FROM agent_chat_messages
       WHERE thread_id = $1 AND tenant_id = $2`,
      [threadId, tenantId],
    );
    const latestMessageAt = latest.rows[0]?.latest_message_at as Date | null | undefined;

    // Same transaction as the heartbeat so a viewer never learns about a turn
    // in one poll and loses it in the next through a read landing elsewhere.
    const live = await client.query(
      `SELECT e.turn_id
       FROM agent_chat_turn_events e
       WHERE e.thread_id = $1
         AND e.created_at > NOW() - INTERVAL '30 seconds'
         AND NOT EXISTS (
           SELECT 1 FROM agent_chat_turn_events d
           WHERE d.turn_id = e.turn_id AND d.kind = 'done'
         )
       ORDER BY e.created_at DESC
       LIMIT 1`,
      [threadId],
    );

    return {
      viewers: viewers.rows.map(mapPresenceRow),
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
  await withTenantScope(tenantId, (client) =>
    client.query(
      `DELETE FROM agent_chat_presence WHERE thread_id = $1 AND account_id = $2`,
      [threadId, accountId],
    ),
  );
}

/**
 * Is this person looking at this thread RIGHT NOW?
 *
 * Deliberately a much tighter window than the 45s the roster uses, and that
 * difference is the whole point.
 *
 * The roster is asking "is this tab open", where a name lingering a few seconds
 * after somebody leaves costs nothing. This is asking "would a notification be
 * redundant", and the two answers diverge for exactly as long as the window.
 * Running this at 45s meant somebody who switched tabs to wait for a reply was
 * still counted as watching when it landed, so the notification was suppressed
 * for precisely the person who needed it — every time, silently, and the
 * feature looked broken rather than opinionated.
 *
 * The two errors are not symmetric. Suppressing wrongly costs the whole
 * feature; notifying wrongly costs one redundant notification for somebody who
 * is already looking at the answer. So this errs towards sending.
 */
export async function isAccountPresent(
  tenantId: string,
  threadId: string,
  accountId: string,
): Promise<boolean> {
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT 1
         FROM agent_chat_presence
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
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n
       FROM agent_chat_presence
       WHERE thread_id = $1
         AND last_seen_at > NOW() - INTERVAL '${PRESENCE_WINDOW_SECONDS} seconds'
         AND ($2::uuid IS NULL OR account_id <> $2::uuid)`,
      [threadId, excludeAccountId],
    );
    return (rows[0]?.n as number | undefined) ?? 0;
  });
}
