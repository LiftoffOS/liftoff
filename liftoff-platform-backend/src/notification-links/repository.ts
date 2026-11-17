// Notification link repository.
//
// Same split as chat-shares/repository.ts, for the same reason: findOrCreate is
// tenant-scoped (RLS), while findLinkById is a pre-tenant-context lookup by
// primary key, because the row IS what identifies the tenant. There is no
// tenant id to scope with until after the lookup, so the router enforces
// membership on the row's tenant before returning anything.

import { withAdminScope, withTenantScope } from '../infrastructure/database';

export type NotificationDestination = 'review' | 'chat';

/** Which surface's table a chat thread id belongs to. The four are separate
 *  tables with separate routes, so a thread id alone does not say where to go.
 *  Mirrors chat_share_links.thread_kind, and for the same reason. */
export type NotificationSurface = 'agent' | 'liftoff' | 'insights' | 'team_plan';

/**
 * What a notification link id resolves to.
 *
 * A discriminated union rather than one shape with nullable fields, matching
 * ChatShareLink: a chat link always has a thread and the agent that owns it, a
 * review link has neither and carries at most the record it was raised for.
 */
export type NotificationLink =
  | {
      tenantId: string;
      destination: 'chat';
      /** Only agent chat is addressed by an agent as well as a thread. The
       *  platform surfaces have no internal_agents row at all. */
      surface: 'agent';
      agentId: string;
      threadId: string;
      recordId: string | null;
    }
  | {
      tenantId: string;
      destination: 'chat';
      surface: 'liftoff' | 'insights' | 'team_plan';
      threadId: string;
      recordId: string | null;
    }
  | {
      tenantId: string;
      destination: 'review';
      recordId: string | null;
    };

interface RawRow {
  tenantId: string;
  destination: NotificationDestination;
  surface: NotificationSurface;
  agentId: string | null;
  threadId: string | null;
  recordId: string | null;
}

/**
 * Find or create the canonical link for a destination.
 *
 * ON CONFLICT DO UPDATE in its no-op form so RETURNING id answers on both
 * paths, exactly as upsertShare does. The arbiter repeats the COALESCE
 * expressions from notification_links_destination_key verbatim, because that is
 * how Postgres infers an expression index: change one and the other stops
 * matching, and the insert starts raising a unique violation instead of
 * reusing the link.
 *
 * How much reuse you get depends on what the caller passes as recordId. The
 * out-of-turn chat path passes null, so every reply about a thread shares one
 * link. The escalation path passes the escalation id, so each escalation gets
 * its own row even when several land on the same thread. That is deliberate for
 * `review`, where the record IS the destination, and merely wasteful for
 * `chat`, where the thread already identifies it.
 */
export async function findOrCreateLink(input: {
  tenantId: string;
  destination: NotificationDestination;
  surface?: NotificationSurface;
  agentId: string | null;
  threadId: string | null;
  recordId: string | null;
}): Promise<string> {
  const result = await withTenantScope(input.tenantId, (client) => client.query(
    `INSERT INTO notification_links (tenant_id, destination, surface, agent_id, thread_id, record_id)
          VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, destination, surface, COALESCE(thread_id::text, ''), COALESCE(record_id, ''))
     DO UPDATE SET destination = EXCLUDED.destination
       RETURNING id`,
    [
      input.tenantId,
      input.destination,
      input.surface ?? 'agent',
      input.agentId,
      input.threadId,
      input.recordId,
    ],
  ));
  return result.rows[0].id as string;
}

/**
 * Resolve a link id. Admin-scoped because the caller has no tenant context yet:
 * the row is what supplies it. Returns null for an unknown id, and for a row
 * whose shape does not match its destination, which would otherwise hand the
 * frontend a chat link with nothing to open.
 */
export async function findLinkById(id: string): Promise<NotificationLink | null> {
  const row = await withAdminScope(
    { caller: 'notificationLinks.repository.findLinkById', reason: 'resolve a notification link' },
    async (c) => {
      const r = await c.query<RawRow>(
        `SELECT tenant_id AS "tenantId", destination, surface,
                agent_id AS "agentId", thread_id AS "threadId", record_id AS "recordId"
           FROM notification_links WHERE id = $1`,
        [id],
      );
      return r.rows[0] ?? null;
    },
  );
  if (!row) return null;

  if (row.destination === 'chat') {
    // Every chat surface needs a thread; only agent chat needs an agent too.
    if (!row.threadId) return null;

    if (row.surface === 'agent') {
      if (!row.agentId) return null;
      return {
        tenantId: row.tenantId,
        destination: 'chat',
        surface: 'agent',
        agentId: row.agentId,
        threadId: row.threadId,
        recordId: row.recordId,
      };
    }

    return {
      tenantId: row.tenantId,
      destination: 'chat',
      surface: row.surface,
      threadId: row.threadId,
      recordId: row.recordId,
    };
  }

  return { tenantId: row.tenantId, destination: 'review', recordId: row.recordId };
}
