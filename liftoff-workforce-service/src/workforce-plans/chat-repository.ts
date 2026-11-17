// Team Plan Chat Repository
//
// CRUD for `team_plan_threads` and `team_plan_messages` (migration 086).
// Cloned from platform-backend src/workforce-plans/chat-repository.ts with
// these differences:
//
//   - Auth comes from trusted headers (x-tenant-id, x-account-id, x-tenant-role)
//     rather than Firebase — the caller already resolved the account.
//   - ConversationSummary and TenantMemberRole are inlined (no PB insight deps).
//   - Import paths use .js extensions (ESM).
//
// Permission model:
//
//   role          | list scope        | read/write own | read/write any in tenant
//   --------------+-------------------+----------------+-------------------------
//   owner / admin | all tenant threads| yes            | yes
//   member        | own threads only  | yes            | no
//   viewer        | own threads only  | yes            | no
//
// RLS:
//   All functions that receive tenantId run inside withTenantContext() so the
//   DB-level RLS policy on team_plan_threads and team_plan_messages enforces
//   tenant isolation. appendMessage and listMessages operate by threadId only
//   and rely on the thread-level isolation already enforced when the thread was
//   fetched.

import { withTenantContext } from '../infrastructure/rls.js';

// Inlined from platform-backend src/insights/types.ts
/** Re-exported from the summarization client so the column's shape has exactly
 *  one definition. It is platform-backend's structured summary, not the flat
 *  `{summary, messageCount}` the stub used to write; rows still holding that
 *  older shape are read as "no summary" and regenerated (isUsableSummary). */
export type { ConversationSummary } from './conversation-summarization.js';
import type { ConversationSummary } from './conversation-summarization.js';
import { COLLEAGUE_MESSAGE_TYPE } from './message-types.js';
// The attachment contract, published from platform-backend so this service and
// it run one implementation rather than two that drift.
import type { ChatMessageAttachment, Contributor, MediaRef } from '@liftoffos/chat-attachments';
import { storedAssistantContent } from './stored-assistant-content.js';

/**
 * One file, as a person sees it in a Chief AI Officer conversation.
 *
 * Declared here rather than imported: this service owns its own database and
 * this is the shape its own column holds. The control plane writes the same
 * shape into the other three surfaces' tables, and the one that matters is
 * `downloadUrl` — explicitly null rather than omitted, because the card hides
 * its download button on `=== null` and offers to open the file where it
 * actually lives instead.
 */
export interface TeamPlanFileCard {
  generatedFileId: string;
  filename: string;
  outputType: string;
  version: number;
  downloadUrl: string | null;
  webViewUrl?: string;
}

// Inlined from platform-backend src/insights/chat-repository.ts
export type TenantMemberRole = 'owner' | 'admin' | 'member' | 'viewer';

export type TeamPlanMessageRole = 'user' | 'assistant';

export interface TeamPlanChatThread {
  id: string;
  tenantId: string;
  accountId: string;
  title: string | null;
  workforcePlanId: string | null;
  /** The Chief AI Officer has replied since this reader last opened the
   *  thread (migration 024). Computed per caller in listThreads; every other
   *  read path returns false, because it has no reader to compute it for. */
  unread: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One step of a browser task's loop, as the runtime observed and projected
 *  it, kept on the trail entry: bounded, redacted, with the flags that say
 *  what the protected data policy or this service's bounding changed. */
export interface ToolTrailStep {
  type: string;
  action: string;
  pageUrl: string;
  actionTruncated: boolean;
  pageUrlTruncated: boolean;
  protectedDataOmitted: boolean;
  protectedKind: string;
  pageUrlProtectedDataOmitted: boolean;
  /** ISO 8601 when the loop reported a time; null otherwise. */
  at: string | null;
}

/** One tool call of an assistant turn, as kept on the message: the tool, what
 *  it was asked (bounded, redacted), what came back (bounded, redacted), and,
 *  for a browser task, the loop's own steps with the completeness fields. The
 *  four input/outcome flags are set whenever bounding or redaction changed
 *  those fields, so a reader never presents an altered text as exact. A
 *  turn that exceeded the entry cap ends with one `record_gap` sentinel
 *  (`captureGap: true`, `gapReason: 'tool_call_cap'`) naming the omitted
 *  count, never a silently sliced trail. */
export interface ToolTrailEntry {
  tool: string;
  input: Record<string, unknown>;
  outcome: string;
  /** The loop's own steps when the tool reported them (a browser task). */
  steps?: ToolTrailStep[];
  stepsTruncated?: boolean;
  captureGap?: boolean;
  gapReason?: string;
  inputTruncated?: boolean;
  inputProtectedDataOmitted?: boolean;
  outcomeTruncated?: boolean;
  outcomeProtectedDataOmitted?: boolean;
}

export interface TeamPlanChatMessage {
  id: string;
  threadId: string;
  role: TeamPlanMessageRole;
  content: string;
  visualizationBlocks: unknown[] | null;
  /** What the assistant DID in this turn, in order. Always a list; empty for
   *  a turn that called nothing and for messages written before the column. */
  toolTrail: ToolTrailEntry[];
  /** What the person attached when they sent this message. Metadata only: an
   *  upload's extracted text is a one-turn model input, not transcript. Always
   *  a list, so no caller has to invent the empty case. */
  attachments: ChatMessageAttachment[];
  /** Images, video or audio this message carries to be DISPLAYED, as opposed to
   *  `attachments`, which is what the person handed over and is merely named
   *  back to them. Its own carrier so neither meaning has to bend; the bytes
   *  live in the platform's object storage and the URL is minted at render
   *  time. Null when the message carries none — see migration 023. */
  media: MediaRef[] | null;
  /** File cards shown into this message. Always a list, for the same reason
   *  attachments is. */
  files: TeamPlanFileCard[];
  /** Colleagues other than the Chief AI Officer who had a hand in the reply.
   *  Same shape and name as every other surface's message, so one renderer
   *  draws the chips. Always a list, empty when nobody else contributed —
   *  see migration 028. */
  contributors: Contributor[];
  inputTokens: number;
  outputTokens: number;
  /** What kind of row this is, when it is not ordinary speech. Null for
   *  everything a person or the Chief AI Officer said, which is every row
   *  written before migration 020. `forwarded_context` is background Liftoff
   *  passed on when it brought the CAIO into one of its conversations: a report
   *  about the thread, not a turn in it. */
  messageType: string | null;
  createdAt: string;
}

export interface PaginatedTeamPlanThreads {
  threads: TeamPlanChatThread[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PaginatedTeamPlanMessages {
  messages: TeamPlanChatMessage[];
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

const DEFAULT_THREAD_LIMIT = 20;
const MAX_THREAD_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 20;
const MAX_MESSAGE_LIMIT = 200;

// "Has an unread reply", asked with the thread aliased t and this reader's
// marker LEFT JOINed as r. Same predicate as platform-backend's three chat
// surfaces (its migrations 338/433/434), against this database's own clock
// column (migration 024): NULL means the Chief AI Officer has never replied
// here, which is never unread. Exported so a test can prove the predicate
// rather than restate it.
export const UNREAD_PREDICATE = `
  t.last_assistant_message_at IS NOT NULL
    AND (r.last_read_at IS NULL OR t.last_assistant_message_at > r.last_read_at)
`;

// ── Permission helpers ──────────────────────────────────────────────────
//
// Reading a plan thread is workspace-wide (see getThread). These govern the two
// things that are still personal: whose threads show up in Chat History, and
// who may delete one.

const PRIVILEGED_ROLES: ReadonlySet<TenantMemberRole> = new Set(['owner', 'admin']);

function canSeeAllTenantThreads(role: TenantMemberRole): boolean {
  return PRIVILEGED_ROLES.has(role);
}

// ── Row mappers ─────────────────────────────────────────────────────────

function mapThreadRow(row: Record<string, unknown>): TeamPlanChatThread {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    accountId: row.account_id as string,
    title: (row.title as string | null) ?? null,
    workforcePlanId: (row.workforce_plan_id as string | null) ?? null,
    // Only listThreads selects the unread expression; on every other path the
    // column is absent and coerces to false, which is honest: those paths have
    // no reader identity to answer for.
    unread: row.unread === true,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function mapMessageRow(row: Record<string, unknown>): TeamPlanChatMessage {
  const visualizationBlocks = row.visualization_blocks;
  const attachments = row.attachments;
  const media = row.media;
  const contributors = row.contributors;
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    role: row.role as TeamPlanMessageRole,
    content: row.content as string,
    visualizationBlocks: Array.isArray(visualizationBlocks)
      ? (visualizationBlocks as unknown[])
      : visualizationBlocks == null
        ? null
        : (visualizationBlocks as unknown[]),
    attachments: Array.isArray(attachments)
      ? (attachments as ChatMessageAttachment[])
      : [],
    media: Array.isArray(media) ? (media as MediaRef[]) : null,
    files: Array.isArray(row.files) ? (row.files as TeamPlanFileCard[]) : [],
    // The column is NOT NULL DEFAULT '[]', so anything but a list is a row
    // read through a path that did not select it; a list is what every
    // reader wants either way.
    contributors: Array.isArray(contributors) ? (contributors as Contributor[]) : [],
    toolTrail: Array.isArray(row.tool_trail) ? (row.tool_trail as ToolTrailEntry[]) : [],
    inputTokens: (row.input_tokens as number | null) ?? 0,
    outputTokens: (row.output_tokens as number | null) ?? 0,
    messageType: (row.message_type as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

// ── Thread CRUD ─────────────────────────────────────────────────────────

export async function createThread(input: {
  tenantId: string;
  accountId: string;
  title?: string | null;
}): Promise<TeamPlanChatThread> {
  return withTenantContext(input.tenantId, async (client) => {
    const result = await client.query(
      `INSERT INTO team_plan_threads (tenant_id, account_id, title)
       VALUES ($1, $2, $3)
       RETURNING id, tenant_id, account_id, title, workforce_plan_id, created_at, updated_at`,
      [input.tenantId, input.accountId, input.title ?? null],
    );
    return mapThreadRow(result.rows[0]);
  });
}

export async function listThreads(
  tenantId: string,
  accountId: string,
  role: TenantMemberRole,
  options: ListThreadsOptions = {},
): Promise<PaginatedTeamPlanThreads> {
  return withTenantContext(tenantId, async (client) => {
    const limit = Math.min(options.limit ?? DEFAULT_THREAD_LIMIT, MAX_THREAD_LIMIT);
    const cursor = options.cursor ?? null;

    const showAll = canSeeAllTenantThreads(role);

    // $2 is the READER: it always feeds the read-marker join (migration 024),
    // and doubles as the visibility filter for the roles that only see their
    // own threads. Privileged roles keep the wider list; the join narrows
    // nothing either way.
    const params: Array<string | number | Date> = [tenantId, accountId];
    let sql = `
      SELECT t.id, t.tenant_id, t.account_id, t.title, t.workforce_plan_id,
             t.created_at, t.updated_at,
             (${UNREAD_PREDICATE}) AS unread
      FROM team_plan_threads t
      LEFT JOIN team_plan_thread_reads r ON r.thread_id = t.id AND r.account_id = $2
      WHERE t.tenant_id = $1
        AND t.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM team_plan_messages
          WHERE thread_id = t.id AND role = 'user'
        )
    `;

    if (!showAll) {
      sql += ` AND t.account_id = $2`;
    }

    if (options.titleQuery) {
      params.push(`%${options.titleQuery.replace(/[%_\\]/g, '\\$&')}%`);
      sql += ` AND t.title ILIKE $${params.length}`;
    }

    if (cursor) {
      params.push(new Date(cursor));
      sql += ` AND t.updated_at < $${params.length}`;
    }

    params.push(limit + 1);
    sql += ` ORDER BY t.updated_at DESC LIMIT $${params.length}`;

    const result = await client.query(sql, params);
    const hasMore = result.rows.length > limit;
    const threads = result.rows.slice(0, limit).map(mapThreadRow);

    return {
      threads,
      nextCursor: hasMore && threads.length > 0 ? threads[threads.length - 1].updatedAt : null,
      hasMore,
    };
  });
}

/**
 * Read a plan thread. Scoped to the tenant and nothing narrower.
 *
 * This used to refuse any thread a member did not personally start, which made
 * a shared /share/<id> link 404 for exactly the people it was shared with. The
 * rule arrived by inheritance: the CAIO chat was cloned from the Insights chat,
 * where a private analytics conversation deserves it. The CAIO is the opposite —
 * a workspace planning assistant whose output is a workspace-wide plan — and its
 * mutations are gated independently by TOOL_ACCESS_MATRIX, where a member cannot
 * draft, commit or approve anything. Read access grants no write. Agent chat,
 * the surface this is meant to match, has never had the restriction.
 *
 * Deleting is still personal; deleteThread checks that itself rather than
 * borrowing this function, so widening read here cannot widen delete.
 */
export async function getThread(
  threadId: string,
  tenantId: string,
): Promise<TeamPlanChatThread | null> {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, tenant_id, account_id, title, workforce_plan_id, created_at, updated_at
       FROM team_plan_threads
       WHERE id = $1 AND deleted_at IS NULL`,
      [threadId],
    );

    if (result.rows.length === 0) return null;
    const thread = mapThreadRow(result.rows[0]);

    // Tenant isolation — never leak existence of cross-tenant threads. RLS
    // already scopes the read; this is the belt to its braces.
    if (thread.tenantId !== tenantId) return null;

    return thread;
  });
}

/**
 * Soft-delete a plan thread. Its author, or an owner/admin.
 *
 * The permission check is written out here rather than delegated to getThread.
 * It used to lean on it, so the moment reading a thread became workspace-wide
 * any member could have deleted anybody's planning conversation — a silent
 * widening with nothing in the diff to notice.
 */
export async function deleteThread(
  threadId: string,
  tenantId: string,
  accountId: string,
  role: TenantMemberRole,
): Promise<boolean> {
  // getThread uses its own withTenantContext; here we open a second one for
  // the delete. Acceptable — threads aren't high-frequency.
  const existing = await getThread(threadId, tenantId);
  if (!existing) return false;
  if (!canSeeAllTenantThreads(role) && existing.accountId !== accountId) {
    return false;
  }

  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `UPDATE team_plan_threads
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`,
      [threadId],
    );
    return (result.rowCount ?? 0) > 0;
  });
}


export async function updateThreadTitle(
  threadId: string,
  tenantId: string,
  accountId: string,
  role: TenantMemberRole,
  title: string,
): Promise<TeamPlanChatThread | null> {
  // getThread uses its own withTenantContext; permission check must come first.
  // Renaming is personal like deleting, so it carries its own check rather than
  // inheriting getThread's, which is now workspace-wide.
  const existing = await getThread(threadId, tenantId);
  if (!existing) return null;
  if (!canSeeAllTenantThreads(role) && existing.accountId !== accountId) {
    return null;
  }

  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `UPDATE team_plan_threads
       SET title = $2, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, tenant_id, account_id, title, workforce_plan_id, created_at, updated_at`,
      [threadId, title],
    );
    return result.rows[0] ? mapThreadRow(result.rows[0]) : null;
  });
}

/**
 * Internal title update for the fire-and-forget AI title generator.
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
  return withTenantContext(tenantId, async (client) => {
    await client.query(
      `UPDATE team_plan_threads
       SET title = $1,
           title_source = 'ai',
           title_generated_at = NOW(),
           updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3
         AND deleted_at IS NULL
         AND title_source IS DISTINCT FROM 'user'`,
      [title, threadId, tenantId],
    );
  });
}

/**
 * Link a workforce plan to a thread. Called by the chat service the first
 * time the CAIO drafts a plan in a conversation, so subsequent turns on the
 * same thread can load plan state into the context without a reverse lookup.
 *
 * Tenant-scoped at the query level to prevent cross-tenant writes even if
 * an internal caller supplies a mismatched tenantId.
 */
export async function linkWorkforcePlan(
  threadId: string,
  tenantId: string,
  workforcePlanId: string,
): Promise<boolean> {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `UPDATE team_plan_threads
       SET workforce_plan_id = $3, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [threadId, tenantId, workforcePlanId],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

// ── Rolling summary ─────────────────────────────────────────────────────

export async function getThreadRollingSummary(
  threadId: string,
  tenantId: string,
): Promise<ConversationSummary | null> {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `SELECT rolling_summary
       FROM team_plan_threads
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [threadId, tenantId],
    );
    if (result.rows.length === 0) return null;
    const raw = result.rows[0].rolling_summary;
    if (raw == null) return null;
    return raw as ConversationSummary;
  });
}

export async function updateThreadRollingSummary(
  threadId: string,
  tenantId: string,
  summary: ConversationSummary,
): Promise<boolean> {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `UPDATE team_plan_threads
       SET rolling_summary = $3::jsonb
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [threadId, tenantId, JSON.stringify(summary)],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

// ── Message CRUD ────────────────────────────────────────────────────────

interface AppendMessageBase {
  threadId: string;
  tenantId: string;
  content: string;
  visualizationBlocks?: unknown[] | null;
  /** Metadata for what the message carried. Callers pass the projection from
   *  the shared package, which is where upload content is dropped. */
  attachments?: readonly ChatMessageAttachment[] | null;
  /** Images, video or audio the message carries to be displayed. */
  media?: readonly MediaRef[] | null;
  /** File cards shown into this message (migration 030). Sparse like `media`. */
  files?: readonly TeamPlanFileCard[] | null;
  inputTokens?: number;
  outputTokens?: number;
  /** Omitted for ordinary speech, which is almost every caller. */
  messageType?: string | null;
  /** The turn's tool calls, already bounded and redacted by the caller. */
  toolTrail?: readonly ToolTrailEntry[] | null;
  /** Colleagues other than the Chief AI Officer who had a hand in the reply,
   *  already resolved to the names the person sees. No caller passes it
   *  today; the column keeps its `[]` default. */
  contributors?: readonly Contributor[] | null;
  /** The turn this row was written inside (migration 031). Absent for a row
   *  written outside any turn — a forwarded-context report at a delegated
   *  thread's birth, a file presented on its own — and NULL is the right answer
   *  there: a search reads turns, and such a row is not part of one. */
  turnId?: string | null;
}

/**
 * What a message write must carry, by who is speaking.
 *
 * A person's message names its sender (migration 027) and the type makes it
 * impossible not to: every writer of `role: 'user'` has an authenticated
 * account in scope, and a nullable field would let a future writer satisfy the
 * type while breaking the promise the column exists for. The assistant arm has
 * no sender. If a guest-capable surface is ever added here it gets its own
 * explicit variant rather than a null.
 */
export type AppendMessageInput =
  | (AppendMessageBase & { role: 'user'; senderAccountId: string })
  | (AppendMessageBase & { role: 'assistant' });

export async function appendMessage(input: AppendMessageInput): Promise<TeamPlanChatMessage> {
  return withTenantContext(input.tenantId, async (client) => {
    const result = await client.query(
      `INSERT INTO team_plan_messages
         (thread_id, role, content, visualization_blocks, input_tokens, output_tokens,
          message_type, attachments, media, tool_trail, sender_account_id, contributors, files,
          turn_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        input.threadId,
        input.role,
        storedAssistantContent(input.role, input.content),
        input.visualizationBlocks ? JSON.stringify(input.visualizationBlocks) : null,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.messageType ?? null,
        // Sparse like the column beside it: no attachments stores NULL rather
        // than an empty array, and the read path maps both to [].
        input.attachments && input.attachments.length > 0
          ? JSON.stringify(input.attachments)
          : null,
        // Sparse for the same reason as the columns beside it.
        input.media && input.media.length > 0 ? JSON.stringify(input.media) : null,
        input.toolTrail && input.toolTrail.length > 0 ? JSON.stringify(input.toolTrail) : null,
        input.role === 'user' ? input.senderAccountId : null,
        // NOT sparse: the column is NOT NULL DEFAULT '[]' (migration 028), so
        // "nobody" is written as the empty list it reads back as.
        JSON.stringify(input.contributors ?? []),
        // Sparse like `media`, for the same reason and with the same read
        // mapping (migration 030).
        input.files && input.files.length > 0 ? JSON.stringify(input.files) : null,
        input.turnId ?? null,
      ],
    );

    // The reply clock (migration 024) moves only for assistant SPEECH. A
    // forwarded-context report is written role='assistant' with a messageType
    // at a delegated thread's birth, and stamping it would hand the thread a
    // dot before anyone has answered anything; a status row about a pause is
    // the same kind of note. The provisioning notice carries no messageType
    // and stamps, which is right - it is news. A `colleague` row is speech:
    // it is the reply the person was waiting for, said by the colleague the
    // Chief AI Officer brought in, and a thread whose answer never moved the
    // clock would never read unread.
    const fromAssistant = input.role === 'assistant'
      && (!input.messageType || input.messageType === COLLEAGUE_MESSAGE_TYPE);
    await client.query(
      `UPDATE team_plan_threads
       SET updated_at = NOW()${fromAssistant ? ', last_assistant_message_at = NOW()' : ''}
       WHERE id = $1`,
      [input.threadId],
    );

    return mapMessageRow(result.rows[0]);
  });
}

// ── Workspace export feeds ──────────────────────────────────────────────
//
// The control plane's workspace export reads this surface through two
// independently bounded feeds, threads and messages, so a single long thread
// can never carry an unbounded message array past the export's ceiling before
// the export can count it. Each is one ordered pass keyed on (created_at, id)
// bounded by the caller's `asOf`: the UI pagers here key on a bare timestamp
// and would lose one of two rows sharing a boundary. The export groups
// messages by thread in memory and applies its own transcript projection.

/** A thread as the export feed serves it. */
export interface TeamPlanExportThread {
  id: string;
  accountId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A message as the export feed serves it: speech, its sender (migration 027),
 *  what the person attached, who else had a hand in it (migration 028), and
 *  the type of anything that is not speech. */
export interface TeamPlanExportMessage {
  id: string;
  threadId: string;
  role: TeamPlanMessageRole;
  content: string;
  senderAccountId: string | null;
  attachments: ChatMessageAttachment[];
  media: MediaRef[] | null;
  messageType: string | null;
  /** Colleagues other than the Chief AI Officer who had a hand in the reply.
   *  Always a list, empty when nobody else contributed. */
  contributors: Contributor[];
  createdAt: string;
}

export interface ExportFeedOptions {
  asOf: Date;
  cursor?: string | null;
  limit?: number;
}

export const EXPORT_FEED_MAX_LIMIT = 200;

/** Opaque composite cursor. The timestamp travels as Postgres text rather than
 *  a JS Date because a Date truncates `timestamptz` to milliseconds, and a
 *  truncated boundary silently drops every row inside the same millisecond. */
function encodeExportCursor(sortAt: string, id: string): string {
  return Buffer.from(`${sortAt}|${id}`, 'utf8').toString('base64');
}

function decodeExportCursor(cursor?: string | null): { sortAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep < 1) return null;
    const sortAt = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    if (!sortAt || !id) return null;
    return { sortAt, id };
  } catch {
    return null;
  }
}

export async function exportThreads(
  tenantId: string,
  options: ExportFeedOptions,
): Promise<{ threads: TeamPlanExportThread[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? EXPORT_FEED_MAX_LIMIT, 1), EXPORT_FEED_MAX_LIMIT);
  const cursor = decodeExportCursor(options.cursor);
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `SELECT t.id, t.account_id, t.title, t.created_at, t.updated_at,
              t.created_at::text AS sort_cursor
         FROM team_plan_threads t
        WHERE t.tenant_id = $1
          AND t.deleted_at IS NULL
          AND t.created_at <= $2::timestamptz
          AND ($3::timestamptz IS NULL OR (t.created_at, t.id) > ($3::timestamptz, $4::uuid))
        ORDER BY t.created_at ASC, t.id ASC
        LIMIT $5`,
      [tenantId, options.asOf, cursor?.sortAt ?? null, cursor?.id ?? null, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit) as Array<Record<string, unknown>>;
    const threads: TeamPlanExportThread[] = rows.map((row) => ({
      id: row.id as string,
      accountId: row.account_id as string,
      title: (row.title as string | null) ?? null,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    }));
    const last = rows[rows.length - 1];
    return {
      threads,
      nextCursor: hasMore && last ? encodeExportCursor(last.sort_cursor as string, last.id as string) : null,
    };
  });
}

export async function exportMessages(
  tenantId: string,
  options: ExportFeedOptions,
): Promise<{ messages: TeamPlanExportMessage[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? EXPORT_FEED_MAX_LIMIT, 1), EXPORT_FEED_MAX_LIMIT);
  const cursor = decodeExportCursor(options.cursor);
  return withTenantContext(tenantId, async (client) => {
    // Messages have no tenant column; the join through the thread is what
    // scopes them, and a deleted thread's messages stay out with it.
    const result = await client.query(
      `SELECT m.id, m.thread_id, m.role, m.content, m.sender_account_id,
              m.attachments, m.media, m.contributors, m.message_type, m.created_at,
              m.created_at::text AS sort_cursor
         FROM team_plan_messages m
         JOIN team_plan_threads t ON t.id = m.thread_id
        WHERE t.tenant_id = $1
          AND t.deleted_at IS NULL
          AND m.created_at <= $2::timestamptz
          AND ($3::timestamptz IS NULL OR (m.created_at, m.id) > ($3::timestamptz, $4::uuid))
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT $5`,
      [tenantId, options.asOf, cursor?.sortAt ?? null, cursor?.id ?? null, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit) as Array<Record<string, unknown>>;
    const messages: TeamPlanExportMessage[] = rows.map((row) => ({
      id: row.id as string,
      threadId: row.thread_id as string,
      role: row.role as TeamPlanMessageRole,
      content: row.content as string,
      senderAccountId: (row.sender_account_id as string | null) ?? null,
      attachments: Array.isArray(row.attachments) ? (row.attachments as ChatMessageAttachment[]) : [],
      media: Array.isArray(row.media) ? (row.media as MediaRef[]) : null,
      contributors: Array.isArray(row.contributors) ? (row.contributors as Contributor[]) : [],
      messageType: (row.message_type as string | null) ?? null,
      createdAt: (row.created_at as Date).toISOString(),
    }));
    const last = rows[rows.length - 1];
    return {
      messages,
      nextCursor: hasMore && last ? encodeExportCursor(last.sort_cursor as string, last.id as string) : null,
    };
  });
}

// ── Unread state ────────────────────────────────────────────────────────
//
// Migration 024, platform-backend's agent-chat design (its 338, ADR-046)
// applied to the surface whose threads live in this database. One marker per
// (thread, account), because two people in one workspace have genuinely
// different unread state.

/**
 * Record that this account has now seen everything in this thread.
 *
 * Upsert rather than insert-then-update: the row exists after the first read
 * and every subsequent open is a rewrite of the same timestamp.
 *
 * No thread-existence check — the caller does that, and the composite FK to
 * team_plan_threads (id, tenant_id) makes a marker for another tenant's
 * thread unwritable regardless.
 */
export async function markThreadRead(
  tenantId: string,
  accountId: string,
  threadId: string,
): Promise<void> {
  await withTenantContext(tenantId, async (client) => {
    await client.query(
      `INSERT INTO team_plan_thread_reads (thread_id, account_id, tenant_id, last_read_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (thread_id, account_id)
       DO UPDATE SET last_read_at = NOW()`,
      [threadId, accountId, tenantId],
    );
  });
}

/**
 * Mark every thread that is unread for this caller as read. The WHERE is
 * getUnreadThreadCount's, visibility rule included, so the count this clears
 * is exactly the one the badge shows. Returns how many threads were marked.
 */
export async function markAllThreadsRead(
  tenantId: string,
  accountId: string,
  role: TenantMemberRole,
): Promise<number> {
  return withTenantContext(tenantId, async (client) => {
    const showAll = canSeeAllTenantThreads(role);
    const result = await client.query(
      `INSERT INTO team_plan_thread_reads (thread_id, account_id, tenant_id, last_read_at)
       SELECT t.id, $2, $1, NOW()
       FROM team_plan_threads t
       LEFT JOIN team_plan_thread_reads r ON r.thread_id = t.id AND r.account_id = $2
       WHERE t.tenant_id = $1
         AND t.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM team_plan_messages
           WHERE thread_id = t.id AND role = 'user'
         )
         ${showAll ? '' : 'AND t.account_id = $2'}
         AND ${UNREAD_PREDICATE}
       ON CONFLICT (thread_id, account_id)
       DO UPDATE SET last_read_at = NOW()`,
      [tenantId, accountId],
    );
    return result.rowCount ?? 0;
  });
}

/**
 * How many threads carry an unread Chief AI Officer reply for this account.
 *
 * Same visibility rule and same user-message filter as listThreads: the count
 * answers for exactly the list the caller's Chat History shows, so the dot on
 * the Plan Workforce button never points at a thread the modal cannot render.
 */
export async function getUnreadThreadCount(
  tenantId: string,
  accountId: string,
  role: TenantMemberRole,
): Promise<number> {
  return withTenantContext(tenantId, async (client) => {
    const showAll = canSeeAllTenantThreads(role);
    const result = await client.query(
      `SELECT COUNT(*)::int AS unread
       FROM team_plan_threads t
       LEFT JOIN team_plan_thread_reads r ON r.thread_id = t.id AND r.account_id = $2
       WHERE t.tenant_id = $1
         AND t.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM team_plan_messages
           WHERE thread_id = t.id AND role = 'user'
         )
         ${showAll ? '' : 'AND t.account_id = $2'}
         AND ${UNREAD_PREDICATE}`,
      [tenantId, accountId],
    );
    return (result.rows[0]?.unread as number | undefined) ?? 0;
  });
}

/**
 * When the Chief AI Officer last SPOKE on a thread: the newest assistant row
 * with no message type. A typed row (a colleague's reply, a status line about
 * an approval, a forwarded note, the person's browser hand-back or point) is
 * not this assistant's own reply. Null when it has not replied. The Browser
 * section of a turn counts what happened after this moment as "since your
 * last reply".
 */
export async function lastAssistantReplyAt(threadId: string, tenantId: string): Promise<string | null> {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `SELECT MAX(created_at) AS at
       FROM team_plan_messages
       WHERE thread_id = $1 AND role = 'assistant' AND message_type IS NULL`,
      [threadId],
    );
    const at = result.rows[0]?.at as Date | null | undefined;
    return at ? new Date(at).toISOString() : null;
  });
}

export async function listMessages(
  threadId: string,
  tenantId: string,
  options: ListMessagesOptions = {},
): Promise<PaginatedTeamPlanMessages> {
  return withTenantContext(tenantId, async (client) => {
    const limit = Math.min(options.limit ?? DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
    const cursor = options.cursor ?? null;

    const params: Array<string | number | Date> = [threadId];
    let sql = `
      SELECT id, thread_id, role, content, visualization_blocks, attachments, media,
             contributors, input_tokens, output_tokens, message_type, created_at, tool_trail
      FROM team_plan_messages
      WHERE thread_id = $1
    `;

    if (cursor) {
      params.push(new Date(cursor));
      sql += ` AND created_at < $${params.length}`;
    }

    params.push(limit + 1);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    const result = await client.query(sql, params);
    const hasMore = result.rows.length > limit;
    const messages = result.rows.slice(0, limit).map(mapMessageRow);

    return {
      messages,
      nextCursor:
        hasMore && messages.length > 0 ? messages[messages.length - 1].createdAt : null,
      hasMore,
    };
  });
}

// Membership lookup used to live here as getCallerRole(). It queried
// tenant_members, which is a platform-backend table and does not exist in the
// `workforce` database, so it could only ever log and return null. Nothing
// called it: the caller's role arrives on the trusted x-tenant-role header set
// by platform-backend's proxy. Removed rather than left as a query that cannot
// succeed.

// ── Turns ───────────────────────────────────────────────────────────────

/**
 * Open the turn a person's message belongs to (migration 031).
 *
 * The turn, not the thread, is what a conversation search is keyed to — the
 * boundary platform-backend's agent_chat_turns draws for agent chat and its 547
 * draws for the other two assistants, and for the same reason: a thread here is
 * shared workspace-wide and several people take part in one, so who spoke is a
 * property of the exchange.
 *
 * IDEMPOTENT ON THE TURN ID, so a retry arriving with an id already minted
 * neither duplicates the turn nor dies on the primary key. Every producer writing
 * inside one turn passes that same id.
 *
 * `account_id` NULL means no resolved account, and such a turn is never embedded:
 * a vector nobody can be matched against is a cost with no reader.
 */
export async function createTurn(
  tenantId: string,
  threadId: string,
  turnId: string,
  accountId: string | null,
): Promise<void> {
  await withTenantContext(tenantId, (client) => client.query(
    `INSERT INTO team_plan_turns (id, tenant_id, thread_id, account_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [turnId, tenantId, threadId, accountId],
  ));
}
