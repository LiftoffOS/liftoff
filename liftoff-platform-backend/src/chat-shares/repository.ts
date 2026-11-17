// Chat share links repository.
//
// upsertShare is tenant-scoped (RLS). findShareById is a pre-tenant-context
// lookup by PK — the share row IS what identifies the tenant, so there is no
// tenant id to scope with until after the lookup; the router enforces
// membership on the row's tenant before returning anything.
//
// threadKind says which surface's thread the link points at: agent chat, a CAIO
// team plan (the `workforce` database), a Liftoff Insights thread, or a Liftoff
// thread. See migration 326 for why the thread FK had to go, and migration 350
// for why agent_id is nullable.

import { withAdminScope, withTenantScope } from '../infrastructure/database';

export type ChatThreadKind = 'agent' | 'team_plan' | 'insights' | 'liftoff';

/** The Chief AI Officer's internal_agents row (migration 194), the agent id
 *  every team_plan share carries: the row is the seeded system agent shared by
 *  every workspace, and a team_plan thread has exactly one participant, the
 *  CAIO. The frontend sends the same id when it shares a team plan
 *  (Liftoff-React src/constants/agents.ts). */
export const CAIO_SHARE_AGENT_ID = '00000000-0000-0000-0000-000000000001';

/**
 * What a share id resolves to, as a discriminated union rather than one shape
 * with a nullable agentId.
 *
 * agent and team_plan are addressed by an agent as well as a thread, so the
 * agent id travels with them. Liftoff Insights and Liftoff have no agent at all
 * (no internal_agents row, no agent in their URLs), so the key is absent for
 * those kinds rather than null or a placeholder uuid. The frontend already
 * switches on threadKind to route, so it narrows to the shape that has an
 * agentId exactly where one exists.
 */
export type ChatShareLink =
  | {
      tenantId: string;
      agentId: string;
      threadId: string;
      threadKind: 'agent' | 'team_plan';
    }
  | {
      tenantId: string;
      threadId: string;
      threadKind: 'insights' | 'liftoff';
    };

export async function upsertShare(
  tenantId: string,
  agentId: string | null,
  threadId: string,
  createdBy: string,
  threadKind: ChatThreadKind = 'agent',
): Promise<string> {
  // ON CONFLICT DO UPDATE (no-op form) so RETURNING id works on both paths.
  // Repeated shares of a thread return the same id; on multi-participant
  // threads the original agent_id/created_by win (stable link).
  const result = await withTenantScope(tenantId, (client) => client.query(
    `INSERT INTO chat_share_links (tenant_id, agent_id, thread_id, created_by, thread_kind)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, thread_id) DO UPDATE SET thread_id = EXCLUDED.thread_id
     RETURNING id`,
    [tenantId, agentId, threadId, createdBy, threadKind],
  ));
  return result.rows[0].id as string;
}

export async function findShareById(shareId: string): Promise<ChatShareLink | null> {
  const result = await withAdminScope(
    {
      caller: 'ChatSharesRepository.findShareById',
      reason: 'pre-tenant-context share-link lookup by PK; router checks membership on the row tenant',
    },
    (client) => client.query(
      `SELECT tenant_id, agent_id, thread_id, thread_kind FROM chat_share_links WHERE id = $1`,
      [shareId],
    ),
  );
  const row = result.rows[0];
  if (!row) return null;

  // Null reads as agent chat: rows written before migration 326 predate the
  // column, and undefined would fall through the router's kind dispatch to the
  // wrong existence check.
  const threadKind = (row.thread_kind ?? 'agent') as ChatThreadKind;

  if (threadKind === 'insights' || threadKind === 'liftoff') {
    return { tenantId: row.tenant_id, threadId: row.thread_id, threadKind };
  }

  // agent_id is non-null for exactly these two kinds, enforced by the pairing
  // CHECK in migration 350.
  return {
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    threadId: row.thread_id,
    threadKind,
  };
}
