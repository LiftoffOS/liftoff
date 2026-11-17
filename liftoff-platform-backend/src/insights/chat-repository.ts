// Insights Chat Repository
//
// CRUD for `insights_chat_threads` and `insights_chat_messages` (migration 074).
//
// Permission model — enforced inside this repository, not the router:
//
//   role          | list + read scope   | delete / rename own | ... anyone else's
//   --------------+---------------------+---------------------+------------------
//   owner / admin | every tenant thread | yes                 | yes
//   member        | every tenant thread | yes                 | no
//   viewer        | every tenant thread | yes                 | no
//
// Reads are workspace-wide (migration 351). They did not start that way: until
// then a member or a viewer could only see threads they had started themselves,
// which is why a shared link to an analytics conversation opened for its author
// and 404'd for the colleague they sent it to. Team chat (`agent_chat_threads`)
// has always been tenant-wide, and this surface now matches it: any member of
// the workspace can open any Insights thread in it, and every thread appears in
// every member's history list. The widening is retroactive, since privacy lived
// in the read query rather than in a per-thread flag.
//
// Writes stayed where they were. Deleting or renaming somebody else's thread is
// still author-or-privileged, because a read that widened too far is a
// disclosure the workspace can live with and a destroyed conversation is not.
//
// Soft delete: a "deleted" thread sets `deleted_at` and is hidden from every
// read path (list, get, messages). The two CREATE INDEX ... WHERE deleted_at IS
// NULL partial indexes from migration 074 cover the two list paths.
//
// Pagination uses cursor-based scrolling, NOT offsets. Threads are listed
// forward by `updated_at DESC` (newest activity first), messages are listed
// reverse by `created_at DESC` (newest at bottom of viewport, scrolling up
// loads older). Cursor format is opaque to the client — currently the ISO
// timestamp of the last row, but callers should not rely on the shape.

import { getPool, withTenantScope, withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import type { ConversationSummary } from './types';
// One shape for media on every surface, so the column and the renderer cannot
// drift apart per table.
import type { MediaRef } from '../media/attach';
import type { FileCard } from '../generated-files/file-card';
// The attachment contract is shared with Liftoff and the Chief AI Officer, so
// all three store the same metadata under the same name. Contributors ride the
// same package for the same reason.
import type { ChatMessageAttachment, Contributor } from '../chat-attachments';
import { storedAssistantContent } from '../shared/stored-assistant-content';

// RLS note (FORCE census): `insights_chat_threads` is RLS-enabled, and so is
// `insights_chat_thread_reads` (migration 434, tenant-scoped read markers →
// withTenantScope). Every
// tenantId-bearing thread op → withTenantScope. `touchThread` is an internal
// by-id timestamp bump with no tenant context in scope → withAdminScope.
// `insights_chat_messages` has no tenant_id column (not RLS) so message CRUD
// stays on the default pool. `getCallerRole` is an auth-lookup primitive
// (pre-tenant-context) → withAdminScope.

export type TenantMemberRole = 'owner' | 'admin' | 'member' | 'viewer';
export type InsightsMessageRole = 'user' | 'assistant';

export interface InsightsChatThread {
  id: string;
  tenantId: string;
  accountId: string;
  title: string | null;
  /** The Insights Manager has replied since this reader last opened the thread
   *  (migration 434). Computed per caller in listThreads; every other read
   *  path returns false, because it has no reader to compute it for. */
  unread: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InsightsChatMessage {
  id: string;
  threadId: string;
  role: InsightsMessageRole;
  content: string;
  visualizationBlocks: unknown[] | null;
  /** What the person attached when they sent this message. Metadata only: an
   *  upload's extracted text is a one-turn model input, not transcript. Always
   *  a list, never null, so the frontend never has to invent the empty case. */
  attachments: ChatMessageAttachment[];
  inputTokens: number;
  outputTokens: number;
  /** What kind of row this is, when it is not ordinary speech. Null for
   *  everything a person or the Insights Manager said, which is every row
   *  written before migration 387. `forwarded_context` is background Liftoff
   *  passed on when it brought the Insights Manager into one of its
   *  conversations: a report about the thread, not a turn in it. */
  messageType: string | null;
  /** Images, video or audio the reply produced. Its own carrier rather than a
   *  new member of visualizationBlocks: that union is this surface's content
   *  model and extending it would change what Insights renders. Null when the
   *  message carried none. */
  media: MediaRef[] | null;
  /** File cards presented into this message. Its own carrier for the same
   *  reason media has one: the visualization block union is this surface's
   *  content model and a file is not part of it. Always a list. */
  files: FileCard[];
  /** Colleagues other than the Insights Manager who had a hand in the reply.
   *  Same shape and name as every other surface's message, so one renderer
   *  draws the chips. Always a list, empty when nobody else contributed. */
  contributors: Contributor[];
  /** Who sent a person's message (migration 492), resolved through accounts
   *  when the row names one. Null on an assistant row and on a human row
   *  written before the column existed. */
  sender: { accountId: string; firstName: string | null; lastName: string | null } | null;
  createdAt: string;
}

export interface PaginatedThreads {
  threads: InsightsChatThread[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PaginatedMessages {
  messages: InsightsChatMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ListThreadsOptions {
  cursor?: string | null;
  limit?: number;
  /** Case-insensitive substring match on the title (the Chat History search). */
  titleQuery?: string;
}

export interface ListMessagesOptions {
  cursor?: string | null;
  limit?: number;
}

// Defaults per the implementation plan: thread list returns 20 most recent,
// messages within a thread also paginated 20 at a time. Caps prevent abuse.
const DEFAULT_THREAD_LIMIT = 20;
const MAX_THREAD_LIMIT = 100;

// "Has an unread reply", asked with the thread aliased t and this reader's
// marker LEFT JOINed as r. Same predicate as agent chat's (migration 338) and
// Liftoff's (migration 433), against this surface's own clock column: NULL
// means the Insights Manager has never replied here, which is never unread.
// Exported for the migration's integration test, which proves the predicate
// against the real schema.
export const UNREAD_PREDICATE = `
  t.last_assistant_message_at IS NOT NULL
    AND (r.last_read_at IS NULL OR t.last_assistant_message_at > r.last_read_at)
`;
const DEFAULT_MESSAGE_LIMIT = 20;
const MAX_MESSAGE_LIMIT = 200;

// ── Permission helpers ──────────────────────────────────────────────────

const PRIVILEGED_ROLES: ReadonlySet<TenantMemberRole> = new Set(['owner', 'admin']);

/**
 * Whether this caller may act on a thread somebody else started.
 *
 * Only destructive writes ask: deleting and renaming. Reading has no equivalent
 * gate any more, which is the whole point of migration 351, so there is
 * deliberately no `canSeeAllTenantThreads` left for a future read path to reach
 * for by mistake.
 */
function canActOnOthersThreads(role: TenantMemberRole): boolean {
  return PRIVILEGED_ROLES.has(role);
}

/**
 * The rule both destructive writes share: your own thread, or a privileged role.
 */
function canModifyThread(
  thread: InsightsChatThread,
  accountId: string,
  role: TenantMemberRole,
): boolean {
  return thread.accountId === accountId || canActOnOthersThreads(role);
}

// ── Internal row mappers ────────────────────────────────────────────────

function mapThreadRow(row: Record<string, unknown>): InsightsChatThread {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    accountId: row.account_id as string,
    title: (row.title as string | null) ?? null,
    // Only listThreads selects the unread expression; on every other path the
    // column is absent and coerces to false, which is honest: those paths have
    // no reader identity to answer for.
    unread: row.unread === true,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function mapMessageRow(row: Record<string, unknown>): InsightsChatMessage {
  const visualizationBlocks = row.visualization_blocks;
  const media = row.media;
  const files = row.files;
  const attachments = row.attachments;
  const contributors = row.contributors;
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    role: row.role as InsightsMessageRole,
    content: row.content as string,
    visualizationBlocks: Array.isArray(visualizationBlocks)
      ? (visualizationBlocks as unknown[])
      : visualizationBlocks == null
        ? null
        : (visualizationBlocks as unknown[]),
    attachments: Array.isArray(attachments)
      ? (attachments as ChatMessageAttachment[])
      : [],
    inputTokens: (row.input_tokens as number | null) ?? 0,
    outputTokens: (row.output_tokens as number | null) ?? 0,
    messageType: (row.message_type as string | null) ?? null,
    media: Array.isArray(media) ? (media as MediaRef[]) : null,
    files: Array.isArray(files) ? (files as FileCard[]) : [],
    contributors: Array.isArray(contributors) ? (contributors as Contributor[]) : [],
    sender: typeof row.sender_account_id === 'string'
      ? {
        accountId: row.sender_account_id,
        firstName: (row.sender_first_name as string | null) ?? null,
        lastName: (row.sender_last_name as string | null) ?? null,
      }
      : null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

// ── Thread CRUD ─────────────────────────────────────────────────────────

/**
 * Create a new thread for the given account in the given tenant. Title is
 * optional; the chat service auto-generates one from the first user message
 * later in the flow (Phase 6). Returns the persisted row.
 */
export async function createThread(input: {
  tenantId: string;
  accountId: string;
  title?: string | null;
}): Promise<InsightsChatThread> {
  const result = await withTenantScope(input.tenantId, (client) => client.query(
    `INSERT INTO insights_chat_threads (tenant_id, account_id, title)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.tenantId, input.accountId, input.title ?? null],
  ));
  return mapThreadRow(result.rows[0]);
}

/**
 * List every non-deleted thread in the tenant, newest activity first.
 *
 * Visibility takes no caller identity: since migration 351 the workspace is
 * the unit of it, so there is nothing left to narrow by. The history list a
 * member sees is the same list an owner sees, including threads other people
 * started. `accountId` is the READER, not a filter — it only decides whose
 * read markers the per-row `unread` flag consults (migration 434).
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

  const params: Array<string | number | Date> = [tenantId, accountId];
  let sql = `
    SELECT t.id, t.tenant_id, t.account_id, t.title, t.created_at, t.updated_at,
           (${UNREAD_PREDICATE}) AS unread
    FROM insights_chat_threads t
    LEFT JOIN insights_chat_thread_reads r ON r.thread_id = t.id AND r.account_id = $2
    WHERE t.tenant_id = $1
      AND t.deleted_at IS NULL
  `;

  if (options.titleQuery) {
    params.push(`%${escapeLikePattern(options.titleQuery)}%`);
    sql += ` AND t.title ILIKE $${params.length}`;
  }

  if (cursor) {
    params.push(new Date(cursor));
    sql += ` AND t.updated_at < $${params.length}`;
  }

  params.push(limit + 1);
  sql += ` ORDER BY t.updated_at DESC LIMIT $${params.length}`;

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
 * Fetch one thread by id. Returns null if the thread doesn't exist, is deleted,
 * or belongs to a different tenant. Cross-tenant lookups are intentionally
 * indistinguishable from "not found" so we never confirm the existence of
 * foreign thread ids.
 *
 * Tenant membership is the whole check since migration 351, so the caller is not
 * consulted: the router has already established that whoever is asking belongs
 * to this workspace, and a workspace member may read any Insights thread in it.
 */
export async function getThread(
  threadId: string,
  tenantId: string,
): Promise<InsightsChatThread | null> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT id, tenant_id, account_id, title, created_at, updated_at
     FROM insights_chat_threads
     WHERE id = $1 AND deleted_at IS NULL`,
    [threadId],
  ));

  if (result.rows.length === 0) return null;
  const thread = mapThreadRow(result.rows[0]);

  // Tenant isolation — never leak existence of cross-tenant threads. RLS already
  // filters the SELECT, so this is belt-and-braces against a scope that was not
  // applied rather than the primary guard.
  if (thread.tenantId !== tenantId) return null;

  return thread;
}

/**
 * Soft-delete a thread. Anyone in the tenant can delete their own thread; owners
 * and admins can additionally delete anyone's. Returns true if a row was
 * deleted, false if the thread does not exist or is not the caller's to remove
 * (the router reports both as 404, to avoid existence leaks).
 *
 * This kept its rule when reads widened in migration 351, and the check now has
 * to be written here: it used to fall out of getThread returning null, which a
 * tenant-wide read no longer does. Being able to open a colleague's conversation
 * is not the same as being able to destroy it.
 */
export async function deleteThread(
  threadId: string,
  tenantId: string,
  accountId: string,
  role: TenantMemberRole,
): Promise<boolean> {
  const existing = await getThread(threadId, tenantId);
  if (!existing) return false;
  if (!canModifyThread(existing, accountId, role)) return false;

  const result = await withTenantScope(tenantId, (client) => client.query(
    `UPDATE insights_chat_threads
     SET deleted_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL`,
    [threadId],
  ));
  return (result.rowCount ?? 0) > 0;
}

/**
 * Touch the thread's updated_at timestamp so it bubbles to the top of the
 * list view. Called by appendMessage() so the chat history modal naturally
 * orders by recency. No permission check — this is an internal helper.
 */
async function touchThread(threadId: string, fromAssistant: boolean): Promise<void> {
  // Internal by-id timestamp bump called from appendMessage(), which only
  // carries threadId (no tenant context). The thread was already visibility-
  // checked by the caller via getThread(); this is a pure recency touch keyed
  // by PK → withAdminScope.
  //
  // `fromAssistant` additionally stamps the reply clock (migration 434), which
  // is what the unread indicators read. appendMessage is the only INSERT into
  // insights_chat_messages, so deciding it there covers every writer.
  await withAdminScope(
    { caller: 'insights.touchThread', reason: 'internal by-id updated_at bump; no tenant context in scope' },
    (client) => client.query(
      `UPDATE insights_chat_threads
       SET updated_at = NOW()${fromAssistant ? ', last_assistant_message_at = NOW()' : ''}
       WHERE id = $1`,
      [threadId],
    ),
  );
}

/**
 * Update a thread's title. Used by the chat service in Phase 6 to set the
 * auto-generated title from the first user message. Permission rules
 * mirror deleteThread, for the same reason: renaming somebody else's
 * conversation rewrites how they find it again.
 */
export async function updateThreadTitle(
  threadId: string,
  tenantId: string,
  accountId: string,
  role: TenantMemberRole,
  title: string,
): Promise<InsightsChatThread | null> {
  const existing = await getThread(threadId, tenantId);
  if (!existing) return null;
  if (!canModifyThread(existing, accountId, role)) return null;

  const result = await withTenantScope(tenantId, (client) => client.query(
    `UPDATE insights_chat_threads
     SET title = $2, updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [threadId, title],
  ));
  return result.rows[0] ? mapThreadRow(result.rows[0]) : null;
}

/**
 * Internal title update for the fire-and-forget AI title generator.
 * Skips role/permission checks — tenant isolation is enforced at the SQL
 * level via `tenant_id` in the WHERE clause. The
 * `title_source IS DISTINCT FROM 'user'` guard makes a future user-rename
 * endpoint safe from AI overwrite. `title_source = 'ai'` is allowed to
 * match because an earlier AI title is still fair game to refresh.
 */
export async function updateThreadTitleInternal(
  threadId: string,
  tenantId: string,
  title: string,
): Promise<void> {
  await withTenantScope(tenantId, (client) => client.query(
    `UPDATE insights_chat_threads
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

// ── Rolling summary (Phase 6) ───────────────────────────────────────────

/**
 * Fetch the rolling conversation summary for a thread. Returns null if the
 * thread doesn't exist, isn't in the caller's tenant, is deleted, or has
 * no summary yet (short threads never need one).
 *
 * Tenant isolation enforced at the query level — never trusts a row whose
 * tenant_id doesn't match, even if the caller provides a stray threadId.
 * We intentionally skip the role check here: this is an internal chat
 * service call that always happens AFTER the caller has been resolved to
 * a valid member of the tenant via getThread().
 */
export async function getThreadRollingSummary(
  threadId: string,
  tenantId: string,
): Promise<ConversationSummary | null> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT rolling_summary
     FROM insights_chat_threads
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [threadId, tenantId],
  ));
  if (result.rows.length === 0) return null;
  const raw = result.rows[0].rolling_summary;
  if (raw == null) return null;
  // pg returns JSONB columns already-parsed as a JS object.
  return raw as ConversationSummary;
}

/**
 * Write a new rolling summary for a thread. No-op (returns false) if the
 * thread doesn't exist / isn't in the tenant / is deleted. Tenant isolation
 * enforced at the query level.
 *
 * Called fire-and-forget from the chat service after each turn on long
 * threads. Must never throw in a way that affects the chat loop — the
 * caller wraps this in try/catch.
 */
export async function updateThreadRollingSummary(
  threadId: string,
  tenantId: string,
  summary: ConversationSummary,
): Promise<boolean> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `UPDATE insights_chat_threads
     SET rolling_summary = $3::jsonb
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [threadId, tenantId, JSON.stringify(summary)],
  ));
  return (result.rowCount ?? 0) > 0;
}

// ── Unread state ────────────────────────────────────────────────────────
//
// Migration 434, agent chat's 338 applied to this surface (Liftoff's copy is
// 433). One marker per (thread, account), because two people in one workspace
// have genuinely different unread state.

/**
 * Record that this account has now seen everything in this thread.
 *
 * Upsert rather than insert-then-update: the row exists after the first read
 * and every subsequent open is a rewrite of the same timestamp.
 *
 * No thread-existence check — the caller does that, and the composite FK to
 * insights_chat_threads (id, tenant_id) makes a marker for another tenant's
 * thread unwritable regardless.
 */
export async function markThreadRead(
  tenantId: string,
  accountId: string,
  threadId: string,
): Promise<void> {
  await withTenantScope(tenantId, (client) => client.query(
    `INSERT INTO insights_chat_thread_reads (thread_id, account_id, tenant_id, last_read_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (thread_id, account_id)
     DO UPDATE SET last_read_at = NOW()`,
    [threadId, accountId, tenantId],
  ));
}

/**
 * Mark every thread that is unread for this caller as read. The WHERE is
 * getUnreadThreadCount's, so the count this clears is exactly the one the
 * badge shows. Returns how many threads were marked.
 */
export async function markAllThreadsRead(
  tenantId: string,
  accountId: string,
): Promise<number> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `INSERT INTO insights_chat_thread_reads (thread_id, account_id, tenant_id, last_read_at)
     SELECT t.id, $2, $1, NOW()
     FROM insights_chat_threads t
     LEFT JOIN insights_chat_thread_reads r ON r.thread_id = t.id AND r.account_id = $2
     WHERE t.tenant_id = $1
       AND t.deleted_at IS NULL
       AND ${UNREAD_PREDICATE}
     ON CONFLICT (thread_id, account_id)
     DO UPDATE SET last_read_at = NOW()`,
    [tenantId, accountId],
  ));
  return result.rowCount ?? 0;
}

/**
 * How many threads carry an unread Insights Manager reply for this account
 * across the whole tenant. Backs the dot on the sidebar's Insights icon, and
 * it is the same question the list's per-row flag answers — one predicate for
 * both, so the two indicators cannot disagree.
 */
export async function getUnreadThreadCount(
  tenantId: string,
  accountId: string,
): Promise<number> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT COUNT(*)::int AS unread
     FROM insights_chat_threads t
     LEFT JOIN insights_chat_thread_reads r ON r.thread_id = t.id AND r.account_id = $2
     WHERE t.tenant_id = $1
       AND t.deleted_at IS NULL
       AND ${UNREAD_PREDICATE}`,
    [tenantId, accountId],
  ));
  return (result.rows[0]?.unread as number | undefined) ?? 0;
}

// ── Message CRUD ────────────────────────────────────────────────────────

/**
 * Append a message to a thread. Caller must have already verified visibility
 * via getThread() so we can fail fast on permission errors before the write.
 *
 * The repository takes pre-validated content — Zod sanitization happens at
 * the router boundary. Touches the parent thread's updated_at so it bubbles
 * to the top of list views.
 */
interface AppendMessageBase {
  threadId: string;
  content: string;
  visualizationBlocks?: unknown[] | null;
  /** Metadata for what the message carried. Callers pass the projection from
   *  chat-service, which is where upload content is dropped. */
  attachments?: readonly ChatMessageAttachment[] | null;
  /** Images, video or audio produced for this message. Its own column, so the
   *  visualization block union — this surface's content model — is untouched. */
  media?: readonly MediaRef[] | null;
  /** File cards presented into this message. Sparse like `media`. */
  files?: readonly FileCard[] | null;
  inputTokens?: number;
  outputTokens?: number;
  /** Omitted for ordinary speech, which is almost every caller. */
  messageType?: string | null;
  /** Colleagues other than the Insights Manager who had a hand in the reply,
   *  already resolved to the names the person sees. No caller passes it
   *  today; the column keeps its `[]` default. */
  contributors?: readonly Contributor[] | null;
  /** The turn this row was written inside (migration 547). Absent for a row
   *  written outside any turn — a forwarded-context report, a medium arriving on
   *  its own — and NULL is the right answer there: recall reads turns, and such
   *  a row is not part of one. */
  turnId?: string | null;
}

/**
 * What a message write must carry, by who is speaking.
 *
 * A person's message names its sender (migration 492) and the type makes it
 * impossible not to: every writer of `role: 'user'` has an authenticated
 * account in scope, and a nullable field would let a future writer satisfy the
 * type while breaking the promise the column exists for. The assistant arm has
 * no sender. If a guest-capable surface is ever added here it gets its own
 * explicit variant rather than a null.
 */
export type AppendMessageInput =
  | (AppendMessageBase & { role: 'user'; senderAccountId: string })
  | (AppendMessageBase & { role: 'assistant' });

export async function appendMessage(input: AppendMessageInput): Promise<InsightsChatMessage> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO insights_chat_messages
       (thread_id, role, content, visualization_blocks, input_tokens, output_tokens,
        message_type, media, attachments, sender_account_id, contributors, files,
        turn_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      input.threadId,
      input.role,
      storedAssistantContent(input.role, input.content),
      input.visualizationBlocks ? JSON.stringify(input.visualizationBlocks) : null,
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
      input.messageType ?? null,
      // Sparse, like the column beside it: no media stores NULL rather than an
      // empty array.
      input.media && input.media.length > 0 ? JSON.stringify(input.media) : null,
      // Same, and for the same reason migration 348 gives on Liftoff: most
      // messages carry nothing, and the read path maps NULL back to [].
      input.attachments && input.attachments.length > 0
        ? JSON.stringify(input.attachments)
        : null,
      input.role === 'user' ? input.senderAccountId : null,
      // NOT sparse: the column is NOT NULL DEFAULT '[]' (migration 493), so
      // "nobody" is written as the empty list it reads back as.
      JSON.stringify(input.contributors ?? []),
      // Sparse like `media`, for the same reason and with the same read mapping.
      input.files && input.files.length > 0 ? JSON.stringify(input.files) : null,
      input.turnId ?? null,
    ],
  );

  // Bubble the thread to the top of list views. Done in the same call,
  // not a transaction — the worst case on partial failure is the new
  // message being orphaned at the bottom of the list, which is recoverable.
  //
  // The reply clock moves only for ordinary assistant SPEECH. Two writers put
  // role='assistant' rows here that nobody said: the forwarded-context report
  // a delegation writes at thread birth, and media rows. Stamping those would
  // hand a delegated thread a dot before anyone has answered anything, so a
  // message that carries a messageType is recency, never unreadness.
  await touchThread(input.threadId, input.role === 'assistant' && !input.messageType);

  return mapMessageRow(result.rows[0]);
}

/**
 * When this assistant last SPOKE on a thread: the newest assistant row with
 * no message type. A typed row (a status line about an approval, a
 * colleague's forwarded note, the person's browser hand-back or point) is
 * about the conversation and is not a reply. Null when it has not replied.
 * The Browser section of a turn counts what happened after this moment as
 * "since your last reply".
 */
export async function lastAssistantReplyAt(threadId: string): Promise<string | null> {
  const result = await getPool().query(
    `SELECT MAX(created_at) AS at
     FROM insights_chat_messages
     WHERE thread_id = $1 AND role = 'assistant' AND message_type IS NULL`,
    [threadId],
  );
  const at = result.rows[0]?.at as Date | null | undefined;
  return at ? new Date(at).toISOString() : null;
}

/**
 * List messages in a thread, newest first. Reverse pagination so the
 * frontend can render a chat scrollback that fetches older messages on
 * scroll-to-top. Cursor is the created_at ISO string of the last (oldest)
 * message on the previous page.
 *
 * Visibility is enforced by requiring the caller to pass the thread's
 * tenant + account context after a getThread() check, NOT by re-querying
 * here — that would force every router call to do two round trips.
 */
export async function listMessages(
  threadId: string,
  options: ListMessagesOptions = {},
): Promise<PaginatedMessages> {
  const pool = getPool();
  const limit = Math.min(options.limit ?? DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
  const cursor = options.cursor ?? null;

  const params: Array<string | number | Date> = [threadId];
  // The accounts join is gated on role='user' so an assistant row never picks
  // up a sender; `accounts` is platform-global and RLS-exempt (migration 095).
  let sql = `
    SELECT m.id, m.thread_id, m.role, m.content, m.visualization_blocks, m.media, m.attachments,
           m.contributors, m.input_tokens, m.output_tokens, m.message_type, m.created_at,
           s.id AS sender_account_id, s.first_name AS sender_first_name, s.last_name AS sender_last_name
    FROM insights_chat_messages m
    LEFT JOIN accounts s ON m.role = 'user' AND s.id = m.sender_account_id
    WHERE m.thread_id = $1
  `;

  if (cursor) {
    params.push(new Date(cursor));
    sql += ` AND m.created_at < $${params.length}`;
  }

  params.push(limit + 1);
  sql += ` ORDER BY m.created_at DESC LIMIT $${params.length}`;

  const result = await pool.query(sql, params);
  const hasMore = result.rows.length > limit;
  const messages = result.rows.slice(0, limit).map(mapMessageRow);

  return {
    messages,
    nextCursor:
      hasMore && messages.length > 0 ? messages[messages.length - 1].createdAt : null,
    hasMore,
  };
}

// ── Membership lookup ───────────────────────────────────────────────────

/**
 * Resolve the caller's role within a tenant for permission checks. Returns
 * null if the account is not a member — the router translates that to 403.
 *
 * Lives here (rather than the router) so the test suite can stub a single
 * function instead of mocking the whole tenant_members repository.
 */
export async function getCallerRole(
  tenantId: string,
  accountId: string,
): Promise<TenantMemberRole | null> {
  // Auth-lookup primitive: insights/router.ts and insights/stream-router.ts
  // call this BEFORE establishing tenant scope (the role itself decides
  // whether the caller may proceed). tenant_members is RLS-on (migration
  // 095) so a raw pool.query would deny the lookup once RLS enforces; use
  // withAdminScope. Query is naturally scoped by (tenant_id, account_id).
  try {
    const result = await withAdminScope(
      {
        caller: 'insights.getCallerRole',
        reason: 'auth lookup — tenant context not yet established',
      },
      (client) =>
        client.query(
          `SELECT role FROM tenant_members WHERE tenant_id = $1 AND account_id = $2`,
          [tenantId, accountId],
        ),
    );
    return result.rows[0] ? (result.rows[0].role as TenantMemberRole) : null;
  } catch (error) {
    log.error(
      { tenantId, accountId, error: (error as Error).message },
      'Failed to resolve tenant member role',
    );
    return null;
  }
}

// ── Turns ───────────────────────────────────────────────────────────────

/**
 * Open the turn a person's message belongs to (migration 547).
 *
 * The turn, not the thread, is what recall is keyed to — the boundary
 * agent_chat_turns already draws for agent chat, and for the same reason: a
 * thread can carry more than one person, so who spoke is a property of the
 * exchange rather than of the thread.
 *
 * IDEMPOTENT ON THE TURN ID, as agent-chat's is, so a retry arriving with an id
 * already minted neither duplicates the turn nor dies on the primary key. Every
 * producer writing inside one turn passes that same id.
 *
 * `sender_account_id` NULL means no resolved account, and such a turn is never
 * embedded: a vector nobody can be matched against is a cost with no reader.
 */
export async function createTurn(
  tenantId: string,
  threadId: string,
  turnId: string,
  senderAccountId: string | null,
): Promise<void> {
  await withTenantScope(tenantId, (client) => client.query(
    `INSERT INTO insights_chat_turns (id, tenant_id, thread_id, sender_account_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [turnId, tenantId, threadId, senderAccountId],
  ));
}
