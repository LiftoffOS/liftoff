// Liftoff Chat Repository
//
// CRUD for `liftoff_chat_threads` and `liftoff_chat_messages` (migration 348).
//
// Permission model, enforced inside this repository and not the router:
//
//   role          | list + read scope | delete / rename own | ... anyone else's
//   --------------+-------------------+---------------------+------------------
//   owner / admin | every tenant thread | yes               | yes
//   member        | every tenant thread | yes               | no
//   viewer        | every tenant thread | yes               | no
//
// Reads are workspace-wide (migration 351). They did not start that way: until
// then a member or a viewer could only see threads they had started themselves,
// and that made a Liftoff conversation impossible to hand to a colleague. Team
// chat (`agent_chat_threads`) has always been tenant-wide, and this surface now
// matches it: any member of the workspace can open any thread in it, and every
// thread appears in every member's history list. The widening is retroactive,
// since privacy lived in the read query rather than in a per-thread flag.
//
// Writes stayed where they were. Deleting or renaming somebody else's thread is
// still author-or-privileged, because a read that widened too far is a
// disclosure the workspace can live with and a destroyed conversation is not.
//
// Soft delete: a "deleted" thread sets `deleted_at` and is hidden from every
// read path (list, get, messages). The two CREATE INDEX ... WHERE deleted_at IS
// NULL partial indexes from migration 348 cover the two list paths.
//
// Pagination uses cursor-based scrolling, NOT offsets. Threads are listed
// forward by `updated_at DESC` (newest activity first), messages are listed
// reverse by `created_at DESC` (newest at bottom of viewport, scrolling up
// loads older). Cursor format is opaque to the client: currently the ISO
// timestamp of the last row, but callers should not rely on the shape.

import { getPool, withTenantScope, withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
// The rolling summary is produced by the shared summarizer in
// src/insights/conversation-summarization.ts, which owns the shape; importing
// the type from there keeps the two from drifting apart.
import type { ConversationSummary } from '../insights/conversation-summarization';
// One shape for media on every surface, so the column and the renderer cannot
// drift apart per table.
import type { MediaRef } from '../media/attach';
import type { FileCard } from '../generated-files/file-card';
import type { ChatMessageAttachment, Contributor } from '../chat-attachments';
import { storedAssistantContent } from '../shared/stored-assistant-content';

// RLS note (FORCE census): `liftoff_chat_threads` is RLS-enabled, and so is
// `liftoff_chat_thread_reads` (migration 433). Every tenantId-bearing thread
// or read-marker op → withTenantScope. `touchThread` is an internal by-id
// timestamp bump with no tenant context in scope → withAdminScope.
// `liftoff_chat_messages` has no tenant_id column (not RLS) so message CRUD
// stays on the default pool, and `liftoff_thread_delegations` (migration 349)
// follows the same rule for the same reason: it hangs off a thread the caller
// has already been permission-checked against. `getCallerRole` is an
// auth-lookup primitive (pre-tenant-context) → withAdminScope.

export type TenantMemberRole = 'owner' | 'admin' | 'member' | 'viewer';
export type LiftoffMessageRole = 'user' | 'assistant';

export interface LiftoffChatThread {
  id: string;
  tenantId: string;
  accountId: string;
  title: string | null;
  /** Liftoff has replied since this reader last opened the thread (migration
   *  433). Computed per caller in listThreads; every other read path returns
   *  false, because it has no reader to compute it for. */
  unread: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Which colleague a Liftoff thread has been paired with. Same vocabulary as
 *  the frontend mention roster (migration 349). */
export type LiftoffDelegationKind = 'caio' | 'insights' | 'team';

/** A Liftoff conversation's thread on a colleague's own surface. One row per
 *  conversation per colleague, reused for every later handover so the colleague
 *  keeps its plan and its history. */
export interface LiftoffThreadDelegation {
  targetKind: LiftoffDelegationKind;
  /** The agent, for kind 'team'. Null for the two singleton colleagues. */
  targetId: string | null;
  /** The paired thread id on that colleague's surface. */
  delegateThreadId: string;
}

/**
 * What a message keeps about one attachment once its turn is over: enough to
 * render the chip again on reload, and nothing more.
 *
 * The shape now lives in @liftoffos/chat-attachments, because the Insights
 * Manager and the Chief AI Officer store exactly the same thing and the CAIO
 * is in another repository. This alias keeps the Liftoff-shaped name its
 * existing callers use.
 */
export type LiftoffMessageAttachment = ChatMessageAttachment;

export interface LiftoffChatMessage {
  id: string;
  threadId: string;
  role: LiftoffMessageRole;
  content: string;
  /** Always a list, never null: the frontend renders chips from it, and an
   *  absent field would make every caller re-invent the empty case. */
  attachments: LiftoffMessageAttachment[];
  /** Which colleague wrote it: 'caio', 'insights', or an agent's id. Null is
   *  Liftoff itself, and is what an untouched transcript reads back as. */
  author: string | null;
  /** That colleague's name as the person saw it. Stored rather than resolved so
   *  a renamed or deleted team does not relabel a reply already read. */
  authorLabel: string | null;
  /** The same fact in the shape every other surface's message carries, so one
   *  renderer draws the chips: a hand-over is the one-element case, derived
   *  from `author` / `authorLabel` rather than stored a second time. `[]` for
   *  a reply Liftoff wrote itself. */
  contributors: Contributor[];
  /** Blocks the reply rendered beside its text, e.g. the org chart the Chief AI
   *  Officer emits when it proposes a team. Always a list for the same reason
   *  attachments is. */
  visualizationBlocks: unknown[];
  /** What kind of row this is, when it is not ordinary speech. Only
   *  `'hitl_status'` is written today: the sentence a conversation posts into
   *  itself when the colleague it handed the turn to stopped for an approval.
   *  Null is speech, and is what every message written before migration 352
   *  reads back as. Same vocabulary as agent_chat_messages.message_type, so the
   *  two surfaces render the same fact the same way. */
  messageType: string | null;
  /** Images, video or audio the reply produced. Its own carrier, never
   *  `attachments`: on this table that column means what the PERSON sent, and
   *  media has to mean one thing on every surface. Always a list, for the same
   *  reason attachments is. */
  media: MediaRef[];
  /** File cards presented into this message. Always a list, for the same
   *  reason attachments is. */
  files: FileCard[];
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
}

export interface PaginatedThreads {
  threads: LiftoffChatThread[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PaginatedMessages {
  messages: LiftoffChatMessage[];
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

// Thread list returns 20 most recent, messages within a thread also paginated
// 20 at a time. Caps prevent abuse.
const DEFAULT_THREAD_LIMIT = 20;
const MAX_THREAD_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 20;
const MAX_MESSAGE_LIMIT = 200;

// "Has an unread reply", asked with the thread aliased t and this reader's
// marker LEFT JOINed as r. Same predicate as agent chat's (chat-repository.ts,
// migration 338), against this surface's own clock column: NULL means Liftoff
// has never replied here, which is never unread. Exported for the migration's
// integration test, which proves the predicate against the real schema.
export const UNREAD_PREDICATE = `
  t.last_assistant_message_at IS NOT NULL
    AND (r.last_read_at IS NULL OR t.last_assistant_message_at > r.last_read_at)
`;

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
function canModifyThread(thread: LiftoffChatThread, accountId: string, role: TenantMemberRole): boolean {
  return thread.accountId === accountId || canActOnOthersThreads(role);
}

// ── Internal row mappers ────────────────────────────────────────────────

function mapThreadRow(row: Record<string, unknown>): LiftoffChatThread {
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

function mapMessageRow(row: Record<string, unknown>): LiftoffChatMessage {
  // pg hands back JSONB already parsed. NULL (the common case: most messages
  // carry nothing) and anything that is not an array both read back as an
  // empty list, so a caller never has to tell "no attachments" apart from
  // "column written before this feature existed".
  const attachments = row.attachments;
  const visualizationBlocks = row.visualization_blocks;
  const media = row.media;
  const files = row.files;
  const author = (row.author as string | null) ?? null;
  const authorLabel = (row.author_label as string | null) ?? null;
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    role: row.role as LiftoffMessageRole,
    content: row.content as string,
    attachments: Array.isArray(attachments)
      ? (attachments as LiftoffMessageAttachment[])
      : [],
    author,
    authorLabel,
    // Derived, not stored: the author pair is the record and this is its
    // list-shaped reading. A label that was never stored falls back to the
    // id, so a chip is never blank for a row that does name a colleague.
    contributors: author ? [{ id: author, label: authorLabel ?? author }] : [],
    visualizationBlocks: Array.isArray(visualizationBlocks)
      ? (visualizationBlocks as unknown[])
      : [],
    messageType: (row.message_type as string | null) ?? null,
    media: Array.isArray(media) ? (media as MediaRef[]) : [],
    files: Array.isArray(files) ? (files as FileCard[]) : [],
    inputTokens: (row.input_tokens as number | null) ?? 0,
    outputTokens: (row.output_tokens as number | null) ?? 0,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

// ── Thread CRUD ─────────────────────────────────────────────────────────

/**
 * Create a new thread for the given account in the given tenant. Title is
 * optional; the chat service auto-generates one from the first user message
 * later in the flow. Returns the persisted row.
 */
export async function createThread(input: {
  tenantId: string;
  accountId: string;
  title?: string | null;
}): Promise<LiftoffChatThread> {
  const result = await withTenantScope(input.tenantId, (client) => client.query(
    `INSERT INTO liftoff_chat_threads (tenant_id, account_id, title)
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
 * read markers the per-row `unread` flag consults (migration 433).
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
    FROM liftoff_chat_threads t
    LEFT JOIN liftoff_chat_thread_reads r ON r.thread_id = t.id AND r.account_id = $2
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
 * to this workspace, and a workspace member may read any Liftoff thread in it.
 *
 * `accountId` and `role` are accepted and ignored. They are what the old
 * owner-and-admin-see-all matrix consulted, and one call site
 * (src/liftoff/stream-router.ts) still passes them. Removing them there and here
 * is a mechanical follow-up with no behaviour attached; nothing new should pass
 * them.
 */
export async function getThread(
  threadId: string,
  tenantId: string,
): Promise<LiftoffChatThread | null> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT id, tenant_id, account_id, title, created_at, updated_at
     FROM liftoff_chat_threads
     WHERE id = $1 AND deleted_at IS NULL`,
    [threadId],
  ));

  if (result.rows.length === 0) return null;
  const thread = mapThreadRow(result.rows[0]);

  // Tenant isolation: never leak existence of cross-tenant threads. RLS already
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
    `UPDATE liftoff_chat_threads
     SET deleted_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL`,
    [threadId],
  ));
  return (result.rowCount ?? 0) > 0;
}

/**
 * Touch the thread's updated_at timestamp so it bubbles to the top of the
 * list view. Called by appendMessage() so the chat history modal naturally
 * orders by recency. No permission check: this is an internal helper.
 *
 * `fromAssistant` additionally stamps the reply clock (migration 433), which
 * is what the unread indicators read. Same one-writer rule as agent chat's
 * touchThreadOnClient: appendMessage is the only INSERT into
 * liftoff_chat_messages, so stamping here covers every writer, and the clock
 * deliberately does NOT move for the person's own messages.
 */
async function touchThread(threadId: string, fromAssistant: boolean): Promise<void> {
  // Internal by-id timestamp bump called from appendMessage(), which only
  // carries threadId (no tenant context). The thread was already visibility-
  // checked by the caller via getThread(); this is a pure recency touch keyed
  // by PK → withAdminScope.
  await withAdminScope(
    { caller: 'liftoff.touchThread', reason: 'internal by-id updated_at bump; no tenant context in scope' },
    (client) => client.query(
      `UPDATE liftoff_chat_threads
       SET updated_at = NOW()${fromAssistant ? ', last_assistant_message_at = NOW()' : ''}
       WHERE id = $1`,
      [threadId],
    ),
  );
}

/**
 * Update a thread's title. Permission rules mirror deleteThread, for the same
 * reason: renaming somebody else's conversation rewrites how they find it again.
 */
export async function updateThreadTitle(
  threadId: string,
  tenantId: string,
  accountId: string,
  role: TenantMemberRole,
  title: string,
): Promise<LiftoffChatThread | null> {
  const existing = await getThread(threadId, tenantId);
  if (!existing) return null;
  if (!canModifyThread(existing, accountId, role)) return null;

  const result = await withTenantScope(tenantId, (client) => client.query(
    `UPDATE liftoff_chat_threads
     SET title = $2, updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [threadId, title],
  ));
  return result.rows[0] ? mapThreadRow(result.rows[0]) : null;
}

/**
 * Internal title update for the fire-and-forget AI title generator.
 * Skips role/permission checks: tenant isolation is enforced at the SQL
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
    `UPDATE liftoff_chat_threads
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
// Migration 433, agent chat's 338 applied to this surface. One marker per
// (thread, account), because two people in one workspace have genuinely
// different unread state.

/**
 * Record that this account has now seen everything in this thread.
 *
 * Upsert rather than insert-then-update: the row exists after the first read
 * and every subsequent open is a rewrite of the same timestamp.
 *
 * No thread-existence check — the caller does that, and the composite FK to
 * liftoff_chat_threads (id, tenant_id) makes a marker for another tenant's
 * thread unwritable regardless.
 */
export async function markThreadRead(
  tenantId: string,
  accountId: string,
  threadId: string,
): Promise<void> {
  await withTenantScope(tenantId, (client) => client.query(
    `INSERT INTO liftoff_chat_thread_reads (thread_id, account_id, tenant_id, last_read_at)
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
    `INSERT INTO liftoff_chat_thread_reads (thread_id, account_id, tenant_id, last_read_at)
     SELECT t.id, $2, $1, NOW()
     FROM liftoff_chat_threads t
     LEFT JOIN liftoff_chat_thread_reads r ON r.thread_id = t.id AND r.account_id = $2
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
 * How many threads carry an unread Liftoff reply for this account across the
 * whole tenant. Backs the dot on the home page's Resume button, and it is the
 * same question the list's per-row flag answers — one predicate for both, so
 * the two indicators cannot disagree.
 *
 * One number rather than agent chat's per-team map: this surface is a single
 * assistant, so there is no second key to group by.
 */
export async function getUnreadThreadCount(
  tenantId: string,
  accountId: string,
): Promise<number> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT COUNT(*)::int AS unread
     FROM liftoff_chat_threads t
     LEFT JOIN liftoff_chat_thread_reads r ON r.thread_id = t.id AND r.account_id = $2
     WHERE t.tenant_id = $1
       AND t.deleted_at IS NULL
       AND ${UNREAD_PREDICATE}`,
    [tenantId, accountId],
  ));
  return (result.rows[0]?.unread as number | undefined) ?? 0;
}

// ── Rolling summary ─────────────────────────────────────────────────────

/**
 * Fetch the rolling conversation summary for a thread. Returns null if the
 * thread doesn't exist, isn't in the caller's tenant, is deleted, or has
 * no summary yet (short threads never need one).
 *
 * Tenant isolation enforced at the query level: it never trusts a row whose
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
     FROM liftoff_chat_threads
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
 * threads. Must never throw in a way that affects the chat loop: the
 * caller wraps this in try/catch.
 */
export async function updateThreadRollingSummary(
  threadId: string,
  tenantId: string,
  summary: ConversationSummary,
): Promise<boolean> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `UPDATE liftoff_chat_threads
     SET rolling_summary = $3::jsonb
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [threadId, tenantId, JSON.stringify(summary)],
  ));
  return (result.rowCount ?? 0) > 0;
}

// ── Paired colleague threads ────────────────────────────────────────────
//
// `liftoff_thread_delegations` has no tenant_id and therefore no RLS policy,
// the same decision `liftoff_chat_messages` makes and for the same reason:
// tenancy is inherited from the parent thread, which the caller has already
// resolved and permission-checked with getThread(). Both functions below run on
// the default pool for that reason.

/**
 * The thread this conversation already uses with one colleague, or null before
 * the first handover.
 *
 * `targetId` is the agent, and null for the two singleton colleagues. The
 * `IS NOT DISTINCT FROM` comparison is what makes one query serve both: plain
 * equality never matches a NULL, so a 'caio' pairing would look absent every
 * time and each turn would create another team-plan thread.
 */
export async function getThreadDelegation(
  threadId: string,
  targetKind: LiftoffDelegationKind,
  targetId: string | null,
): Promise<LiftoffThreadDelegation | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT target_kind, target_id, delegate_thread_id
     FROM liftoff_thread_delegations
     WHERE liftoff_thread_id = $1
       AND target_kind = $2
       AND target_id IS NOT DISTINCT FROM $3`,
    [threadId, targetKind, targetId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    targetKind: row.target_kind as LiftoffDelegationKind,
    targetId: (row.target_id as string | null) ?? null,
    delegateThreadId: row.delegate_thread_id as string,
  };
}

/**
 * Every colleague this conversation has a thread with.
 *
 * Read by the frontend so a paused status row can offer to open the colleague's
 * own conversation. The row is what makes that possible without putting a thread
 * id anywhere the person can see it: the transcript names the colleague in
 * `author`, and this says which thread that colleague is using here.
 */
export async function listThreadDelegations(
  threadId: string,
): Promise<LiftoffThreadDelegation[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT target_kind, target_id, delegate_thread_id
     FROM liftoff_thread_delegations
     WHERE liftoff_thread_id = $1
     ORDER BY created_at ASC`,
    [threadId],
  );
  return result.rows.map((row) => ({
    targetKind: row.target_kind as LiftoffDelegationKind,
    targetId: (row.target_id as string | null) ?? null,
    delegateThreadId: row.delegate_thread_id as string,
  }));
}

/**
 * The Liftoff conversation a colleague's thread belongs to, looked up FROM the
 * colleague's side.
 *
 * This is the direction the resume takes. A team that paused for an approval
 * finishes its answer long after the Liftoff turn ended, and the only identity
 * that survives that gap is the thread the approval was filed against, which is
 * the colleague's own. Everything else about the delegation has to be recovered
 * from here.
 *
 * `targetKind` is required rather than inferred: the three colleague surfaces
 * keep their thread ids in three different tables, and a workforce team-plan id
 * that happened to collide with an agent-chat id must not resolve.
 */
export async function getDelegationByDelegateThread(
  delegateThreadId: string,
  targetKind: LiftoffDelegationKind,
): Promise<{ liftoffThreadId: string; targetId: string | null } | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT liftoff_thread_id, target_id
     FROM liftoff_thread_delegations
     WHERE delegate_thread_id = $1 AND target_kind = $2`,
    [delegateThreadId, targetKind],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    liftoffThreadId: row.liftoff_thread_id as string,
    targetId: (row.target_id as string | null) ?? null,
  };
}

/**
 * Record the paired thread, and return the one that is now in force.
 *
 * ON CONFLICT DO NOTHING plus a re-read, rather than a plain insert, so a
 * pairing that is already stored always wins. Two turns cannot normally race
 * here (the Liftoff thread lock allows one at a time), but the cost of getting
 * it wrong is high and silent: a second thread with the same colleague splits
 * its plan and history in two and nothing downstream looks broken. The loser of
 * a race carries on in the winner's thread rather than in the orphan it created.
 *
 * The two partial unique indexes from migration 349 are what the conflict fires
 * on, which is why no conflict target is named: one index covers the singletons
 * and the other covers teams.
 */
export async function pairThreadDelegation(input: {
  threadId: string;
  targetKind: LiftoffDelegationKind;
  targetId: string | null;
  delegateThreadId: string;
}): Promise<string> {
  const pool = getPool();
  const inserted = await pool.query(
    `INSERT INTO liftoff_thread_delegations
       (liftoff_thread_id, target_kind, target_id, delegate_thread_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING delegate_thread_id`,
    [input.threadId, input.targetKind, input.targetId, input.delegateThreadId],
  );
  if (inserted.rows[0]) return inserted.rows[0].delegate_thread_id as string;

  const existing = await getThreadDelegation(
    input.threadId,
    input.targetKind,
    input.targetId,
  );
  if (existing) return existing.delegateThreadId;

  // Nothing was inserted and nothing is there to read: the parent thread was
  // deleted mid-turn, so the foreign key rejected the row. The reply is worth
  // more than the pairing, so carry on with what was just created.
  log.warn(
    { threadId: input.threadId, targetKind: input.targetKind },
    'Could not store the paired colleague thread; the conversation may pair again later',
  );
  return input.delegateThreadId;
}

// ── Message CRUD ────────────────────────────────────────────────────────

/**
 * Append a message to a thread. Caller must have already verified visibility
 * via getThread() so we can fail fast on permission errors before the write.
 *
 * The repository takes pre-validated content: Zod sanitization happens at
 * the router boundary. Touches the parent thread's updated_at so it bubbles
 * to the top of list views.
 */
interface AppendMessageBase {
  threadId: string;
  content: string;
  /** Metadata for what the message carried. Callers pass the projection from
   *  chat-service, which is where upload content is dropped. */
  attachments?: readonly LiftoffMessageAttachment[] | null;
  /** Set only when a colleague wrote the reply, together with the name the
   *  person saw. The two travel together: an identity with no label would make
   *  the frontend resolve a team it may no longer be able to resolve. */
  author?: string | null;
  authorLabel?: string | null;
  /** Blocks that were stripped out of the text by the emitting parser and
   *  delivered as their own stream events. Without them the message persists as
   *  text alone and the org chart the person just watched appear is gone on the
   *  next load. */
  visualizationBlocks?: readonly unknown[] | null;
  /** Set only for a row that is not speech. `'hitl_status'` marks the sentence
   *  a conversation posts into itself when the colleague it handed the turn to
   *  stopped for an approval, so the transcript renders it as a status line
   *  rather than as something the colleague said. */
  messageType?: string | null;
  /** Images, video or audio produced for this message. Its own column, so
   *  neither `attachments` (what the person sent) nor `visualization_blocks`
   *  (what the Chief AI Officer drew) has to change meaning. */
  media?: readonly MediaRef[] | null;
  /** File cards presented into this message: a document, a spreadsheet, a PDF.
   *  Its own column for the same reason `media` has one — `attachments` means
   *  what the person sent, and a produced artifact must not borrow it. */
  files?: readonly FileCard[] | null;
  inputTokens?: number;
  outputTokens?: number;
  /** The turn this row was written inside (migration 547). Absent for a row
   *  written outside any turn — a status line, a file presented on its own —
   *  and NULL is the right answer there: recall reads turns, and such a row is
   *  not part of one. */
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

export async function appendMessage(input: AppendMessageInput): Promise<LiftoffChatMessage> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO liftoff_chat_messages
       (thread_id, role, content, attachments, author, author_label,
        visualization_blocks, message_type, media, input_tokens, output_tokens,
        sender_account_id, files, turn_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      input.threadId,
      input.role,
      storedAssistantContent(input.role, input.content),
      // A message with no attachments stores NULL rather than an empty array:
      // the column is sparse by design, and the read path maps both to [].
      input.attachments && input.attachments.length > 0
        ? JSON.stringify(input.attachments)
        : null,
      input.author ?? null,
      input.authorLabel ?? null,
      input.visualizationBlocks && input.visualizationBlocks.length > 0
        ? JSON.stringify(input.visualizationBlocks)
        : null,
      input.messageType ?? null,
      // Sparse like the columns beside it: no media stores NULL rather than an
      // empty array, and the read path maps both to [].
      input.media && input.media.length > 0 ? JSON.stringify(input.media) : null,
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
      input.role === 'user' ? input.senderAccountId : null,
      // Sparse like `media`, for the same reason and with the same read mapping.
      input.files && input.files.length > 0 ? JSON.stringify(input.files) : null,
      input.turnId ?? null,
    ],
  );

  // Bubble the thread to the top of list views. Done in the same call,
  // not a transaction: the worst case on partial failure is the new
  // message being orphaned at the bottom of the list, which is recoverable.
  await touchThread(input.threadId, input.role === 'assistant');

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
     FROM liftoff_chat_messages
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
 * here, which would force every router call to do two round trips.
 */
export async function listMessages(
  threadId: string,
  options: ListMessagesOptions = {},
): Promise<PaginatedMessages> {
  const pool = getPool();
  const limit = Math.min(options.limit ?? DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
  const cursor = options.cursor ?? null;

  const params: Array<string | number | Date> = [threadId];
  let sql = `
    SELECT id, thread_id, role, content, attachments, author, author_label,
           visualization_blocks, message_type, media, input_tokens, output_tokens,
           created_at
    FROM liftoff_chat_messages
    WHERE thread_id = $1
  `;

  if (cursor) {
    params.push(new Date(cursor));
    sql += ` AND created_at < $${params.length}`;
  }

  params.push(limit + 1);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

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
 * null if the account is not a member: the router translates that to 403.
 *
 * Lives here (rather than the router) so the test suite can stub a single
 * function instead of mocking the whole tenant_members repository.
 */
export async function getCallerRole(
  tenantId: string,
  accountId: string,
): Promise<TenantMemberRole | null> {
  // Auth-lookup primitive: liftoff/stream-router.ts calls this BEFORE
  // establishing tenant scope (the role itself decides whether the caller may
  // proceed). tenant_members is RLS-on (migration 095) so a raw pool.query
  // would deny the lookup once RLS enforces; use withAdminScope. Query is
  // naturally scoped by (tenant_id, account_id).
  try {
    const result = await withAdminScope(
      {
        caller: 'liftoff.getCallerRole',
        reason: 'auth lookup: tenant context not yet established',
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
    `INSERT INTO liftoff_chat_turns (id, tenant_id, thread_id, sender_account_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [turnId, tenantId, threadId, senderAccountId],
  ));
}
