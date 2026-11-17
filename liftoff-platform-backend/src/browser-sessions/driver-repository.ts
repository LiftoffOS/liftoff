// Who currently has the wheel on a browser session (migration 308).
//
// tenant-runtime owns whether a session is under human control
// (web_sessions.takeover_state, enforced against the agent at tool dispatch).
// This owns who that human is, because only the control plane can resolve an
// account to a person. Neither is useful alone: takeover_state without a name
// cannot tell observers whose session they are watching, and a name without
// takeover_state is a claim nobody enforces.

import { withTenantScope } from '../infrastructure/database';
import { teamPlanDriverPresent } from '../workforce-plans/team-plan-thread-client';

export interface SessionDriver {
  accountId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatarUrl: string | null;
  takenAt: string;
  /** False once the driver's chat presence has gone stale — they closed the
   *  tab or wandered off. Control is theirs in name only at that point, so the
   *  UI offers it up without ceremony. Null when presence is not knowable
   *  here: no presence source was named, or the surface keeps its presence in
   *  another service. Null is never acted on; only false is. */
  present: boolean | null;
}

/** Where a driver's presence is read from. Each chat surface keeps its
 *  heartbeat in its own table, and a driver who heartbeats in another table
 *  reads as absent from the wrong one, which the sweep then acts on.
 *
 *    agent               agent_chat_presence (migration 306)
 *    liftoff, insights   platform_chat_presence (migration 351)
 *    team_plan           workforce-service's own database, which this one
 *                        cannot see: it is ASKED, for the recorded driver on
 *                        the thread, over the same 45-second window. A driver
 *                        whose own tab is hidden reads absent there, as on
 *                        the other surfaces; when workforce-service cannot
 *                        answer, presence is null and the sweep does nothing. */
export interface DriverPresenceSource {
  surface: 'agent' | 'liftoff' | 'insights' | 'team_plan';
  /** The account making the read, when known. */
  callerAccountId?: string;
  /** The thread the session belongs to, which the active handler has; the
   *  team_plan lookup is per thread. */
  threadId?: string;
}

// Matches the presence window in agent-chat/presence-repository.ts and
// common/chat-presence-repository.ts. A driver who has not polled within it
// is treated as gone.
const DRIVER_PRESENCE_WINDOW_SECONDS = 45;

export async function claimDriver(
  tenantId: string,
  sessionId: string,
  accountId: string,
): Promise<void> {
  await withTenantScope(tenantId, (client) =>
    client.query(
      `INSERT INTO browser_session_drivers (session_id, tenant_id, account_id, taken_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (session_id)
       DO UPDATE SET account_id = EXCLUDED.account_id, taken_at = NOW()`,
      [sessionId, tenantId, accountId],
    ),
  );
}

export async function releaseDriver(tenantId: string, sessionId: string): Promise<void> {
  await withTenantScope(tenantId, (client) =>
    client.query(`DELETE FROM browser_session_drivers WHERE session_id = $1`, [sessionId]),
  );
}

/** The presence subquery for a surface whose heartbeat lives in this
 *  database, or null when it does not. Table names come from here only. */
function presenceSql(surface: DriverPresenceSource['surface']): string | null {
  switch (surface) {
    case 'agent':
      return `EXISTS (
                SELECT 1 FROM agent_chat_presence p
                WHERE p.account_id = d.account_id
                  AND p.last_seen_at > NOW() - INTERVAL '${DRIVER_PRESENCE_WINDOW_SECONDS} seconds'
              )`;
    case 'liftoff':
    case 'insights':
      return `EXISTS (
                SELECT 1 FROM platform_chat_presence p
                WHERE p.surface = '${surface}'
                  AND p.account_id = d.account_id
                  AND p.last_seen_at > NOW() - INTERVAL '${DRIVER_PRESENCE_WINDOW_SECONDS} seconds'
              )`;
    case 'team_plan':
      return null;
  }
}

/**
 * Resolve the driver of a session, if any, joined to their account and, when
 * a presence source is named, to their chat presence on THAT surface so the
 * caller can tell a live driver from an absent one. Without a source, or on a
 * surface whose presence lives elsewhere, `present` is null: unknown, and
 * never acted on.
 *
 * `accounts` is platform-global and RLS-exempt (migration 095), so joining it
 * inside the tenant scope is safe.
 */
export async function getDriver(
  tenantId: string,
  sessionId: string,
  presence?: DriverPresenceSource,
): Promise<SessionDriver | null> {
  const presenceColumn = presence ? presenceSql(presence.surface) : null;
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT d.account_id, d.taken_at,
              a.first_name, a.last_name, a.email, a.avatar_url,
              ${presenceColumn ?? 'NULL::boolean'} AS present
       FROM browser_session_drivers d
       JOIN accounts a ON a.id = d.account_id
       WHERE d.session_id = $1`,
      [sessionId],
    );
    const row = rows[0];
    if (!row) return null;
    const accountId = row.account_id as string;
    let present: boolean | null = row.present === true ? true : row.present === false ? false : null;
    // The Chief AI Officer surface keeps its presence in workforce-service:
    // ask it about the recorded driver on this thread. Null only when it
    // could not answer, and null still sweeps nothing.
    if (presence?.surface === 'team_plan' && presence.threadId) {
      present = await teamPlanDriverPresent({ tenantId, threadId: presence.threadId, accountId });
    }
    return {
      accountId,
      firstName: (row.first_name as string | null) ?? null,
      lastName: (row.last_name as string | null) ?? null,
      email: row.email as string,
      avatarUrl: (row.avatar_url as string | null) ?? null,
      takenAt: (row.taken_at as Date).toISOString(),
      present,
    };
  });
}
