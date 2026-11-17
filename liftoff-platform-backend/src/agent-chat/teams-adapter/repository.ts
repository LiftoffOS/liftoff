// Teams-adapter repository: tenant-install + conversation queries.
//
// Centralises the SQL so callers don't scatter withTenantScope/withAdminScope
// blocks. Inbound webhooks arrive with no tenant context (only the Azure AD
// tenant id), so findTenantByAadTenant runs under withAdminScope; everything
// else runs under tenant scope to honour RLS on teams_tenant_installs /
// agent_teams_conversations (migrations 271/272).

import { getPool, withTenantScope, withAdminScope } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import { ASSISTANT_TARGETS, assistantByKind, isAssistantKind, type AssistantKind } from '../assistant-targets';

export interface TeamsTenantInstall {
  tenantId: string;
  azureAdTenantId: string;
  serviceUrl: string | null;
  consentState: 'pending' | 'app_consented' | 'published' | 'error';
  catalogTeamsAppId: string | null;
  graphAdminRefreshSecretPath: string | null;
  appPublishedAt: string | null;
}

export interface TeamsConversationRow {
  conversationId: string;
  agentId: string;
  azureAdTenantId: string;
  scope: 'personal' | 'channel' | 'groupChat';
  aadUserId: string | null;
  accountId: string | null;
  conversationReference: Record<string, unknown>;
}

export interface PickerAgent {
  agentId: string;
  label: string;
}

// ── Tenant mapping ──────────────────────────────────────────────────────────

/**
 * Resolve a Liftoff tenant from the inbound Activity's Azure AD tenant id.
 * Runs under withAdminScope because an inbound Bot Framework activity has no
 * tenant GUC set yet — this lookup is what establishes the tenant context.
 */
export async function findTenantByAadTenant(
  azureAdTenantId: string,
): Promise<string | null> {
  return withAdminScope(
    { caller: 'teams-adapter', reason: 'webhook tenant resolution' },
    async (client) => {
      const res = await client.query(
        'SELECT tenant_id FROM teams_tenant_installs WHERE azure_ad_tenant_id = $1',
        [azureAdTenantId],
      );
      return (res.rows[0]?.tenant_id as string | undefined) ?? null;
    },
  );
}

/** Upsert the per-tenant install row (keyed on azure_ad_tenant_id). */
export async function upsertTenantInstall(input: {
  tenantId: string;
  azureAdTenantId: string;
  serviceUrl?: string | null;
  consentState: TeamsTenantInstall['consentState'];
  catalogTeamsAppId?: string | null;
  graphAdminRefreshSecretPath?: string | null;
  appPublishedAt?: string | null;
}): Promise<void> {
  await withTenantScope(input.tenantId, (client) =>
    client.query(
      `INSERT INTO teams_tenant_installs (
         tenant_id, azure_ad_tenant_id, service_url, consent_state,
         catalog_teams_app_id, graph_admin_refresh_secret_path, app_published_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (azure_ad_tenant_id) DO UPDATE SET
         service_url = COALESCE($3, teams_tenant_installs.service_url),
         consent_state = $4,
         catalog_teams_app_id = COALESCE($5, teams_tenant_installs.catalog_teams_app_id),
         graph_admin_refresh_secret_path = COALESCE($6, teams_tenant_installs.graph_admin_refresh_secret_path),
         app_published_at = COALESCE($7, teams_tenant_installs.app_published_at),
         updated_at = NOW()`,
      [
        input.tenantId,
        input.azureAdTenantId,
        input.serviceUrl ?? null,
        input.consentState,
        input.catalogTeamsAppId ?? null,
        input.graphAdminRefreshSecretPath ?? null,
        input.appPublishedAt ?? null,
      ],
    ),
  );
  log.info(
    { event: 'teams_tenant_install_upserted', tenantId: input.tenantId, consentState: input.consentState },
    'teams_tenant_installs upserted',
  );
}

/** Read the install row for a tenant (null if not connected). */
export async function getTenantInstall(
  tenantId: string,
): Promise<TeamsTenantInstall | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT tenant_id, azure_ad_tenant_id, service_url, consent_state,
              catalog_teams_app_id, graph_admin_refresh_secret_path, app_published_at
         FROM teams_tenant_installs WHERE tenant_id = $1`,
      [tenantId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      azureAdTenantId: row.azure_ad_tenant_id,
      serviceUrl: row.service_url ?? null,
      consentState: row.consent_state,
      catalogTeamsAppId: row.catalog_teams_app_id ?? null,
      graphAdminRefreshSecretPath: row.graph_admin_refresh_secret_path ?? null,
      appPublishedAt: row.app_published_at ? (row.app_published_at as Date).toISOString() : null,
    };
  });
}

/**
 * Tenant-level "is Teams published?" count for distill surfacing. One bot
 * serves all agents, so this is tenant-level (0 or 1), unlike Slack's
 * per-agent install count.
 */
export async function getInstalledTeamsCount(tenantId: string): Promise<number> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT COUNT(*)::int AS c FROM teams_tenant_installs
        WHERE tenant_id = $1 AND consent_state = 'published'`,
      [tenantId],
    );
    return Number(res.rows[0]?.c ?? 0);
  });
}

// ── Conversation ↔ agent binding + reference ────────────────────────────────

/** Return the colleague bound to a conversation — a team's id or a platform
 *  assistant's reserved id ('liftoff' | 'caio' | 'insights') — or null. */
export async function getConversationAgent(
  tenantId: string,
  conversationId: string,
): Promise<string | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ agent_id: string | null; assistant_kind: string | null }>(
      'SELECT agent_id, assistant_kind FROM agent_teams_conversations WHERE tenant_id = $1 AND conversation_id = $2',
      [tenantId, conversationId],
    );
    const row = res.rows[0];
    return row?.agent_id ?? row?.assistant_kind ?? null;
  });
}


/** Bind (or rebind) a conversation to an agent + store the reference. */
export async function bindConversationAgent(input: {
  tenantId: string;
  /** NULL records a conversation that EXISTS but has no agent picked yet — the
   *  state between app install and first pick. A null here never clears an
   *  existing binding (see the COALESCE below); it only declines to set one. */
  agentId: string | null;
  conversationId: string;
  azureAdTenantId: string;
  scope: TeamsConversationRow['scope'];
  aadUserId: string | null;
  accountId: string | null;
  teamId?: string | null;
  channelId?: string | null;
  conversationReference: Record<string, unknown>;
}): Promise<void> {
  // A colleague is a team by id or an assistant by reserved id; the row holds
  // one or the other. A real pick of either replaces whatever was bound, and
  // drops the assistant thread if the assistant changed.
  const assistantKind = input.agentId && isAssistantKind(input.agentId) ? input.agentId : null;
  const teamAgentId = assistantKind ? null : input.agentId;
  const picked = input.agentId !== null;
  await withTenantScope(input.tenantId, (client) =>
    client.query(
      `INSERT INTO agent_teams_conversations (
         tenant_id, agent_id, assistant_kind, conversation_id, azure_ad_tenant_id, scope,
         aad_user_id, account_id, team_id, channel_id, conversation_reference
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (conversation_id) DO UPDATE SET
         -- An install-time write carries no colleague and must not unbind a
         -- conversation somebody is already using. Only a real pick rebinds.
         agent_id = CASE WHEN $12 THEN $2 ELSE agent_teams_conversations.agent_id END,
         assistant_kind = CASE WHEN $12 THEN $3 ELSE agent_teams_conversations.assistant_kind END,
         azure_ad_tenant_id = $5,
         scope = $6,
         aad_user_id = COALESCE($7, agent_teams_conversations.aad_user_id),
         account_id = COALESCE($8, agent_teams_conversations.account_id),
         team_id = COALESCE($9, agent_teams_conversations.team_id),
         channel_id = COALESCE($10, agent_teams_conversations.channel_id),
         conversation_reference = $11,
         updated_at = NOW()`,
      [
        input.tenantId,
        teamAgentId,
        assistantKind,
        input.conversationId,
        input.azureAdTenantId,
        input.scope,
        input.aadUserId,
        input.accountId,
        input.teamId ?? null,
        input.channelId ?? null,
        JSON.stringify(input.conversationReference),
        picked,
      ],
    ),
  );
}

/** Find a user's personal conversation with the bot (for teams_send_dm).
 *
 *  `agentId` is a PREFERENCE, not a filter — see
 *  `listPersonalConversationsByAccount` for why. This used to require it, so an
 *  agent could only DM someone whose personal conversation happened to be bound
 *  to that same agent, and every other agent was told the person had no Teams
 *  chat at all. One person, one bot, one 1:1 chat; the agent speaking is a
 *  property of the message, not of the channel. */
export async function findPersonalConversationByUser(
  tenantId: string,
  agentId: string,
  aadUserId: string,
): Promise<{ conversationId: string; conversationReference: Record<string, unknown> } | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT conversation_id, conversation_reference
         FROM agent_teams_conversations
        WHERE tenant_id = $1 AND aad_user_id = $3 AND scope = 'personal'
        ORDER BY (agent_id = $2) DESC NULLS LAST, updated_at DESC LIMIT 1`,
      [tenantId, agentId, aadUserId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      conversationId: row.conversation_id,
      conversationReference: row.conversation_reference as Record<string, unknown>,
    };
  });
}

/** List the posted review cards for a review (conversation id + card activity id). */
export async function listReviewCardsByReview(
  tenantId: string,
  reviewId: string,
): Promise<Array<{ conversationId: string; activityId: string }>> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      'SELECT conversation_id, activity_id FROM review_teams_messages WHERE tenant_id = $1 AND review_id = $2',
      [tenantId, reviewId],
    );
    return res.rows.map((r) => ({ conversationId: r.conversation_id, activityId: r.activity_id }));
  });
}

/** Get the team/channel ids stored for a conversation (for Graph reads). */
export async function getChannelMetaByConversation(
  tenantId: string,
  conversationId: string,
): Promise<{ teamId: string | null; channelId: string | null } | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      'SELECT team_id, channel_id FROM agent_teams_conversations WHERE tenant_id = $1 AND conversation_id = $2',
      [tenantId, conversationId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { teamId: row.team_id ?? null, channelId: row.channel_id ?? null };
  });
}

/**
 * Refresh the stored conversation reference (re-store on every inbound to
 * avoid "Conversation not found"). No-op when the conversation hasn't been
 * bound to an agent yet (the row doesn't exist until binding).
 */
export async function upsertConversationReference(
  tenantId: string,
  conversationId: string,
  conversationReference: Record<string, unknown>,
): Promise<void> {
  await withTenantScope(tenantId, (client) =>
    client.query(
      `UPDATE agent_teams_conversations
          SET conversation_reference = $3, updated_at = NOW()
        WHERE tenant_id = $1 AND conversation_id = $2`,
      [tenantId, conversationId, JSON.stringify(conversationReference)],
    ),
  );
}

/** Fetch a single conversation's reference by id (for outbound /send). */
export async function getConversationReferenceById(
  tenantId: string,
  conversationId: string,
): Promise<Record<string, unknown> | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      'SELECT conversation_reference FROM agent_teams_conversations WHERE tenant_id = $1 AND conversation_id = $2',
      [tenantId, conversationId],
    );
    return (res.rows[0]?.conversation_reference as Record<string, unknown> | undefined) ?? null;
  });
}

/** List all conversations bound to an agent (for the runtime teams_* tools). */
/**
 * Every PERSONAL (1:1) conversation in the tenant, newest first, regardless of
 * which agent last spoke in it.
 *
 * A 1:1 Teams chat is a channel between the USER and the BOT. There is one
 * Liftoff Teams app, so one such chat per person — `conversation_id` is UNIQUE
 * on this table precisely because of that. The `agent_id` column records who is
 * currently talking there, which is chat-routing state, not an address.
 *
 * `listConversationsForAgent` filters on that column, and the review fan-out
 * used it to decide who it could reach. So a proactive card could only be
 * delivered to someone whose LAST Teams interaction happened to be with the
 * same agent now asking for approval — and every newly created agent began life
 * unable to reach anybody, however many people had installed the bot.
 *
 * An assignee whose personal conversations are bound to other agents looks
 * unreachable: the asking agent looks up its own agent id, finds nothing, and
 * records "no teams conversation reference", with `last_success_at` never set.
 * Slack does not have this problem because it resolves the person by email and
 * opens a DM, with no agent in the lookup at all.
 *
 * The agent's identity travels in the CARD (agentName), not in the channel, so
 * reusing the reference addresses the right human about the right agent.
 */
export async function listPersonalConversationsByAccount(
  tenantId: string,
  preferredAgentId: string,
): Promise<Array<{ accountId: string; conversationId: string; conversationReference: Record<string, unknown> }>> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      // Rows bound to the asking agent sort first, so a person already talking
      // to it is answered in that thread; anyone else's chat still resolves.
      // NULLS LAST keeps an unbound conversation (recorded at install, before
      // any pick) behind a bound one rather than ahead of it.
      `SELECT conversation_id, account_id, conversation_reference
         FROM agent_teams_conversations
        WHERE tenant_id = $1 AND scope = 'personal' AND account_id IS NOT NULL
        ORDER BY (agent_id = $2) DESC NULLS LAST, updated_at DESC`,
      [tenantId, preferredAgentId],
    );
    return res.rows.map((row) => ({
      accountId: row.account_id as string,
      conversationId: row.conversation_id as string,
      conversationReference: row.conversation_reference as Record<string, unknown>,
    }));
  });
}

export async function listConversationsForAgent(
  tenantId: string,
  agentId: string,
): Promise<TeamsConversationRow[]> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT conversation_id, agent_id, azure_ad_tenant_id, scope, aad_user_id,
              account_id, conversation_reference
         FROM agent_teams_conversations
        WHERE tenant_id = $1 AND agent_id = $2
        ORDER BY updated_at DESC`,
      [tenantId, agentId],
    );
    return res.rows.map((row) => ({
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      azureAdTenantId: row.azure_ad_tenant_id,
      scope: row.scope,
      aadUserId: row.aad_user_id ?? null,
      accountId: row.account_id ?? null,
      conversationReference: row.conversation_reference as Record<string, unknown>,
    }));
  });
}

// ── Agent search (picker + application/search typeahead) ─────────────────────

interface RosterRow {
  id: string;
  role: string | null;
  messaging_nickname: string | null;
  summary: string | null;
  responsibilities: string | null;
}

/**
 * The one roster statement. The picker's typeahead (Slack and Teams alike)
 * and the routing candidates read the same rows through it, so the two can
 * never disagree about which teams a person may reach: live, not deleted,
 * not a draft; narrowed to `active` for routing (a paused team was taken out
 * of service and cannot answer); a name filter for the typeahead; the
 * picker's order. internal_agents is RLS-scoped — runs under tenant scope.
 */
async function readRoster(
  tenantId: string,
  opts: { query: string; activeOnly: boolean; limit: number },
): Promise<RosterRow[]> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT id, role, messaging_nickname, summary, responsibilities
         FROM internal_agents
        WHERE tenant_id = $1 AND deleted_at IS NULL AND status <> 'draft'
          AND (NOT $2::boolean OR status = 'active')
          AND ($3 = '' OR messaging_nickname ILIKE '%' || $3 || '%' OR role ILIKE '%' || $3 || '%')
        ORDER BY COALESCE(messaging_nickname, role) ASC
        LIMIT $4`,
      [tenantId, opts.activeOnly, opts.query, opts.limit],
    );
    return res.rows as RosterRow[];
  });
}

/**
 * Search the tenant's live agents by name for the Adaptive Card typeahead.
 */
export async function searchAgents(
  tenantId: string,
  query: string | undefined,
  limit = 15,
): Promise<PickerAgent[]> {
  const q = (query ?? '').trim();
  // The three platform assistants first: they are not rows, and a person
  // reaching for "who can I talk to" should see them the way the dashboard
  // shows them, ahead of the teams.
  const assistants: PickerAgent[] = ASSISTANT_TARGETS
    .filter((a) => q === '' || a.name.toLowerCase().includes(q.toLowerCase()))
    .map((a) => ({ agentId: a.id, label: a.name }));
  const teams = (await readRoster(tenantId, { query: q, activeOnly: false, limit })).map((row) => ({
    agentId: row.id,
    label: row.messaging_nickname || (row.role ?? ''),
  }));
  return [...assistants, ...teams].slice(0, Math.max(limit, assistants.length));
}

/**
 * The workspace's active teams as routing candidates (Phase 9): the picker's
 * own roster query, narrowed to `active`, carrying the `role` and `summary`
 * the `list_colleagues` roster shows. Read at the moment of the message,
 * never cached. One row over the cap is read so the caller can tell "over
 * the cap" from "at the cap" and fall back to the picker.
 */
export async function listRouteCandidates(
  tenantId: string,
  cap: number,
): Promise<Array<{ id: string; role: string; summary: string }>> {
  return (await readRoster(tenantId, { query: '', activeOnly: true, limit: cap + 1 })).map((row) => ({
    id: row.id,
    role: row.role ?? '',
    summary: row.summary?.trim() || row.responsibilities?.trim() || '',
  }));
}

/**
 * Display name + lifecycle status for a bound colleague. Twin of the Slack
 * adapter's getAgentNameAndStatus (slack-adapter/workspace-repository.ts) —
 * both surfaces must treat a paused teammate the same way. An assistant is
 * always active: it has no lifecycle to be paused in.
 */
export async function getAgentNameAndStatus(
  tenantId: string,
  agentId: string,
): Promise<{ displayName: string; status: string } | null> {
  const assistant = assistantByKind(agentId);
  if (assistant) return { displayName: assistant.name, status: 'active' };
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ display_name: string | null; status: string }>(
      `SELECT COALESCE(messaging_nickname, role) AS display_name, status
         FROM internal_agents
        WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [agentId, tenantId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { displayName: (row.display_name || 'Your agent').trim(), status: row.status };
  });
}

// ── Dedup ───────────────────────────────────────────────────────────────────

/**
 * Returns true if this activity id was already processed. INSERT ... ON
 * CONFLICT DO NOTHING; fails open (returns false) on error.
 */
export async function isDuplicateActivity(activityId: string): Promise<boolean> {
  const pool = getPool();
  try {
    const res = await pool.query(
      'INSERT INTO teams_activity_dedup (activity_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING activity_id',
      [activityId],
    );
    return res.rowCount === 0;
  } catch {
    return false;
  }
}
