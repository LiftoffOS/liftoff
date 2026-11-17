// The export's own reads, one per table.
//
// Not the UI pagers. Every pager here keys on a bare timestamp
// (`created_at < $cursor`, agent-chat/chat-repository.ts:1072; `updated_at <
// $cursor` for threads), so two rows sharing a boundary timestamp lose one, and
// the reusable readers cap (`listAllByTenant` at 500, internal-agents
// service.ts:132), filter on the wrong column, or select what must not leave
// the building (`CustomMcpServerService.list` is `SELECT *` over the bare pool
// and returns auth_secret_name). Each read below is one ordered pass:
//
//   WHERE tenant_id = $1 AND created_at <= $asOf [AND deleted_at IS NULL]
//     AND (created_at, id) > ($cursor)
//   ORDER BY created_at, id
//   LIMIT LEAST($pageSize, recordsLeft + 1)
//
// inside withTenantScope, with every accepted row charged to the budget. The
// two message tables without a tenant column (liftoff_chat_messages,
// insights_chat_messages) join through their thread. `created_at` is nullable
// on several of the older tables, so the sort key coalesces to epoch: a NULL
// inside a row-wise comparison yields NULL, which would strand such a row.
//
// The keyset boundary travels as Postgres text (`created_at::text`), not a
// JS Date: a Date truncates timestamptz to milliseconds, and a truncated
// boundary silently drops every row inside the same millisecond.

import type { PoolClient } from 'pg';
import { getPool, withTenantScope } from '../infrastructure/database';
import { IS_CONVERSATION_PREDICATE } from '../agent-chat/chat-repository';
import type { ExportBudget } from './budget';

/** Rows per local page. The local queries are milliseconds; the page size
 *  only bounds how far past the ceiling one query can reach. */
export const LOCAL_PAGE_SIZE = 1000;

type Cursor = { sortAt: string; id: string } | null;

interface PagedRow {
  id: string;
  sort_cursor: string;
}

/** Walk one table to the end, charging every row, page by page. `fetchPage`
 *  receives the keyset boundary (null on the first page) and the LIMIT. */
async function collect<T extends PagedRow>(
  budget: ExportBudget,
  fetchPage: (cursor: Cursor, limit: number) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: Cursor = null;
  for (;;) {
    const limit = budget.pageLimit(LOCAL_PAGE_SIZE);
    const rows = await fetchPage(cursor, limit);
    for (const row of rows) {
      budget.charge(row);
      out.push(row);
    }
    if (rows.length < limit) return out;
    const last = rows[rows.length - 1];
    cursor = { sortAt: last.sort_cursor, id: last.id };
  }
}

/** The one place a page is run inside the tenant's RLS scope. */
function scoped<T extends PagedRow>(
  tenantId: string,
  sql: string,
  params: (cursor: Cursor, limit: number) => unknown[],
): (cursor: Cursor, limit: number) => Promise<T[]> {
  return (cursor, limit) =>
    withTenantScope(tenantId, (client: PoolClient) =>
      client.query(sql, params(cursor, limit)).then((r) => r.rows as T[]),
    );
}

const SORT = (col: string) => `COALESCE(${col}, 'epoch'::timestamptz)`;

// ── Team chat ───────────────────────────────────────────────────────────

export interface TeamChatThreadRow extends PagedRow {
  account_id: string | null;
  channel: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
}

export function readTeamChatThreads(
  tenantId: string, asOf: Date, budget: ExportBudget,
): Promise<TeamChatThreadRow[]> {
  // IS_CONVERSATION_PREDICATE drops greeting-only threads, exactly as the
  // thread list and the unread counts do; it addresses the thread as `t`.
  return collect(budget, scoped<TeamChatThreadRow>(tenantId,
    `SELECT t.id, t.account_id, t.channel, t.title, t.created_at, t.updated_at,
            ${SORT('t.created_at')}::text AS sort_cursor
       FROM agent_chat_threads t
      WHERE t.tenant_id = $1
        AND t.deleted_at IS NULL
        AND ${SORT('t.created_at')} <= $2::timestamptz
        AND ${IS_CONVERSATION_PREDICATE}
        AND ($3::timestamptz IS NULL OR (${SORT('t.created_at')}, t.id) > ($3::timestamptz, $4::uuid))
      ORDER BY ${SORT('t.created_at')} ASC, t.id ASC
      LIMIT $5`,
    (c, limit) => [tenantId, asOf, c?.sortAt ?? null, c?.id ?? null, limit],
  ));
}

export interface TeamChatMessageRow extends PagedRow {
  thread_id: string;
  agent_id: string | null;
  role: string;
  content: string;
  message_type: string | null;
  attachments: unknown;
  media: unknown;
  created_at: Date;
  /** The reply's own turn (unique per assistant row, migration 316). */
  turn_id: string | null;
  /** On a file_output card: the turn whose tool call produced the file
   *  (migration 474), which is what joins the card to its reply. */
  produced_in_turn_id: string | null;
  /** Resolved as listMessages resolves it (agent-chat/chat-repository.ts:1059-1068):
   *  the turn's sender, else the thread's creator on the web channel only. */
  sender_account_id: string | null;
  sender_label: string | null;
  /** Contributor[] (migration 493): the teammates a reply was delegated to,
   *  or the colleague that wrote a `colleague` row. Raw JSONB; the collector
   *  validates the shape. */
  contributors: unknown;
}

export function readTeamChatMessages(
  tenantId: string, asOf: Date, budget: ExportBudget,
): Promise<TeamChatMessageRow[]> {
  // The sender COALESCE is copied from listMessages
  // (agent-chat/chat-repository.ts:1059-1068): the accounts join is gated on
  // role='user' so assistant/tool rows never pick up a sender, and the
  // fallback to the thread creator is restricted to the 'web' channel, where
  // the thread has exactly one human. Slack/Teams/MCP threads are
  // multi-author, so guessing there would misattribute.
  return collect(budget, scoped<TeamChatMessageRow>(tenantId,
    `SELECT m.id, m.thread_id, m.agent_id, m.role, m.content, m.message_type,
            m.attachments, m.media, m.contributors, m.created_at, m.turn_id, m.produced_in_turn_id,
            m.created_at::text AS sort_cursor,
            CASE WHEN m.role = 'user' THEN COALESCE(
              t.sender_account_id,
              CASE WHEN th.channel = 'web' THEN th.account_id END
            ) END AS sender_account_id,
            CASE WHEN m.role = 'user' THEN t.sender_label END AS sender_label
       FROM agent_chat_messages m
       JOIN agent_chat_threads th
         ON th.id = m.thread_id AND th.tenant_id = m.tenant_id
       LEFT JOIN agent_chat_turns t
         ON t.id = m.turn_id AND t.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1
        AND th.deleted_at IS NULL
        AND m.created_at <= $2::timestamptz
        AND ($3::timestamptz IS NULL OR (m.created_at, m.id) > ($3::timestamptz, $4::uuid))
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT $5`,
    (c, limit) => [tenantId, asOf, c?.sortAt ?? null, c?.id ?? null, limit],
  ));
}

// ── Liftoff and the Insights Manager ────────────────────────────────────

export interface AssistantThreadRow extends PagedRow {
  account_id: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AssistantMessageRow extends PagedRow {
  thread_id: string;
  role: string;
  content: string;
  message_type: string | null;
  attachments: unknown;
  media: unknown;
  /** Liftoff only: a colleague's reply names its author. */
  author: string | null;
  author_label: string | null;
  /** Contributor[] (migration 493) on the Insights Manager; on Liftoff the
   *  author pair above is the record and this reads as the empty list. Raw
   *  JSONB; the collector validates the shape. */
  contributors: unknown;
  /** Migration 492. NULL on a human message written before it. */
  sender_account_id: string | null;
  created_at: Date;
}

function assistantThreads(table: 'liftoff_chat_threads' | 'insights_chat_threads') {
  return (tenantId: string, asOf: Date, budget: ExportBudget): Promise<AssistantThreadRow[]> =>
    collect(budget, scoped<AssistantThreadRow>(tenantId,
      `SELECT t.id, t.account_id, t.title, t.created_at, t.updated_at,
              ${SORT('t.created_at')}::text AS sort_cursor
         FROM ${table} t
        WHERE t.tenant_id = $1
          AND t.deleted_at IS NULL
          AND ${SORT('t.created_at')} <= $2::timestamptz
          AND ($3::timestamptz IS NULL OR (${SORT('t.created_at')}, t.id) > ($3::timestamptz, $4::uuid))
        ORDER BY ${SORT('t.created_at')} ASC, t.id ASC
        LIMIT $5`,
      (c, limit) => [tenantId, asOf, c?.sortAt ?? null, c?.id ?? null, limit],
    ));
}

function assistantMessages(
  messages: 'liftoff_chat_messages' | 'insights_chat_messages',
  threads: 'liftoff_chat_threads' | 'insights_chat_threads',
  authored: boolean,
) {
  // Liftoff stores who wrote a reply as the author pair; the Insights Manager
  // stores it as the contributors list every other surface uses. Each table
  // is read through its own record and the collector produces one shape.
  const authorCols = authored
    ? "m.author, m.author_label, '[]'::jsonb AS contributors,"
    : 'NULL::text AS author, NULL::text AS author_label, m.contributors,';
  return (tenantId: string, asOf: Date, budget: ExportBudget): Promise<AssistantMessageRow[]> =>
    collect(budget, scoped<AssistantMessageRow>(tenantId,
      `SELECT m.id, m.thread_id, m.role, m.content, m.message_type, m.attachments, m.media,
              ${authorCols} m.sender_account_id, m.created_at,
              ${SORT('m.created_at')}::text AS sort_cursor
         FROM ${messages} m
         JOIN ${threads} t ON t.id = m.thread_id
        WHERE t.tenant_id = $1
          AND t.deleted_at IS NULL
          AND ${SORT('m.created_at')} <= $2::timestamptz
          AND ($3::timestamptz IS NULL OR (${SORT('m.created_at')}, m.id) > ($3::timestamptz, $4::uuid))
        ORDER BY ${SORT('m.created_at')} ASC, m.id ASC
        LIMIT $5`,
      (c, limit) => [tenantId, asOf, c?.sortAt ?? null, c?.id ?? null, limit],
    ));
}

export const readLiftoffThreads = assistantThreads('liftoff_chat_threads');
export const readLiftoffMessages = assistantMessages('liftoff_chat_messages', 'liftoff_chat_threads', true);
export const readInsightsThreads = assistantThreads('insights_chat_threads');
export const readInsightsMessages = assistantMessages('insights_chat_messages', 'insights_chat_threads', false);

// ── agents ────────────────────────────────────────────────────────────

export interface TeamRow extends PagedRow {
  role: string;
  summary: string | null;
  responsibilities: string | null;
  additional_context: string | null;
  integrations: unknown;
  status: string;
  created_at: Date;
}

export function readTeams(tenantId: string, asOf: Date, budget: ExportBudget): Promise<TeamRow[]> {
  // No LIMIT 500: the reusable listAllByTenant silently caps there.
  return collect(budget, scoped<TeamRow>(tenantId,
    `SELECT a.id, a.role, a.summary, a.responsibilities, a.additional_context,
            a.integrations, a.status, a.created_at,
            ${SORT('a.created_at')}::text AS sort_cursor
       FROM internal_agents a
      WHERE a.tenant_id = $1
        AND a.deleted_at IS NULL
        AND ${SORT('a.created_at')} <= $2::timestamptz
        AND ($3::timestamptz IS NULL OR (${SORT('a.created_at')}, a.id) > ($3::timestamptz, $4::uuid))
      ORDER BY ${SORT('a.created_at')} ASC, a.id ASC
      LIMIT $5`,
    (c, limit) => [tenantId, asOf, c?.sortAt ?? null, c?.id ?? null, limit],
  ));
}

/** Every team name the tenant has ever had, archived included, so an AI reply
 *  by an archived team and a file it produced still carry its name. Not
 *  charged to the budget: it is a resolver, not a section. */
export async function readTeamNames(tenantId: string): Promise<Map<string, string>> {
  const result = await withTenantScope(tenantId, (client) =>
    client.query<{ id: string; role: string }>(
      `SELECT id, role FROM internal_agents WHERE tenant_id = $1`,
      [tenantId],
    ));
  return new Map(result.rows.map((r) => [r.id, r.role]));
}

// ── Knowledge ───────────────────────────────────────────────────────────

export interface KnowledgeRow extends PagedRow {
  title: string;
  source_url: string | null;
  connector_type: string | null;
  connector_id: string | null;
  created_at: Date;
}

export function readKnowledge(tenantId: string, asOf: Date, budget: ExportBudget): Promise<KnowledgeRow[]> {
  return collect(budget, scoped<KnowledgeRow>(tenantId,
    `SELECT k.id, k.title, k.source_url, k.connector_type, k.connector_id, k.created_at,
            k.created_at::text AS sort_cursor
       FROM knowledge_items k
      WHERE k.tenant_id = $1
        AND k.created_at <= $2::timestamptz
        AND ($3::timestamptz IS NULL OR (k.created_at, k.id) > ($3::timestamptz, $4::uuid))
      ORDER BY k.created_at ASC, k.id ASC
      LIMIT $5`,
    (c, limit) => [tenantId, asOf, c?.sortAt ?? null, c?.id ?? null, limit],
  ));
}

// ── Custom MCP servers ──────────────────────────────────────────────────

export interface CustomMcpRow extends PagedRow {
  connector_id: string;
  name: string;
  endpoint_url: string;
  created_at: Date;
}

export function readCustomMcpServers(tenantId: string, asOf: Date, budget: ExportBudget): Promise<CustomMcpRow[]> {
  // Exactly these four columns and nothing else: the row also holds
  // auth_secret_name and the raw tool definitions, which the export must not
  // hold in memory. connector_id is the keyset tiebreaker (unique, not null),
  // aliased to `id` for the pager.
  return collect(budget, scoped<CustomMcpRow>(tenantId,
    `SELECT s.connector_id, s.connector_id AS id, s.name, s.endpoint_url, s.created_at,
            s.created_at::text AS sort_cursor
       FROM custom_mcp_servers s
      WHERE s.tenant_id = $1
        AND s.created_at <= $2::timestamptz
        AND ($3::timestamptz IS NULL OR (s.created_at, s.connector_id) > ($3::timestamptz, $4::uuid))
      ORDER BY s.created_at ASC, s.connector_id ASC
      LIMIT $5`,
    (c, limit) => [tenantId, asOf, c?.sortAt ?? null, c?.id ?? null, limit],
  ));
}

// ── Late feedback ───────────────────────────────────────────────────────

export interface LateFeedbackRow extends PagedRow {
  approval_id: string;
  decision: string;
  decided_by: string;
  rejection_reason: string | null;
  created_at: Date;
}

export function readLateFeedback(tenantId: string, asOf: Date, budget: ExportBudget): Promise<LateFeedbackRow[]> {
  return collect(budget, scoped<LateFeedbackRow>(tenantId,
    `SELECT f.id, f.approval_id, f.decision, f.decided_by, f.rejection_reason, f.created_at,
            ${SORT('f.created_at')}::text AS sort_cursor
       FROM hitl_late_feedback f
      WHERE f.tenant_id = $1
        AND ${SORT('f.created_at')} <= $2::timestamptz
        AND ($3::timestamptz IS NULL OR (${SORT('f.created_at')}, f.id) > ($3::timestamptz, $4::uuid))
      ORDER BY ${SORT('f.created_at')} ASC, f.id ASC
      LIMIT $5`,
    (c, limit) => [tenantId, asOf, c?.sortAt ?? null, c?.id ?? null, limit],
  ));
}

// ── Members, invitations, assignments ───────────────────────────────────

export interface MemberRow extends PagedRow {
  account_id: string;
  role: string;
  joined_at: Date | null;
  created_at: Date | null;
  first_name: string | null;
  last_name: string | null;
  email: string;
}

export function readMembers(tenantId: string, asOf: Date, budget: ExportBudget): Promise<MemberRow[]> {
  // accounts is a platform-global, RLS-exempt table (migration 095), so
  // joining it inside withTenantScope is safe, as listMessages does.
  return collect(budget, scoped<MemberRow>(tenantId,
    `SELECT tm.id, tm.account_id, tm.role::text AS role, tm.joined_at, tm.created_at,
            a.first_name, a.last_name, a.email,
            ${SORT('tm.created_at')}::text AS sort_cursor
       FROM tenant_members tm
       JOIN accounts a ON a.id = tm.account_id
      WHERE tm.tenant_id = $1
        AND ${SORT('tm.created_at')} <= $2::timestamptz
        AND ($3::timestamptz IS NULL OR (${SORT('tm.created_at')}, tm.id) > ($3::timestamptz, $4::uuid))
      ORDER BY ${SORT('tm.created_at')} ASC, tm.id ASC
      LIMIT $5`,
    (c, limit) => [tenantId, asOf, c?.sortAt ?? null, c?.id ?? null, limit],
  ));
}

export interface InvitationRow extends PagedRow {
  email: string;
  role: string;
  created_at: Date | null;
}

export function readPendingInvitations(tenantId: string, asOf: Date, budget: ExportBudget): Promise<InvitationRow[]> {
  return collect(budget, scoped<InvitationRow>(tenantId,
    `SELECT ti.id, ti.email, ti.role::text AS role, ti.created_at,
            ${SORT('ti.created_at')}::text AS sort_cursor
       FROM tenant_invitations ti
      WHERE ti.tenant_id = $1
        AND ti.status = 'pending'
        AND ${SORT('ti.created_at')} <= $2::timestamptz
        AND ($3::timestamptz IS NULL OR (${SORT('ti.created_at')}, ti.id) > ($3::timestamptz, $4::uuid))
      ORDER BY ${SORT('ti.created_at')} ASC, ti.id ASC
      LIMIT $5`,
    (c, limit) => [tenantId, asOf, c?.sortAt ?? null, c?.id ?? null, limit],
  ));
}

export interface AssignmentRow extends PagedRow {
  account_id: string;
  agent_id: string;
  agent_name: string | null;
  created_at: Date | null;
}

export function readAssignments(tenantId: string, asOf: Date, budget: ExportBudget): Promise<AssignmentRow[]> {
  // Not listPersonnelWithAssignments: that reader filters only
  // `pa.deleted_at IS NULL` (person-assignments/service.ts:91), so it would
  // include an assignment made after the cutoff and drop one removed after
  // it. internal_agents is joined with no deleted_at predicate, for the name.
  return collect(budget, scoped<AssignmentRow>(tenantId,
    `SELECT pa.id, pa.account_id, pa.agent_id, pa.created_at,
            COALESCE(ia.role, ea.name) AS agent_name,
            ${SORT('pa.created_at')}::text AS sort_cursor
       FROM person_agent_assignments pa
       LEFT JOIN internal_agents ia ON ia.id = pa.agent_id AND pa.agent_origin = 'internal'
       LEFT JOIN external_agents ea ON ea.id = pa.agent_id AND pa.agent_origin = 'external'
      WHERE pa.tenant_id = $1
        AND ${SORT('pa.created_at')} <= $2::timestamptz
        AND (pa.deleted_at IS NULL OR pa.deleted_at > $2::timestamptz)
        AND ($3::timestamptz IS NULL OR (${SORT('pa.created_at')}, pa.id) > ($3::timestamptz, $4::uuid))
      ORDER BY ${SORT('pa.created_at')} ASC, pa.id ASC
      LIMIT $5`,
    (c, limit) => [tenantId, asOf, c?.sortAt ?? null, c?.id ?? null, limit],
  ));
}

// ── External Agents ──────────────────────────────────────────────

export interface ExternalCollaboratorRow extends PagedRow {
  name: string;
  description: string | null;
  summary: string | null;
  status: string;
  collaboration_mode: string;
  /** DetectedCapability[] as stored: id, name, description, rawToolName. Only
   *  name and description leave the building. */
  detected_capabilities: unknown;
  allowed_internal_agent_ids: string[] | null;
  /** InternalAgentRequestRule[] as stored: internalAgentId, internalAgentName,
   *  permissions by request type. */
  request_rules: unknown;
  created_at: Date | null;
}

export function readExternalCollaborators(tenantId: string, asOf: Date, budget: ExportBudget): Promise<ExternalCollaboratorRow[]> {
  // Exactly the columns the Update Team page's External Agent branch
  // shows, and none of the connection: no endpoint_url, no auth_type, no
  // credential hints or header keys, no transport or tunnel, no
  // tool_classifications, no raw MCP tools or resources.
  return collect(budget, scoped<ExternalCollaboratorRow>(tenantId,
    `SELECT ea.id, ea.name, ea.description, ea.summary, ea.status, ea.collaboration_mode,
            ea.detected_capabilities, ea.allowed_internal_agent_ids, ea.request_rules, ea.created_at,
            ${SORT('ea.created_at')}::text AS sort_cursor
       FROM external_agents ea
      WHERE ea.tenant_id = $1
        AND ea.deleted_at IS NULL
        AND ${SORT('ea.created_at')} <= $2::timestamptz
        AND ($3::timestamptz IS NULL OR (${SORT('ea.created_at')}, ea.id) > ($3::timestamptz, $4::uuid))
      ORDER BY ${SORT('ea.created_at')} ASC, ea.id ASC
      LIMIT $5`,
    (c, limit) => [tenantId, asOf, c?.sortAt ?? null, c?.id ?? null, limit],
  ));
}

/** Every External Agent name the tenant has ever had, deleted included,
 *  so a team's binding to one that is gone still carries its name. A resolver,
 *  not a section, like readTeamNames: not charged to the budget. */
export async function readExternalCollaboratorNames(tenantId: string): Promise<Map<string, string>> {
  const result = await withTenantScope(tenantId, (client) =>
    client.query<{ id: string; name: string }>(
      `SELECT id, name FROM external_agents WHERE tenant_id = $1`,
      [tenantId],
    ));
  return new Map(result.rows.map((r) => [r.id, r.name]));
}

// ── Files the teams produced ────────────────────────────────────────────

export interface GeneratedFileRow extends PagedRow {
  conversation_id: string | null;
  agent_id: string;
  agent_name: string | null;
  filename: string;
  output_type: string;
  gcs_path: string | null;
  web_view_url: string | null;
  size_bytes: string | number | null;
  created_at: Date;
}

export function readGeneratedFiles(tenantId: string, asOf: Date, budget: ExportBudget): Promise<GeneratedFileRow[]> {
  // Every output_type, media too. `agent_id IS NOT NULL` is what "the teams
  // produced" means on this table: a person's own upload sits here as well
  // (migration 393, agent_id NULL, uploaded_by_account_id set) and is names
  // only in the transcript, never bytes in the archive.
  //
  // `discard_after IS NULL` is the second half of the same idea. A staged file
  // was written and never shown to anybody — bytes a custom API answered with,
  // which no reply ever presented — and it is due to be discarded. It is not
  // something the workspace produced in any sense a person would recognise,
  // and an archive that carried it would hand back files nobody has seen and
  // that will not exist next week. Presenting a file clears the column, so
  // everything a person was actually shown is here.
  return collect(budget, scoped<GeneratedFileRow>(tenantId,
    `SELECT gf.id, gf.conversation_id, gf.agent_id, ia.role AS agent_name,
            gf.filename, gf.output_type, gf.gcs_path, gf.web_view_url, gf.size_bytes, gf.created_at,
            gf.created_at::text AS sort_cursor
       FROM generated_files gf
       LEFT JOIN internal_agents ia ON ia.id = gf.agent_id
      WHERE gf.tenant_id = $1
        AND gf.agent_id IS NOT NULL
        AND gf.discard_after IS NULL
        AND gf.created_at <= $2::timestamptz
        AND ($3::timestamptz IS NULL OR (gf.created_at, gf.id) > ($3::timestamptz, $4::uuid))
      ORDER BY gf.created_at ASC, gf.id ASC
      LIMIT $5`,
    (c, limit) => [tenantId, asOf, c?.sortAt ?? null, c?.id ?? null, limit],
  ));
}

// ── The workspace, the exporter, and names ──────────────────────────────

export async function readWorkspaceName(tenantId: string): Promise<string | null> {
  const result = await getPool().query<{ name: string | null }>(
    `SELECT name FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return result.rows[0]?.name ?? null;
}

export interface AccountName {
  /** First and last name joined; falls back to the email when both are empty. */
  display: string;
  email: string;
}

/** One lookup for every account id the export names: thread starters,
 *  senders, deciders, resolvers. A deleted account is absent, and its key is
 *  then omitted from the archive. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readAccountNames(ids: Iterable<string>): Promise<Map<string, AccountName>> {
  // decided_by on the runtime is free text; anything that is not an
  // accounts.id resolves to nothing rather than failing the cast.
  const unique = [...new Set([...ids].filter((id) => typeof id === 'string' && UUID.test(id)))];
  if (unique.length === 0) return new Map();
  const result = await getPool().query<{ id: string; first_name: string | null; last_name: string | null; email: string }>(
    `SELECT id, first_name, last_name, email FROM accounts WHERE id = ANY($1::uuid[])`,
    [unique],
  );
  const out = new Map<string, AccountName>();
  for (const row of result.rows) {
    const name = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();
    out.set(row.id, { display: name || row.email, email: row.email });
  }
  return out;
}
