// Shared Chat Presence Repository
//
// Who is currently in a Liftoff or an Insights thread, and who is typing.
// Migration 351.
//
// Both surfaces became workspace-wide in that migration: any member can open any
// thread. That is what makes presence worth having here. While a thread was
// private to its author there was never anybody else in it to show.
//
// This is the agent-chat presence design (src/agent-chat/presence-repository.ts,
// migration 306) with one table serving two surfaces instead of one table serving
// one. Everything else is deliberately identical, including the windows, because
// the frontend polls all three through the same transport interface and a surface
// that decayed on a different schedule would look broken next to the others.
//
// Delivery is polling, not a live connection. platform-backend runs on Cloud
// Run with min_instances=0, concurrency=80, a 900s request cap and no session
// affinity, so a long-lived SSE/WebSocket per viewer is not viable: it would be
// killed at 15 minutes, would hold a concurrency slot for its whole life, and
// would land on an arbitrary instance with no way to address it.
//
// One call does both halves of a poll, write my heartbeat and read everyone
// else's, so a viewer costs one request per interval rather than two.
//
// RLS: platform_chat_presence is tenant-scoped and FORCE RLS, so every path here
// goes through withTenantScope. `accounts` is platform-global and RLS-exempt
// (migration 095), so joining it inside that scope is safe. The per-surface
// message tables are read in the same scope: they carry no tenant_id and no
// policy, inheriting tenancy from the thread the caller already resolved. The
// lock tables are read through src/common/turn-registry.ts, which this passes
// its own client so the read stays inside this transaction.

import { withTenantScope } from '../infrastructure/database';
import { liveTurnId as registryLiveTurnId } from './turn-registry';

/** The two platform chat surfaces. Team chat has its own table and repository:
 *  its presence rows are foreign-keyed to `agent_chat_threads`, which is a real
 *  guarantee worth keeping rather than folding in here. */
export type PresenceSurface = 'liftoff' | 'insights';

export type PresenceState = 'viewing' | 'typing';

// How long after their last heartbeat someone still counts as present. Clients
// poll every ~3s, so this tolerates a dropped poll or two without flicker.
const PRESENCE_WINDOW_SECONDS = 45;

// Typing decays faster than presence: a client that dies mid-compose should
// stop claiming to type long before it stops counting as present.
const TYPING_WINDOW_SECONDS = 8;

// Table names are interpolated into SQL, so they can only ever come from here.
// Same rule as the shared rate limiter: a surface is an enum the router already
// validated, never a caller-supplied string.
//
// `messages` backs latestMessageAt. Per surface because the two chats were built
// as independent stacks (migrations 074/332 for Insights, 348 for Liftoff) and
// share no storage.
//
// The lock tables used to be here too, which is how this file came to hold a
// fourth hand-written copy of "is a turn running" that disagreed with the
// comment above it. They are the turn registry's, and only its
// (INV-PB-018).
const SURFACE_TABLES: Record<PresenceSurface, { messages: string }> = {
  liftoff: { messages: 'liftoff_chat_messages' },
  insights: { messages: 'insights_chat_messages' },
};

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
  /** The turn running on this thread right now, or null.
   *
   *  Read from the surface's turn lock, which exists for exactly as long as a
   *  turn does, so a non-null value means a reply is being generated. It is an
   *  indicator, NOT a cursor: unlike team chat, neither of these surfaces
   *  records per-turn execution events, so there is nothing for a non-sender to
   *  replay. What they get instead is latestMessageAt, which changes when the
   *  reply lands. */
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
 * on it, the newest message timestamp, and the turn in flight if there is one.
 *
 * Returns the caller too. Whether you show yourself in a facepile is a UI
 * decision, and hiding it here would stop the client from confirming its own
 * heartbeat landed.
 */
export async function heartbeatAndListPresence(
  surface: PresenceSurface,
  tenantId: string,
  threadId: string,
  accountId: string,
  state: PresenceState,
): Promise<ThreadPresence> {
  const tables = SURFACE_TABLES[surface];

  return withTenantScope(tenantId, async (client) => {
    await client.query(
      `INSERT INTO platform_chat_presence (surface, thread_id, account_id, tenant_id, state, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (surface, thread_id, account_id)
       DO UPDATE SET state = EXCLUDED.state, last_seen_at = NOW()`,
      [surface, threadId, accountId, tenantId, state],
    );

    // Opportunistic cleanup, scoped to this thread so it stays a handful of
    // rows. Deliberately not a Cloud Scheduler sweep: reads already filter on
    // the staleness window, so this only keeps the table from accumulating
    // rows for threads nobody visits, and doing it here avoids a Terraform
    // change for a table that would otherwise need one. It is also the only
    // reaper this table has, since it carries no cascade from a thread.
    await client.query(
      `DELETE FROM platform_chat_presence
       WHERE surface = $1 AND thread_id = $2 AND last_seen_at < NOW() - INTERVAL '1 hour'`,
      [surface, threadId],
    );

    const viewers = await client.query(
      `SELECT p.account_id, a.first_name, a.last_name, a.email, a.avatar_url,
              (p.state = 'typing'
               AND p.last_seen_at > NOW() - INTERVAL '${TYPING_WINDOW_SECONDS} seconds') AS typing
       FROM platform_chat_presence p
       JOIN accounts a ON a.id = p.account_id
       WHERE p.surface = $1
         AND p.thread_id = $2
         AND p.last_seen_at > NOW() - INTERVAL '${PRESENCE_WINDOW_SECONDS} seconds'
       ORDER BY p.last_seen_at DESC`,
      [surface, threadId],
    );

    // No tenant_id on either message table: tenancy is inherited from the
    // thread, which the router resolved and permission-checked before calling.
    const latest = await client.query(
      `SELECT MAX(created_at) AS latest_message_at
       FROM ${tables.messages}
       WHERE thread_id = $1`,
      [threadId],
    );
    const latestMessageAt = latest.rows[0]?.latest_message_at as Date | null | undefined;

    // This client, not a fresh scope, so the read is in the same transaction as
    // the heartbeat above: a viewer never learns about a turn in one poll and
    // loses it in the next through a read landing elsewhere.
    //
    // The predicate is the registry's. For most of this file's life the comment
    // here said "an expired lock does not count — a container that died mid-turn
    // must not leave the thread looking busy for the rest of the expiry window",
    // directly above SQL that read `expires_at > NOW()` and therefore did
    // exactly that. The heartbeat was 2 minutes into a 20-minute lease, so the
    // property was not reachable from this query at all; it is now a fact on the
    // row (`heartbeat_at`) that one module reads (INV-PB-018).
    const live = await registryLiveTurnId(surface, tenantId, threadId, client);

    return {
      viewers: viewers.rows.map(mapPresenceRow),
      latestMessageAt: latestMessageAt ? latestMessageAt.toISOString() : null,
      liveTurnId: live,
    };
  });
}

/**
 * Drop this account's presence on a thread. Best effort: called when the tab
 * goes away, which is exactly when a request is least likely to complete, so
 * the staleness window remains the real guarantee.
 */
export async function clearPresence(
  surface: PresenceSurface,
  tenantId: string,
  threadId: string,
  accountId: string,
): Promise<void> {
  await withTenantScope(tenantId, (client) =>
    client.query(
      `DELETE FROM platform_chat_presence
       WHERE surface = $1 AND thread_id = $2 AND account_id = $3`,
      [surface, threadId, accountId],
    ),
  );
}

// Deliberately tighter than PRESENCE_WINDOW_SECONDS. That window answers "show
// this person in the roster", where 45s of tolerance stops an avatar flickering
// on a dropped poll. This one answers "did they watch the reply arrive", where
// the same tolerance suppresses the notification of somebody who left the tab
// half a minute ago — the exact person the feature exists for. A heartbeat is
// ~3s, so 8s still absorbs two missed polls.
const WATCHING_NOW_SECONDS = 8;

/**
 * Is this person watching this thread right now?
 *
 * Read before notifying: watching a reply appear is the same as having been
 * told, and a notification for it is noise. The frontend also releases its seat
 * when the tab is hidden, so a background tab reads as absent here rather than
 * as a reader.
 */
export async function isAccountPresent(
  surface: PresenceSurface,
  tenantId: string,
  threadId: string,
  accountId: string,
): Promise<boolean> {
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT 1
         FROM platform_chat_presence
        WHERE surface = $1
          AND thread_id = $2
          AND account_id = $3
          AND last_seen_at > NOW() - INTERVAL '${WATCHING_NOW_SECONDS} seconds'
        LIMIT 1`,
      [surface, threadId, accountId],
    );
    return rows.length > 0;
  });
}
