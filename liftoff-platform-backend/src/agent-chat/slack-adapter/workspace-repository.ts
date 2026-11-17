// Workspace Slack app repository: install + conversation-binding queries
// (tables from migration 314, ADR-040).
//
// Centralises the SQL so callers don't scatter scope blocks. Inbound Slack
// events arrive with no tenant context (only the Slack team_id), so
// findWorkspaceInstallByTeam runs under withAdminScope — that lookup is what
// establishes the tenant. Everything else runs under tenant scope to honour
// RLS on slack_workspace_installs / slack_conversation_agents.

import { withTenantScope, withAdminScope } from '../../infrastructure/database';
import { assistantByKind, assistantByName, isAssistantKind, type AssistantKind } from '../assistant-targets';
import { log } from '../../infrastructure/logging';

export interface WorkspaceInstallRow {
  id: string;
  tenantId: string;
  slackTeamId: string;
  slackTeamName: string | null;
  slackBotUserId: string | null;
  slackBotTokenSecretPath: string | null;
  installStatus: 'installed' | 'revoked' | 'error';
  installedAt: string;
  /** Workspace-wide fallback team member — the bottom rung of the routing
   *  ladder. Null means show the picker instead. */
  defaultAgentId: string | null;
}

/** Who a conversation belongs to: a team's internal_agents id, or one of the
 *  three platform assistants' reserved ids ('liftoff' | 'caio' | 'insights').
 *  The reserved ids are not UUIDs, so the two can never collide, and every
 *  routing rung carries one string for either. */
export type ColleagueId = string;

export interface ConversationBindingRow {
  id: string;
  tenantId: string;
  /** The colleague: a team's id, or an assistant's reserved id. */
  agentId: ColleagueId;
  /** Set when the colleague is a platform assistant. */
  assistantKind: AssistantKind | null;
  /** The assistant's own chat thread for this conversation, once one exists. */
  slackTeamId: string;
  channelId: string;
  threadRootTs: string | null;
  scope: 'dm' | 'channel' | 'group';
  slackUserId: string | null;
  accountId: string | null;
}

function rowToInstall(row: Record<string, unknown>): WorkspaceInstallRow {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    slackTeamId: row.slack_team_id as string,
    slackTeamName: (row.slack_team_name as string | null) ?? null,
    slackBotUserId: (row.slack_bot_user_id as string | null) ?? null,
    slackBotTokenSecretPath: (row.slack_bot_token_secret_path as string | null) ?? null,
    installStatus: row.install_status as WorkspaceInstallRow['installStatus'],
    installedAt: (row.installed_at as Date).toISOString(),
    defaultAgentId: (row.default_agent_id as string | null) ?? null,
  };
}

function rowToBinding(row: Record<string, unknown>): ConversationBindingRow {
  const assistantKind = (row.assistant_kind as AssistantKind | null) ?? null;
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    agentId: (row.agent_id as string | null) ?? assistantKind ?? '',
    assistantKind,
    slackTeamId: row.slack_team_id as string,
    channelId: row.channel_id as string,
    threadRootTs: (row.thread_root_ts as string | null) ?? null,
    scope: row.scope as ConversationBindingRow['scope'],
    slackUserId: (row.slack_user_id as string | null) ?? null,
    accountId: (row.account_id as string | null) ?? null,
  };
}

const INSTALL_COLUMNS = `id, tenant_id, slack_team_id, slack_team_name, slack_bot_user_id,
       slack_bot_token_secret_path, install_status, installed_at, default_agent_id`;

const BINDING_COLUMNS = `id, tenant_id, agent_id, assistant_kind, slack_team_id, channel_id, thread_root_ts,
       scope, slack_user_id, account_id`;

// ── Installs ─────────────────────────────────────────────────────────────────

/**
 * Resolve the install (and thereby the tenant) from an inbound event's
 * team_id. Runs under withAdminScope because an inbound Slack event has no
 * tenant GUC set yet — this lookup is what establishes the tenant context.
 * Only 'installed' rows route traffic.
 */
export async function findWorkspaceInstallByTeam(
  slackTeamId: string,
): Promise<WorkspaceInstallRow | null> {
  const res = await withAdminScope(
    { caller: 'slack-workspace-repository', reason: 'webhook tenant resolution' },
    (client) =>
      client.query(
        `SELECT ${INSTALL_COLUMNS} FROM slack_workspace_installs
          WHERE slack_team_id = $1 AND install_status = 'installed'`,
        [slackTeamId],
      ),
  );
  return res.rows[0] ? rowToInstall(res.rows[0]) : null;
}

/** The tenant's currently-installed workspace install, or null. */
export async function getInstalledWorkspaceInstall(
  tenantId: string,
): Promise<WorkspaceInstallRow | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT ${INSTALL_COLUMNS} FROM slack_workspace_installs
        WHERE tenant_id = $1 AND install_status = 'installed'
        ORDER BY installed_at DESC LIMIT 1`,
      [tenantId],
    );
    return res.rows[0] ? rowToInstall(res.rows[0]) : null;
  });
}

/** Upsert the install row after a successful OAuth exchange (keyed on team). */
export async function upsertWorkspaceInstall(input: {
  tenantId: string;
  slackTeamId: string;
  slackTeamName: string | null;
  slackBotUserId: string;
  slackBotTokenSecretPath: string;
  installedByAccountId: string | null;
}): Promise<void> {
  await withTenantScope(input.tenantId, (client) =>
    client.query(
      `INSERT INTO slack_workspace_installs (
         tenant_id, slack_team_id, slack_team_name, slack_bot_user_id,
         slack_bot_token_secret_path, install_status, installed_by_account_id, installed_at
       ) VALUES ($1, $2, $3, $4, $5, 'installed', $6, NOW())
       ON CONFLICT (slack_team_id) DO UPDATE SET
         tenant_id = $1,
         slack_team_name = COALESCE($3, slack_workspace_installs.slack_team_name),
         slack_bot_user_id = $4,
         slack_bot_token_secret_path = $5,
         install_status = 'installed',
         installed_by_account_id = COALESCE($6, slack_workspace_installs.installed_by_account_id),
         updated_at = NOW()`,
      [
        input.tenantId,
        input.slackTeamId,
        input.slackTeamName,
        input.slackBotUserId,
        input.slackBotTokenSecretPath,
        input.installedByAccountId,
      ],
    ),
  );
  log.info(
    { event: 'slack_workspace_install_upserted', tenantId: input.tenantId, slackTeamId: input.slackTeamId },
    'slack_workspace_installs upserted',
  );
}

/** Mark the install revoked (token_revoked / account_inactive from Slack). */
export async function markWorkspaceInstallRevoked(
  tenantId: string,
  slackTeamId: string,
): Promise<void> {
  await withTenantScope(tenantId, (client) =>
    client.query(
      `UPDATE slack_workspace_installs
          SET install_status = 'revoked', updated_at = NOW()
        WHERE tenant_id = $1 AND slack_team_id = $2`,
      [tenantId, slackTeamId],
    ),
  );
}

/**
 * The most recent review card posted into a DM channel by the workspace app.
 * Backs top-level approve/reject: people reply under the card far more often
 * than inside its thread, so an "approve" typed straight into the DM has to
 * resolve the card it obviously refers to.
 */
export async function findLatestReviewCardInDm(
  tenantId: string,
  slackTeamId: string,
  channelId: string,
): Promise<{ reviewId: string; rootTs: string } | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ review_id: string; slack_dm_root_ts: string }>(
      `SELECT review_id, slack_dm_root_ts
         FROM review_slack_messages
        WHERE tenant_id = $1 AND slack_team_id = $2 AND slack_dm_channel_id = $3
        ORDER BY posted_at DESC
        LIMIT 1`,
      [tenantId, slackTeamId, channelId],
    );
    const row = res.rows[0];
    return row ? { reviewId: row.review_id, rootTs: row.slack_dm_root_ts } : null;
  });
}

/**
 * Match an agent by the name a person would type ("Code Reviewer"). Compares
 * against the messaging nickname and the role, case-insensitively. Draft
 * agents are excluded: they are not addressable yet.
 */
export async function findAgentByName(
  tenantId: string,
  name: string,
): Promise<{ agentId: ColleagueId; displayName: string } | null> {
  // The three assistants first: they are not rows, and a person addressing
  // "Chief AI Officer:" means the colleague every surface knows by that name.
  const assistant = assistantByName(name);
  if (assistant) return { agentId: assistant.id, displayName: assistant.name };
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ id: string; display_name: string | null }>(
      `SELECT id, COALESCE(messaging_nickname, role) AS display_name
         FROM internal_agents
        WHERE tenant_id = $1 AND deleted_at IS NULL AND status <> 'draft'
          AND (LOWER(messaging_nickname) = LOWER($2) OR LOWER(role) = LOWER($2))
        ORDER BY messaging_nickname NULLS LAST
        LIMIT 1`,
      [tenantId, name],
    );
    const row = res.rows[0];
    return row ? { agentId: row.id, displayName: (row.display_name || 'Your agent').trim() } : null;
  });
}

/** Display name + lifecycle status for a colleague (routing needs both). An
 *  assistant is always active: it has no lifecycle to be paused in. */
export async function getAgentNameAndStatus(
  tenantId: string,
  agentId: ColleagueId,
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

// ── Conversation ↔ agent bindings ────────────────────────────────────────────

/**
 * The binding for (channel, thread). Pass threadRootTs null for the
 * channel/DM-level binding. Callers doing thread-first routing look up the
 * thread binding and fall back to the channel-level one themselves.
 */
export async function getBinding(
  tenantId: string,
  slackTeamId: string,
  channelId: string,
  threadRootTs: string | null,
): Promise<ConversationBindingRow | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT ${BINDING_COLUMNS} FROM slack_conversation_agents
        WHERE tenant_id = $1 AND slack_team_id = $2 AND channel_id = $3
          AND COALESCE(thread_root_ts, '') = COALESCE($4, '')`,
      [tenantId, slackTeamId, channelId, threadRootTs],
    );
    return res.rows[0] ? rowToBinding(res.rows[0]) : null;
  });
}

/** Bind (or rebind) a (channel, thread) slot to a colleague — a team by id or
 *  an assistant by reserved id. Rebinding to a different colleague drops the
 *  assistant thread, since it belonged to the conversation with the last one. */
export async function bindAgent(input: {
  tenantId: string;
  agentId: ColleagueId;
  slackTeamId: string;
  channelId: string;
  threadRootTs: string | null;
  scope: ConversationBindingRow['scope'];
  slackUserId?: string | null;
  accountId?: string | null;
}): Promise<void> {
  const assistantKind = isAssistantKind(input.agentId) ? input.agentId : null;
  const agentId = assistantKind ? null : input.agentId;
  await withTenantScope(input.tenantId, (client) =>
    client.query(
      `INSERT INTO slack_conversation_agents (
         tenant_id, agent_id, assistant_kind, slack_team_id, channel_id, thread_root_ts,
         scope, slack_user_id, account_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (slack_team_id, channel_id, COALESCE(thread_root_ts, '')) DO UPDATE SET
         agent_id = $2,
         assistant_kind = $3,
         scope = $7,
         slack_user_id = COALESCE($8, slack_conversation_agents.slack_user_id),
         account_id = COALESCE($9, slack_conversation_agents.account_id),
         updated_at = NOW()`,
      [
        input.tenantId,
        agentId,
        assistantKind,
        input.slackTeamId,
        input.channelId,
        input.threadRootTs,
        input.scope,
        input.slackUserId ?? null,
        input.accountId ?? null,
      ],
    ),
  );
}

/** Remember the assistant's thread for a bound conversation, so the next
 *  message continues it. Written once, when the first turn creates it; a
 *  later write for the same binding is a no-op. */


// ── Workspace default ────────────────────────────────────────────────────────

/**
 * The workspace's fallback team member, or null.
 *
 * The bottom rung of the routing ladder — consulted only when no thread and no
 * channel binding matched. A revoked install returns null: a workspace that has
 * uninstalled the app should not still be routing.
 */
export async function getWorkspaceDefaultAgent(
  tenantId: string,
  slackTeamId: string,
): Promise<ColleagueId | null> {
  return withTenantScope(tenantId, async (client) => {
    // A default team that has since been deleted answers nothing; a default
    // assistant has nothing to be deleted.
    const res = await client.query<{ default_agent_id: string | null; default_assistant_kind: string | null }>(
      `SELECT CASE WHEN a.id IS NULL THEN NULL ELSE i.default_agent_id END AS default_agent_id,
              i.default_assistant_kind
         FROM slack_workspace_installs i
         LEFT JOIN internal_agents a
           ON a.id = i.default_agent_id
          AND a.tenant_id = i.tenant_id
          AND a.deleted_at IS NULL
        WHERE i.tenant_id = $1
          AND i.slack_team_id = $2
          AND i.install_status = 'installed'`,
      [tenantId, slackTeamId],
    );
    const row = res.rows[0];
    return row?.default_agent_id ?? row?.default_assistant_kind ?? null;
  });
}

/**
 * Set or clear the workspace default. Pass null to clear, which puts the
 * workspace back to being asked who should answer.
 */
export async function setWorkspaceDefaultAgent(
  tenantId: string,
  slackTeamId: string,
  agentId: ColleagueId | null,
): Promise<boolean> {
  const assistantKind = agentId && isAssistantKind(agentId) ? agentId : null;
  const teamId = assistantKind ? null : agentId;
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `UPDATE slack_workspace_installs
          SET default_agent_id = $3, default_assistant_kind = $4, updated_at = NOW()
        WHERE tenant_id = $1 AND slack_team_id = $2`,
      [tenantId, slackTeamId, teamId, assistantKind],
    );
    return (res.rowCount ?? 0) > 0;
  });
}
