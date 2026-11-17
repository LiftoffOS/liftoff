// Agent Chat Repository
//
// CRUD for `agent_chat_threads`, `agent_chat_thread_participants`, and
// `agent_chat_messages` (migration 105).
//
// Permission model — simpler than insights chat:
//
//   Any tenant member can chat with any active agent in their tenant.
//   Thread visibility is scoped to tenant_id; any member can see any
//   thread within the tenant. Cross-tenant lookups are indistinguishable
//   from "not found" to prevent existence leaks.
//
// Soft delete: a "deleted" thread sets `deleted_at` and is hidden from
// every read path (list, get, messages). The partial index
// `idx_act_tenant ... WHERE deleted_at IS NULL` covers the list path.
//
// Pagination uses cursor-based scrolling, NOT offsets. Threads are listed
// by `updated_at DESC` (newest activity first), messages by `created_at
// DESC` (newest first, scrolling up loads older). Cursor format is opaque
// to the client — currently the ISO timestamp of the last row.
//
// RLS note (FORCE census): `agent_chat_threads`, `agent_chat_messages` and
// `agent_chat_thread_reads` are
// RLS-enabled and every path here carries the caller's tenantId → withTenantScope.
// `agent_chat_thread_participants` has no tenant_id column (not RLS) → its
// queries stay on the default pool. The private touchThread() helper takes
// tenantId from its sole caller (appendMessage) so it stays tenant-scoped.

import type { PoolClient } from 'pg';
import { getPool, withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
// Procedural status rows are not team replies; see the touchThread call in
// appendMessage. Imported rather than re-declared so there is one definition of
// what a hitl_status row is.
import { HITL_STATUS_MESSAGE_TYPE, DELEGATION_STATUS_MESSAGE_TYPE, BROWSER_HANDBACK_MESSAGE_TYPE, BROWSER_POINT_MESSAGE_TYPE } from './hitl-status-message';
import { RUN_PROGRESS_MESSAGE_TYPE, RUN_FAILED_MESSAGE_TYPE } from './run-progress';
// One shape for media on every surface. Imported rather than restated so the
// column and the renderer cannot drift apart per table.
import type { MediaRef } from '../media/attach';
// Same rule for who else had a hand in a reply: one shape, every surface.
import type { Contributor } from '../chat-attachments';
import { MEDIA_MESSAGE_TYPE } from '../media/message-type';
import { storedAssistantContent } from '../shared/stored-assistant-content';
// ── Types ──────────────────────────────────────────────────────────────

export interface Citation {
  ref: number;
  filename: string;
  page?: number;
  quote: string;
}

// 'mcp' (plan v6.1): threads created by the MCP chat path. Deliberately NOT
// in the web API's Zod enum — the mcp channel exists only on the thread row.
export type AgentChatChannel = 'web' | 'slack' | 'teams' | 'mcp';
export type AgentChatMessageRole = 'user' | 'assistant' | 'tool';

export interface AgentChatThread {
  id: string;
  tenantId: string;
  accountId: string;
  channel: AgentChatChannel;
  /** For mcp threads: the connected client's name (anchor mcp_tokens.name).
   *  NULL for other channels and for mcp threads with no runs yet. */
  sourceLabel?: string | null;
  externalThreadRef: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  /** The team has replied in this thread since this account last read it.
   *  Only listThreads() performs the read-marker join; every other caller
   *  selects without it and gets false. */
  unread: boolean;
}

/**
 * Human author of a user message, resolved from
 * `agent_chat_turns.sender_account_id` (migration 294) through
 * `agent_chat_messages.turn_id`.
 *
 * NULL for assistant/tool rows, for unresolved Slack/Teams guests
 * (`sender_account_id IS NULL`), and on every write path — only
 * listMessages() performs the join.
 */
export interface AgentChatMessageSender {
  accountId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatarUrl: string | null;
}

export interface AgentChatMessage {
  id: string;
  tenantId: string;
  threadId: string;
  agentId: string | null;
  role: AgentChatMessageRole;
  content: string;
  toolCalls: unknown[] | null;
  inputTokens: number;
  outputTokens: number;
  messageType: string | null;
  attachments: unknown[] | null;
  /** Images, video or audio the team produced for this message. Its own
   *  carrier, never `attachments`: that column means "what the agent
   *  produced" here and "what the person sent" on Liftoff, and media has to
   *  mean one thing on every surface. Null when the message carried none. */
  media: MediaRef[] | null;
  citations: Citation[] | null;
  /** Colleagues other than this team who had a hand in the row: the teammates
   *  the team delegated part of a reply to, in the order they were brought
   *  in, or the colleague (Liftoff, the Chief AI Officer, the Insights
   *  Manager) who wrote a `colleague` row, each named as the person saw it.
   *  Always a list: `[]` when the team answered alone, which is every row
   *  written before migration 493. Same shape and name as every other
   *  surface's message, so one renderer draws the chips. */
  contributors: Contributor[];
  createdAt: string;
  sender: AgentChatMessageSender | null;
  /** External display name for a sender with no Liftoff account (Slack/Teams
   *  guest). Set only when `sender` is null, so the UI can still show who it
   *  was instead of an anonymous message. Null on turns predating migration 307. */
  senderLabel: string | null;
}

export interface ThreadParticipant {
  agentId: string;
  addedBy: string;
  role: string;
  addedAt: string;
}

export interface PaginatedThreads {
  threads: AgentChatThread[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PaginatedMessages {
  messages: AgentChatMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ListThreadsOptions {
  agentId?: string | null;
  cursor?: string | null;
  limit?: number;
  /** Case-insensitive substring match on the title (the Chat History search). */
  titleQuery?: string;
}

export interface ListMessagesOptions {
  cursor?: string | null;
  limit?: number;
}

// Defaults mirror insights chat: thread list returns 20, messages 20.
const DEFAULT_THREAD_LIMIT = 20;
const MAX_THREAD_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 20;
const MAX_MESSAGE_LIMIT = 200;

/**
 * What "has an unread reply" means, written once.
 *
 * Assumes a thread aliased `t` and its read marker for the reading account
 * left-joined as `r`. A thread the team has never replied in is never unread;
 * no read marker at all means everything in it is unread.
 *
 * Both the thread list and the per-team counts select on this, and a single
 * constant is what stops the two from drifting into disagreeing about which
 * threads carry a dot.
 */
export const UNREAD_PREDICATE = `
  t.last_agent_message_at IS NOT NULL
    AND (r.last_read_at IS NULL OR t.last_agent_message_at > r.last_read_at)
`;

/**
 * What "this thread is a conversation" means, written once.
 *
 * Assumes a thread aliased `t`. A thread qualifies once it holds at least one
 * message that is not a bare auto-greeting.
 *
 * Opening a team's chat page creates the thread up front and streams a
 * time-of-day greeting into it (stream-router's greeting mode), so a page visit
 * that nobody typed into leaves a permanent row behind. Nothing ever titles it,
 * because titles are generated inside a chat turn and there was no turn, so it
 * surfaces in the history modal as "Untitled chat", and it can light the
 * unread dot for every other member of the workspace. The frontend no longer
 * creates them; this is what keeps any already in the database out of the
 * list, and what stops a future caller of greeting mode from repopulating it.
 *
 * The three disjuncts are the structural signature of everything that IS
 * conversation, rather than a text match on the greeting (migration 345 tried
 * matching the greeting phrases and 347 had to replace it):
 *
 *   - `role <> 'assistant'` — a person spoke, or a tool ran.
 *   - `turn_id IS NOT NULL` — the team replied inside a real turn.
 *   - `message_type IS NOT NULL` — a typed out-of-turn row: a routine proposal,
 *     a learning confirmation, a HITL or delegation status line.
 *
 * The greeting is the only assistant write in the estate that carries neither a
 * turn nor a type. The one other untyped, turn-less assistant write is the
 * wake-settlement delivery, which looks its thread up and refuses to deliver
 * when it is missing, so it can only ever land in a thread a person already
 * spoke in.
 *
 * The thread list and the per-team unread counts BOTH select on this. Filtering
 * one without the other is what puts a number on the badge with no thread
 * behind it to open.
 */
export const IS_CONVERSATION_PREDICATE = `
  EXISTS (
    SELECT 1 FROM agent_chat_messages m
    WHERE m.thread_id = t.id
      AND (m.role <> 'assistant' OR m.turn_id IS NOT NULL OR m.message_type IS NOT NULL)
  )
`;

// ── Internal row mappers ────────────────────────────────────────────────

function mapThreadRow(row: Record<string, unknown>): AgentChatThread {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    accountId: row.account_id as string,
    channel: row.channel as AgentChatChannel,
    sourceLabel: (row.source_label as string | null | undefined) ?? null,
    externalThreadRef: (row.external_thread_ref as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    // Defaults false when a caller selects without the read-marker join, which
    // is every caller but listThreads().
    unread: row.unread === true,
  };
}

function mapMessageRow(row: Record<string, unknown>): AgentChatMessage {
  const toolCalls = row.tool_calls;
  const attachments = row.attachments;
  const media = row.media;
  const citations = row.citations;
  const contributors = row.contributors;
  // Only listMessages() selects the sender_* columns; every other caller
  // (RETURNING * on insert) leaves them undefined → sender: null.
  const senderAccountId = (row.sender_account_id as string | null | undefined) ?? null;
  const senderLabel = (row.sender_label as string | null | undefined) ?? null;
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    threadId: row.thread_id as string,
    agentId: (row.agent_id as string | null) ?? null,
    role: row.role as AgentChatMessageRole,
    content: row.content as string,
    toolCalls: Array.isArray(toolCalls)
      ? (toolCalls as unknown[])
      : toolCalls == null
        ? null
        : (toolCalls as unknown[]),
    inputTokens: (row.input_tokens as number | null) ?? 0,
    outputTokens: (row.output_tokens as number | null) ?? 0,
    messageType: (row.message_type as string | null) ?? null,
    attachments: Array.isArray(attachments)
      ? (attachments as unknown[])
      : attachments == null
        ? null
        : (attachments as unknown[]),
    media: Array.isArray(media) ? (media as MediaRef[]) : null,
    citations: Array.isArray(citations)
      ? (citations as Citation[])
      : citations == null
        ? null
        : (citations as Citation[]),
    // The column is NOT NULL DEFAULT '[]', so anything but a list is a row
    // read through a path that did not select it; a list is what every
    // reader wants either way.
    contributors: Array.isArray(contributors) ? (contributors as Contributor[]) : [],
    createdAt: (row.created_at as Date).toISOString(),
    sender: senderAccountId
      ? {
          accountId: senderAccountId,
          firstName: (row.sender_first_name as string | null) ?? null,
          lastName: (row.sender_last_name as string | null) ?? null,
          email: row.sender_email as string,
          avatarUrl: (row.sender_avatar_url as string | null) ?? null,
        }
      : null,
    // A resolved sender already carries the real name; the label is the
    // fallback, never a second source of truth alongside it.
    senderLabel: senderAccountId ? null : senderLabel,
  };
}

function mapParticipantRow(row: Record<string, unknown>): ThreadParticipant {
  return {
    agentId: row.agent_id as string,
    addedBy: row.added_by as string,
    role: row.role as string,
    addedAt: (row.added_at as Date).toISOString(),
  };
}

// ── Thread CRUD ─────────────────────────────────────────────────────────

/**
 * Create a new chat thread for the given account in the given tenant.
 * Title is optional; the chat service can auto-generate one later.
 * Returns the persisted row.
 */
export async function createThread(
  tenantId: string,
  accountId: string | null,
  channel?: AgentChatChannel,
  externalThreadRef?: string | null,
  title?: string | null,
): Promise<AgentChatThread> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `INSERT INTO agent_chat_threads (tenant_id, account_id, channel, external_thread_ref, title)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      tenantId,
      accountId,
      channel ?? 'web',
      externalThreadRef ?? null,
      title ?? null,
    ],
  ));
  return mapThreadRow(result.rows[0]);
}

/**
 * Add an agent participant to a thread. No-op if the agent is already a
 * participant (ON CONFLICT DO NOTHING) — safe to call idempotently.
 *
 * agent_chat_thread_participants has no tenant_id column (not RLS) — default pool.
 */
export async function addParticipant(
  threadId: string,
  agentId: string,
  addedBy: string | null,
  role?: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO agent_chat_thread_participants (thread_id, agent_id, added_by, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (thread_id, agent_id) DO NOTHING`,
    [threadId, agentId, addedBy, role ?? 'participant'],
  );
}

/**
 * Get all agent participants for a thread. Returns an empty array if the
 * thread has no participants (or doesn't exist).
 *
 * agent_chat_thread_participants has no tenant_id column (not RLS) — default pool.
 */
export async function getParticipants(
  threadId: string,
): Promise<ThreadParticipant[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT agent_id, added_by, role, added_at
     FROM agent_chat_thread_participants
     WHERE thread_id = $1
     ORDER BY added_at ASC`,
    [threadId],
  );
  return result.rows.map(mapParticipantRow);
}

/**
 * List threads visible to the caller in this tenant. All tenant members
 * see all non-deleted threads (simpler than insights which restricts by role).
 *
 * If `agentId` is provided, filter to threads that have that agent as a
 * participant via a JOIN through the participants table.
 *
 * Cursor is the `updated_at` ISO string of the last thread on the previous
 * page. Limit is clamped to `MAX_THREAD_LIMIT`.
 */
/** Escape LIKE wildcards so a person's search text matches literally. */
function escapeLikePattern(text: string): string {
  return text.replace(/[%_\\]/g, '\\$&');
}

export async function listThreads(
  tenantId: string,
  accountId: string,
  options: ListThreadsOptions = {},
): Promise<PaginatedThreads> {
  const limit = Math.min(options.limit ?? DEFAULT_THREAD_LIMIT, MAX_THREAD_LIMIT);
  const cursor = options.cursor ?? null;
  const agentId = options.agentId ?? null;

  // $2 is the reading account. It was already a parameter of this function and
  // unused by the query until the read-marker join needed it.
  const params: Array<string | number | Date> = [tenantId, accountId];
  let sql: string;

  if (agentId) {
    params.push(agentId);
    sql = `
      SELECT t.id, t.tenant_id, t.account_id, t.channel,
             t.external_thread_ref, t.title, t.created_at, t.updated_at,
             src.name AS source_label,
             (${UNREAD_PREDICATE}) AS unread
      FROM agent_chat_threads t
      INNER JOIN agent_chat_thread_participants p ON p.thread_id = t.id
      LEFT JOIN agent_chat_thread_reads r ON r.thread_id = t.id AND r.account_id = $2
      LEFT JOIN LATERAL (
        SELECT mt.name FROM mcp_chat_runs mr
        JOIN mcp_tokens mt ON mt.id = mr.anchor_token_id
        WHERE mr.thread_id = t.id AND t.channel = 'mcp'
        ORDER BY mr.created_at DESC LIMIT 1
      ) src ON TRUE
      WHERE t.tenant_id = $1
        AND t.deleted_at IS NULL
        AND p.agent_id = $3
        AND ${IS_CONVERSATION_PREDICATE}
    `;
  } else {
    sql = `
      SELECT t.id, t.tenant_id, t.account_id, t.channel,
             t.external_thread_ref, t.title, t.created_at, t.updated_at,
             src.name AS source_label,
             (${UNREAD_PREDICATE}) AS unread
      FROM agent_chat_threads t
      LEFT JOIN agent_chat_thread_reads r ON r.thread_id = t.id AND r.account_id = $2
      LEFT JOIN LATERAL (
        SELECT mt.name FROM mcp_chat_runs mr
        JOIN mcp_tokens mt ON mt.id = mr.anchor_token_id
        WHERE mr.thread_id = t.id AND t.channel = 'mcp'
        ORDER BY mr.created_at DESC LIMIT 1
      ) src ON TRUE
      WHERE t.tenant_id = $1
        AND t.deleted_at IS NULL
        AND ${IS_CONVERSATION_PREDICATE}
    `;
  }

  if (options.titleQuery) {
    params.push(`%${escapeLikePattern(options.titleQuery)}%`);
    sql += ` AND t.title ILIKE $${params.length}`;
  }

  if (cursor) {
    params.push(new Date(cursor));
    sql += ` AND ${agentId ? 't.' : ''}updated_at < $${params.length}`;
  }

  params.push(limit + 1);
  sql += ` ORDER BY ${agentId ? 't.' : ''}updated_at DESC LIMIT $${params.length}`;

  const result = await withTenantScope(tenantId, (client) => client.query(sql, params));
  const hasMore = result.rows.length > limit;
  const threads = result.rows.slice(0, limit).map(mapThreadRow);

  return {
    threads,
    nextCursor: hasMore && threads.length > 0 ? threads[threads.length - 1].updatedAt : null,
    hasMore,
  };
}

/**
 * Fetch one thread by id with tenant isolation. Returns null if the thread
 * doesn't exist, is deleted, or belongs to a different tenant. Cross-tenant
 * lookups are intentionally indistinguishable from "not found".
 */
export async function getThread(
  threadId: string,
  tenantId: string,
): Promise<AgentChatThread | null> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT id, tenant_id, account_id, channel, external_thread_ref,
            title, created_at, updated_at
     FROM agent_chat_threads
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [threadId, tenantId],
  ));

  if (result.rows.length === 0) return null;
  return mapThreadRow(result.rows[0]);
}

/**
 * Soft-delete a thread. Tenant isolation enforced at the query level.
 * Returns true if a row was deleted, false if the thread was not found.
 */
export async function deleteThread(
  threadId: string,
  tenantId: string,
): Promise<boolean> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `UPDATE agent_chat_threads
     SET deleted_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [threadId, tenantId],
  ));
  return (result.rowCount ?? 0) > 0;
}

/**
 * Bump a thread's activity clocks from inside a transaction the caller already
 * holds.
 *
 * **Every writer of a row into `agent_chat_messages` must call this**, and with
 * `fromAgent: true` when the row is an assistant reply. Three writers exist:
 * appendMessage() below, the wake-settlement delivery
 * (src/wake-settlement/internal-router.ts) and the durable MCP run settle
 * (src/mcp-server/chat-run-worker.ts). The latter two persist their reply
 * inside their own tenant-scoped transaction alongside other work that must
 * land atomically with it, so they cannot call appendMessage — which opens a
 * scope of its own — and take a client instead. The
 * assistant-reply-clock-writers test enforces that no fourth writer appears
 * without doing the same.
 *
 * `fromAgent` stamps last_agent_message_at, the clock all three unread
 * indicators read. It rides on the statement that was happening anyway.
 *
 * `fromAgent` means "the team said something", NOT "role was assistant". A
 * `hitl_status` row is written as an assistant message so it renders in the
 * transcript, but it is narration about the gate ("Approved by Ada"), and
 * counting it marks a thread unread over the reader's own click. appendMessage
 * makes that distinction; a writer taking a client must make it too.
 * updated_at cannot serve the same purpose: it moves when the person sends a
 * message too, which would leave every thread they just wrote in looking
 * unread to them.
 */
export async function touchThreadOnClient(
  client: Pick<PoolClient, 'query'>,
  threadId: string,
  tenantId: string,
  fromAgent: boolean,
): Promise<void> {
  await client.query(
    `UPDATE agent_chat_threads
     SET updated_at = NOW()${fromAgent ? ', last_agent_message_at = NOW()' : ''}
     WHERE id = $1 AND tenant_id = $2`,
    [threadId, tenantId],
  );
}

/**
 * Touch the thread's updated_at so it bubbles to the top of the list view.
 * Called by appendMessage(). No permission check — internal helper. Takes
 * tenantId from its caller so it stays tenant-scoped under RLS.
 */
async function touchThread(
  threadId: string,
  tenantId: string,
  fromAgent: boolean,
): Promise<void> {
  await withTenantScope(
    tenantId,
    (client) => touchThreadOnClient(client, threadId, tenantId, fromAgent),
  );
}

/**
 * Atomically record a chat turn and its triggering user message (plan v13
 * Change 2). appendMessage opens its own tenant scope per call, so this
 * CANNOT be composed from appendMessage + a separate turn insert — the turn
 * row, the user-message row (stamped with turn_id), and the thread touch
 * must land in ONE withTenantScope transaction so a crash never leaves a
 * stamped message without its turn (or vice versa).
 *
 * `turnId` is the EXISTING PB turn identifier ("R5 Fix 12") — reused as
 * agent_chat_turns.id, one identifier across audit correlation,
 * persistence, and recall exclusion. `senderAccountId` is a strict
 * accounts.id or null (unresolved Slack/Teams guest — recall unavailable).
 * `senderLabel` carries that guest's external display name so the message
 * still renders with a name rather than anonymously (migration 307).
 */
export async function createTurnWithUserMessage(
  tenantId: string,
  threadId: string,
  agentId: string,
  turnId: string,
  senderAccountId: string | null,
  content: string,
  senderLabel: string | null = null,
  /** What the person attached, split the way every other surface splits it:
   *  text uploads and connector references go to `attachments`, media goes to
   *  the `media` column. On this table `attachments` means "what the agent
   *  produced" for ASSISTANT rows, so a sent picture landing there would make
   *  one column mean two things depending on the role. */
  media: unknown[] | null = null,
  attachments: unknown[] | null = null,
  /** The operator's account when a support delegation session sent this turn,
   *  otherwise null. Internal attribution only: the product renders the turn as
   *  the customer's, which is the point. See migration 408. */
  impersonatedBy: string | null = null,
): Promise<AgentChatMessage> {
  return withTenantScope(tenantId, async (client) => {
    // Idempotent on turn id (C1). The Slack/Teams workers now mint the turn id
    // at enqueue time and carry it on the task payload, so a Cloud Tasks retry
    // arrives with the SAME id. Without these guards the retry would die on a
    // primary-key violation here, or silently duplicate the person's message in
    // the transcript — both worse than the delivery failure that caused it.
    await client.query(
      `INSERT INTO agent_chat_turns (id, tenant_id, thread_id, agent_id, sender_account_id, sender_label, impersonated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      // Only keep the label when it is doing work: a resolved account already
      // carries the real name, and storing both invites them to disagree.
      [turnId, tenantId, threadId, agentId, senderAccountId, senderAccountId ? null : senderLabel, impersonatedBy],
    );
    const existingUserRow = await client.query(
      `SELECT * FROM agent_chat_messages
       WHERE tenant_id = $1 AND turn_id = $2 AND role = 'user'
       LIMIT 1`,
      [tenantId, turnId],
    );
    if (existingUserRow.rows[0]) {
      return mapMessageRow(existingUserRow.rows[0]);
    }
    const result = await client.query(
      `INSERT INTO agent_chat_messages
         (tenant_id, thread_id, agent_id, role, content, input_tokens, output_tokens, turn_id,
          media, attachments)
       VALUES ($1, $2, NULL, 'user', $3, 0, 0, $4, $5, $6)
       RETURNING *`,
      [
        tenantId,
        threadId,
        content,
        turnId,
        media && media.length > 0 ? JSON.stringify(media) : null,
        attachments && attachments.length > 0 ? JSON.stringify(attachments) : null,
      ],
    );
    // A user message, so the reply clock deliberately does not move: it is what
    // separates "the team said something new" from "I said something new".
    await touchThreadOnClient(client, threadId, tenantId, false);
    return mapMessageRow(result.rows[0]);
  });
}

/**
 * The turn row alone, for a turn the person started without words: a
 * hand-back or a point in the browser. The reply the team gives hangs off
 * this turn as any other; the person's own row is the status line the
 * router wrote, and no empty user bubble is put beside it. Idempotent on the
 * turn id as createTurnWithUserMessage is.
 */
export async function createTurnWithoutUserMessage(
  tenantId: string,
  threadId: string,
  agentId: string,
  turnId: string,
  senderAccountId: string | null,
  senderLabel: string | null = null,
  impersonatedBy: string | null = null,
): Promise<void> {
  await withTenantScope(tenantId, (client) => client.query(
    `INSERT INTO agent_chat_turns (id, tenant_id, thread_id, agent_id, sender_account_id, sender_label, impersonated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [turnId, tenantId, threadId, agentId, senderAccountId, senderAccountId ? null : senderLabel, impersonatedBy],
  ));
}

/**
 * Internal title update for the fire-and-forget AI title generator. This
 * is the first title-update function in the agent-chat repo (unlike
 * insights and workforce-plans, which already had a permission-gated
 * updateThreadTitle; agent-chat previously had none).
 *
 * Skips role/permission checks — tenant isolation is enforced at the SQL
 * level via `tenant_id` in the WHERE clause. The
 * `title_source IS DISTINCT FROM 'user'` guard makes a future user-rename
 * endpoint safe from AI overwrite.
 */
export async function updateThreadTitleInternal(
  threadId: string,
  tenantId: string,
  title: string,
): Promise<void> {
  await withTenantScope(tenantId, (client) => client.query(
    `UPDATE agent_chat_threads
     SET title = $1,
         title_source = 'ai',
         title_generated_at = NOW(),
         updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3
       AND deleted_at IS NULL
       AND title_source IS DISTINCT FROM 'user'`,
    [title, threadId, tenantId],
  ));
}

// ── Unread state ────────────────────────────────────────────────────────
//
// Migration 338. One marker per (thread, account), because two people in one
// workspace have genuinely different unread state.

/**
 * Record that this account has now seen everything in this thread.
 *
 * Upsert rather than insert-then-update: the row exists after the first read
 * and every subsequent open is a rewrite of the same timestamp.
 *
 * No thread-existence check — the caller does that, and the composite FK to
 * agent_chat_threads (id, tenant_id) makes a marker for someone else's thread
 * unwritable regardless.
 */
export async function markThreadRead(
  tenantId: string,
  accountId: string,
  threadId: string,
): Promise<void> {
  await withTenantScope(tenantId, (client) => client.query(
    `INSERT INTO agent_chat_thread_reads (thread_id, account_id, tenant_id, last_read_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (thread_id, account_id)
     DO UPDATE SET last_read_at = NOW()`,
    [threadId, accountId, tenantId],
  ));
}

/**
 * Mark every thread with this agent that is unread for this caller as read.
 * The WHERE is getUnreadCountsByAgent's for one agent, so it clears exactly the
 * count that agent's badge shows. A thread shared with other agents is one
 * thread, so their counts drop with it. Returns how many threads were marked.
 */
export async function markAllThreadsRead(
  tenantId: string,
  accountId: string,
  agentId: string,
): Promise<number> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `INSERT INTO agent_chat_thread_reads (thread_id, account_id, tenant_id, last_read_at)
     SELECT t.id, $2, $1, NOW()
     FROM agent_chat_threads t
     LEFT JOIN agent_chat_thread_reads r ON r.thread_id = t.id AND r.account_id = $2
     WHERE t.tenant_id = $1
       AND t.deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM agent_chat_thread_participants p
         WHERE p.thread_id = t.id AND p.agent_id = $3
       )
       AND ${UNREAD_PREDICATE}
       AND ${IS_CONVERSATION_PREDICATE}
     ON CONFLICT (thread_id, account_id)
     DO UPDATE SET last_read_at = NOW()`,
    [tenantId, accountId, agentId],
  ));
  return result.rowCount ?? 0;
}

/**
 * How many threads carry an unread reply, per team, for this account across
 * the whole tenant. Backs the badge on the chat history button and the one
 * beside Message Team on the teams list — one query for both, since they are
 * the same question asked at two granularities.
 *
 * A team with nothing unread is absent from the map rather than present as 0,
 * which keeps the payload proportional to what is actually unread rather than
 * to how many teams the workspace has.
 */
export async function getUnreadCountsByAgent(
  tenantId: string,
  accountId: string,
): Promise<Record<string, number>> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT p.agent_id, COUNT(*)::int AS unread
     FROM agent_chat_threads t
     JOIN agent_chat_thread_participants p ON p.thread_id = t.id
     LEFT JOIN agent_chat_thread_reads r ON r.thread_id = t.id AND r.account_id = $2
     WHERE t.tenant_id = $1
       AND t.deleted_at IS NULL
       AND ${UNREAD_PREDICATE}
       AND ${IS_CONVERSATION_PREDICATE}
     GROUP BY p.agent_id`,
    [tenantId, accountId],
  ));

  const counts: Record<string, number> = {};
  for (const row of result.rows) {
    counts[row.agent_id as string] = row.unread as number;
  }
  return counts;
}

// ── Rolling summary ─────────────────────────────────────────────────────

/**
 * Fetch the rolling conversation summary for a thread. Returns null if the
 * thread doesn't exist, isn't in the caller's tenant, is deleted, or has
 * no summary yet.
 *
 * Tenant isolation enforced at the query level.
 */
export async function getThreadRollingSummary(
  threadId: string,
  tenantId: string,
): Promise<unknown | null> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT rolling_summary
     FROM agent_chat_threads
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [threadId, tenantId],
  ));
  if (result.rows.length === 0) return null;
  const raw = result.rows[0].rolling_summary;
  if (raw == null) return null;
  // pg returns JSONB columns already-parsed as a JS object.
  return raw as unknown;
}

/**
 * Write a new rolling summary for a thread. No-op (returns false) if the
 * thread doesn't exist / isn't in the tenant / is deleted. Tenant isolation
 * enforced at the query level.
 *
 * Called fire-and-forget from the chat service after each turn on long
 * threads. Must never throw in a way that affects the chat loop.
 */
export async function updateThreadRollingSummary(
  threadId: string,
  tenantId: string,
  summary: unknown,
): Promise<void> {
  await withTenantScope(tenantId, (client) => client.query(
    `UPDATE agent_chat_threads
     SET rolling_summary = $3::jsonb
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [threadId, tenantId, JSON.stringify(summary)],
  ));
}

// ── Message CRUD ────────────────────────────────────────────────────────

/**
 * Append a message to a thread. Caller must have already verified thread
 * existence via getThread() so we can fail fast before the write.
 *
 * tenant_id is denormalized onto the message for RLS (CC-3 from migration).
 * Touches the parent thread's updated_at so it bubbles to the top of list
 * views.
 */
export async function appendMessage(
  tenantId: string,
  threadId: string,
  role: AgentChatMessageRole,
  content: string,
  agentId?: string | null,
  toolCalls?: unknown[] | null,
  inputTokens?: number,
  outputTokens?: number,
  messageType?: string,
  attachments?: unknown[],
  citations?: Citation[],
  turnId?: string | null,
  /** An idempotency key for a message that belongs to no turn.
   *
   *  `turn_id` used to be borrowed for this, and it is a foreign key into
   *  agent_chat_turns — so a caller keying on anything that was not a real turn
   *  had its insert rejected outright. See migration 414. */
  externalRef?: string | null,
  /** The chat turn whose tool call produced this row, for a `file_output`
   *  card. Its own column (migration 474) rather than `turn_id`: that one is
   *  unique per assistant row, and a card is an assistant row, so a card
   *  stamped with the turn's id would collide with the reply or with the next
   *  card. NULL when the producer did not say, and NULL is not evidence of
   *  anything — see countFileCardsProducedInTurn. */
  producedInTurnId?: string | null,
  /** Colleagues other than this team who had a hand in the row, already
   *  resolved to the names the person saw. Passed by every writer of a
   *  team's speech (the live consumer, the settle callback, a colleague's
   *  reply); narration and everything else leaves the column at its `[]`
   *  default. */
  contributors?: Contributor[],
): Promise<AgentChatMessage> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `INSERT INTO agent_chat_messages
       (tenant_id, thread_id, agent_id, role, content, tool_calls, input_tokens, output_tokens,
        message_type, attachments, citations, turn_id, external_ref, produced_in_turn_id, contributors)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      tenantId,
      threadId,
      agentId ?? null,
      role,
      storedAssistantContent(role, content),
      toolCalls ? JSON.stringify(toolCalls) : null,
      inputTokens ?? 0,
      outputTokens ?? 0,
      messageType ?? null,
      attachments ? JSON.stringify(attachments) : null,
      citations ? JSON.stringify(citations) : null,
      turnId ?? null,
      externalRef ?? null,
      producedInTurnId ?? null,
      JSON.stringify(contributors ?? []),
    ],
  ));

  // Bubble the thread to the top of list views, and stamp the reply clock only
  // when this was the team actually TALKING.
  //
  // A `hitl_status` row is procedural narration, not a reply: "Waiting on Ada
  // to approve before continuing", or "Approved by Ada". It is written with
  // role 'assistant' because it renders in the transcript, but nobody said
  // anything and there is nothing new for the reader to read.
  //
  // Counting it lit the unread dot on a thread the reader had just dealt with:
  // approve from /dashboard/review, and the decision message posted by that
  // very click stamped the clock, so the team came back marked unread over the
  // reader's own action. A dot that appears because you handled something is
  // exactly how people learn to stop trusting the dot.
  //
  // This mirrors what the codebase already does with these rows everywhere
  // else: chat-service filters them out of the model's context for the same
  // reason, that they are not part of the conversation.
  const isTeamReply = role === 'assistant'
    && messageType !== HITL_STATUS_MESSAGE_TYPE
    && messageType !== DELEGATION_STATUS_MESSAGE_TYPE
    // Narration of a run's progress or its failure is not the team speaking.
    // A turn that ends "this hit its time limit at step 8 of 16" has told the
    // reader something true and useful, and has NOT answered them -- stamping
    // the reply clock would mark the thread as replied-to and clear the unread
    // dot on a question that is still open.
    && messageType !== RUN_PROGRESS_MESSAGE_TYPE
    // ...and the terminal row that says the run stopped. The comment above
    // already reasoned about "its failure"; the code tested only the progress
    // type, so a distinct failure type would have stamped the clock and
    // cleared the unread dot on a question that is still open.
    && messageType !== RUN_FAILED_MESSAGE_TYPE
    // The person's own browser events, written as the turn starts: a hand-back
    // or a point is the person acting, and the team's answer follows.
    && messageType !== BROWSER_HANDBACK_MESSAGE_TYPE
    && messageType !== BROWSER_POINT_MESSAGE_TYPE;
  await touchThread(threadId, tenantId, isTeamReply);

  return mapMessageRow(result.rows[0]);
}

/**
 * Append a status row that belongs to no turn, once: a second write with the
 * same `externalRef` (a replayed request) inserts nothing and returns null.
 * `ON CONFLICT DO NOTHING` against acm_external_ref_uniq (migration 414), so
 * the replay never surfaces as an error. The reply clock does not move: the
 * row is about the person, and the team has not spoken.
 */
export async function appendStatusRowOnce(
  tenantId: string,
  threadId: string,
  content: string,
  messageType: string,
  externalRef: string,
): Promise<AgentChatMessage | null> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `INSERT INTO agent_chat_messages
       (tenant_id, thread_id, agent_id, role, content, input_tokens, output_tokens, message_type, external_ref, contributors)
     VALUES ($1, $2, NULL, 'assistant', $3, 0, 0, $4, $5, '[]'::jsonb)
     ON CONFLICT (tenant_id, external_ref) WHERE external_ref IS NOT NULL DO NOTHING
     RETURNING *`,
    [tenantId, threadId, storedAssistantContent('assistant', content), messageType, externalRef],
  ));
  if (!result.rows[0]) return null;
  await touchThread(threadId, tenantId, false);
  return mapMessageRow(result.rows[0]);
}

/**
 * Append an assistant message whose whole payload is media.
 *
 * Its own function rather than a thirteenth positional parameter on
 * appendMessage: the media carrier is a different thing from `attachments`
 * (which on this table means the documents the agent authored), and a media
 * row has no text, no tool calls, no citations and no tokens to record. The
 * `file_output` append stays exactly as it is for documents — media is a
 * distinct carrier, not a replacement for it.
 *
 * Typed `media`, for the reason MEDIA_MESSAGE_TYPE gives: an untyped,
 * turn-less assistant row has the greeting's exact structural signature, so
 * IS_CONVERSATION_PREDICATE would not count it and a thread whose only reply
 * was a picture would read as a page visit nobody typed into. No renderer
 * dispatches on the type — the transcript draws from the `media` field.
 */
export async function appendMediaMessage(
  tenantId: string,
  threadId: string,
  agentId: string | null,
  media: MediaRef[],
): Promise<AgentChatMessage> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `INSERT INTO agent_chat_messages
       (tenant_id, thread_id, agent_id, role, content, input_tokens, output_tokens,
        message_type, media)
     VALUES ($1, $2, $3, 'assistant', '', 0, 0, $4, $5)
     RETURNING *`,
    [tenantId, threadId, agentId ?? null, MEDIA_MESSAGE_TYPE, JSON.stringify(media)],
  ));

  // The team produced something for the reader to look at, so the reply clock
  // moves: this is the team talking, not procedural narration about the thread.
  await touchThread(threadId, tenantId, true);

  return mapMessageRow(result.rows[0]);
}

/** The assistant message persisted for a turn, if any. Backs the two-writer
 *  race on assistant persistence (live SSE path vs the tenant-runtime settle
 *  callback): whichever writer loses the unique index acm_assistant_turn_uniq
 *  reads the winner's row instead of failing. */
/** The newest user-authored message on a thread. The routine rail reads it to
 *  decide whether the person's OWN words stated the exact change being
 *  proposed (statedChangeAgrees) — the registering turn's user message is
 *  already persisted before the turn runs, so at tool time this is the
 *  message that asked. */
export async function latestUserMessageContent(
  tenantId: string,
  threadId: string,
): Promise<string | null> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT content FROM agent_chat_messages
     WHERE tenant_id = $1 AND thread_id = $2 AND role = 'user'
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, threadId],
  ));
  return result.rows[0]?.content ?? null;
}

export async function getAssistantMessageByTurnId(
  tenantId: string,
  turnId: string,
): Promise<AgentChatMessage | null> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT * FROM agent_chat_messages
     WHERE tenant_id = $1 AND turn_id = $2 AND role = 'assistant'
     LIMIT 1`,
    [tenantId, turnId],
  ));
  return result.rows[0] ? mapMessageRow(result.rows[0]) : null;
}

/** The file cards on a thread as the attachment-claim check needs to see
 *  them: the ones stamped with this turn, and the ones stamped with no turn
 *  at all that appeared since this turn started. */
export interface TurnFileCardCounts {
  /** `file_output` rows whose `produced_in_turn_id` is this turn. */
  attributed: number;
  /** `file_output` rows with `produced_in_turn_id` NULL created at or after
   *  the turn started. A card this check cannot attribute — an older runtime
   *  image registering without `turnId`, a non-chat caller — and therefore a
   *  reason to say nothing, never a reason to correct. */
  unattributed: number;
}

/**
 * The counting query, as the check runs it. Exported so the integration test
 * can run the SAME statement against a real schema under tenant context, with
 * real rows on both sides of every boundary it draws.
 *
 * ONE statement, and the turn's own row is the anchor: `agent_chat_turns` is
 * inserted at the start of every turn (createTurnWithUserMessage), so its
 * `created_at` is when the turn started on the database's clock — the same
 * clock that stamps every card appended during the turn. No application
 * timestamp crosses into this comparison. A turn id that names no row
 * returns no row, which the reader reports as "could not establish the turn"
 * rather than as zero cards.
 *
 * $1 tenant, $2 thread, $3 turn.
 */
export const TURN_FILE_CARD_COUNTS_SQL = `
  SELECT
    COUNT(m.id) FILTER (WHERE m.produced_in_turn_id = t.id)::int AS attributed,
    COUNT(m.id) FILTER (WHERE m.produced_in_turn_id IS NULL AND m.created_at >= t.created_at)::int AS unattributed
  FROM agent_chat_turns t
  LEFT JOIN agent_chat_messages m
    ON m.tenant_id = t.tenant_id
   AND m.thread_id = $2
   AND m.message_type = 'file_output'
  WHERE t.tenant_id = $1 AND t.id = $3
  GROUP BY t.id, t.created_at`;

/**
 * How many file cards a chat turn appended to its thread, or null when the
 * turn itself is not on record.
 *
 * The EXACT record of the cards a turn produced, read by the attachment-claim
 * check at reply persistence (chat-service, settle-turn-router). Exact means:
 * `file_output` rows only — a `media` row is not a card — and only rows the
 * producer stamped with THIS turn's id count as attributed; a card from the
 * previous turn, seconds earlier on the same thread, is not this turn's.
 *
 * A card with a NULL `produced_in_turn_id` belongs to no turn and is never
 * counted FOR a reply, but it has to be VISIBLE: a query that read only tagged
 * rows would return zero for it and falsely correct a reply that was true.
 * So the second count is the untagged cards since the turn started, and the
 * caller skips when it is non-zero. That `created_at >= turn start` bound is
 * the one place a time window survives here, and it is a skip condition
 * (conservative), never a positive one. It is also the rollout gate: non-zero
 * exactly while an older runtime still registers untagged cards, zero on its
 * own once every image sends the turn id.
 *
 * Not collectTurnFileCards(): that one is a channel worker's best-effort
 * gather over the last 50 messages with a five-second pre-start tolerance,
 * media included, and `[]` on error. Read as a verdict it produces a false
 * assurance or a false correction. This throws on a lookup error and answers
 * null for an unknown turn, so the caller can tell "zero cards" from "could
 * not look".
 */
export async function countFileCardsProducedInTurn(
  tenantId: string,
  threadId: string,
  turnId: string,
): Promise<TurnFileCardCounts | null> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    TURN_FILE_CARD_COUNTS_SQL,
    [tenantId, threadId, turnId],
  ));
  const row = result.rows[0] as { attributed?: number; unattributed?: number } | undefined;
  if (!row) return null;
  return {
    attributed: Number(row.attributed ?? 0),
    unattributed: Number(row.unattributed ?? 0),
  };
}

/**
 * List messages in a thread, newest first. Reverse pagination so the
 * frontend can render a chat scrollback that fetches older messages on
 * scroll-to-top. Cursor is the created_at ISO string of the last (oldest)
 * message on the previous page.
 *
 * Tenant isolation enforced at the query level via tenant_id.
 *
 * Sender resolution (plan: human author on chat messages): user messages carry
 * their author through `turn_id` → `agent_chat_turns.sender_account_id`
 * (migration 294). `accounts` is a platform-global, RLS-exempt table
 * (migration 095), so joining it inside withTenantScope is safe.
 */
export async function listMessages(
  threadId: string,
  tenantId: string,
  options: ListMessagesOptions = {},
): Promise<PaginatedMessages> {
  const limit = Math.min(options.limit ?? DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
  const cursor = options.cursor ?? null;

  const params: Array<string | number | Date> = [threadId, tenantId];
  // The accounts join is gated on role='user' so assistant/tool rows never pick
  // up a sender. The COALESCE fallback to the thread creator covers messages
  // written before migration 294 (turn_id IS NULL) and is restricted to the
  // 'web' channel, where the thread has exactly one human — Slack/Teams/MCP
  // threads are multi-author, so guessing there would misattribute.
  let sql = `
    SELECT m.id, m.tenant_id, m.thread_id, m.agent_id, m.role, m.content,
           m.tool_calls, m.input_tokens, m.output_tokens,
           m.message_type, m.attachments, m.media, m.citations, m.contributors, m.created_at,
           s.id AS sender_account_id,
           s.first_name AS sender_first_name,
           s.last_name AS sender_last_name,
           s.email AS sender_email,
           s.avatar_url AS sender_avatar_url,
           CASE WHEN m.role = 'user' THEN t.sender_label END AS sender_label
    FROM agent_chat_messages m
    LEFT JOIN agent_chat_turns t
      ON t.id = m.turn_id AND t.tenant_id = m.tenant_id
    LEFT JOIN agent_chat_threads th
      ON th.id = m.thread_id AND th.tenant_id = m.tenant_id
    LEFT JOIN accounts s
      ON m.role = 'user'
     AND s.id = COALESCE(
           t.sender_account_id,
           CASE WHEN th.channel = 'web' THEN th.account_id END
         )
    WHERE m.thread_id = $1 AND m.tenant_id = $2
  `;

  if (cursor) {
    params.push(new Date(cursor));
    sql += ` AND m.created_at < $${params.length}`;
  }

  params.push(limit + 1);
  sql += ` ORDER BY m.created_at DESC LIMIT $${params.length}`;

  const result = await withTenantScope(tenantId, (client) => client.query(sql, params));
  const hasMore = result.rows.length > limit;
  const messages = result.rows.slice(0, limit).map(mapMessageRow);

  return {
    messages,
    nextCursor:
      hasMore && messages.length > 0 ? messages[messages.length - 1].createdAt : null,
    hasMore,
  };
}

// ── Upsert helper for Slack adapter ─────────────────────────────────────

/**
 * Find an existing thread by external reference (e.g. Slack thread_ts) or
 * create a new one. Used by the Slack adapter to avoid duplicate threads
 * on event retries. The unique index `idx_act_external_ref` on
 * (tenant_id, channel, external_thread_ref) guarantees uniqueness.
 *
 * When creating a new thread, the first agent is automatically added as
 * a participant.
 */
export async function findOrCreateThread(
  tenantId: string,
  accountId: string | null,
  agentId: string,
  channel: AgentChatChannel,
  externalThreadRef?: string | null,
): Promise<AgentChatThread> {
  // If an external ref is provided, try to find an existing thread first.
  if (externalThreadRef) {
    const existing = await withTenantScope(tenantId, (client) => client.query(
      `SELECT id, tenant_id, account_id, channel, external_thread_ref,
              title, created_at, updated_at
       FROM agent_chat_threads
       WHERE tenant_id = $1
         AND channel = $2
         AND external_thread_ref = $3
         AND deleted_at IS NULL`,
      [tenantId, channel, externalThreadRef],
    ));

    if (existing.rows.length > 0) {
      return mapThreadRow(existing.rows[0]);
    }
  }

  // No existing thread — create a new one and add the agent as participant.
  const thread = await createThread(
    tenantId,
    accountId,
    channel,
    externalThreadRef,
  );

  try {
    await addParticipant(thread.id, agentId, accountId);
  } catch (error) {
    log.error(
      { threadId: thread.id, agentId, error: (error as Error).message },
      'Failed to add initial participant to new chat thread',
    );
    // Thread was still created — don't fail the whole operation.
    // The participant can be added on the next message.
  }

  return thread;
}

/** Persist the Slack channel id for a slack-origin thread. The thread identity stays the
 *  thread_ts (external_thread_ref); this stores the channel alongside it so a self-wake continuation
 *  can be actively posted back to the Slack thread (chat.postMessage needs channel + thread_ts).
 *  Idempotent; only writes when the value actually changes. RLS: agent_chat_threads is tenant-scoped. */
export async function setSlackChannel(
  tenantId: string,
  threadId: string,
  slackChannelId: string,
): Promise<void> {
  if (!slackChannelId) return;
  await withTenantScope(tenantId, (client) => client.query(
    `UPDATE agent_chat_threads
     SET slack_channel_id = $3
     WHERE id = $1 AND tenant_id = $2 AND slack_channel_id IS DISTINCT FROM $3`,
    [threadId, tenantId, slackChannelId],
  ));
}
