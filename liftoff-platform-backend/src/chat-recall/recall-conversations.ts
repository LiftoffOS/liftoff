// Searching a person's OTHER conversations with this assistant.
//
// The companion to read-thread-history: that one reads further back in the
// conversation the model is in, this one looks in the other ones. Keeping them
// apart is what lets each be bounded for its own job — a thread read carries
// whole messages, a search carries excerpts from several conversations.
//
// SCOPE IS (TENANT, THIS ASSISTANT'S TABLES, THE ASKING PERSON), and the middle
// term is carried by which tables are read rather than by a column. There is no
// agent_id here because these assistants have no internal_agents row. The
// consequence is the property that matters: Liftoff cannot reach an Insights
// Manager conversation and neither can reach an agent's, because neither can
// name another surface's tables.
//
// THE PERSON IS THE BOUNDARY, NOT THE THREAD. Both surfaces' threads are
// readable by the whole workspace, so scoping a cross-thread search by thread
// ownership would let one person's search surface another person's words. It is
// scoped by `sender_account_id` on the TURN — the person who spoke — which is
// exactly why migration 547 puts that column on the turn.
//
// TWO ARMS, keyword always and semantic only when keyword left room. No
// incremental result means no embed charge and no added latency, which is the
// rule the team-chat recall already follows. A failed query embedding falls back
// to the keyword rows rather than failing the search.
//
// WHY THE TEAM-CHAT STATEMENTS ARE NOT REUSED. They live in
// internal-api/platform-tools-router and read three columns these tables do not
// have (agent_id, the thread's channel, and tenant_id on the message rows).
// Folding both into one statement means conditional fragments inside SQL whose
// value is in being readable. What IS shared is everything that drifts
// dangerously: the storage dimension, the query embedder and its provider/model
// pinning, the per-hit message bound, and the excerpt window.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { getRecallQueryEmbedding } from '../agent-chat/turn-embedding-service';
import type { EmbeddableSurface } from './turn-embedding';
import { narrationSqlList } from '../agent-chat/transcript-context';

/** Messages previewed per conversation hit. A bound rather than a preference:
 *  without one a single long turn crowds out every other conversation the search
 *  found. Six is the opening and the resolution of an exchange, which is what
 *  makes a hit recognisable. Same figure team-chat recall uses. */
const MESSAGES_PER_HIT = 6;

/** Characters of each message shown. The excerpt is windowed around the match
 *  when there is one, so a hit is readable rather than just present. */
const PREVIEW_CHARS = 200;
const PREVIEW_LEAD = 80;

const MAX_HITS = 10;
const DEFAULT_HITS = 5;
const MAX_QUERY_CHARS = 200;

/** The narration types as a SQL literal list, built from the ONE predicate that
 *  decides what is speech (agent-chat/transcript-context), so a seventh type
 *  added there is excluded here on the same edit. */
const NARRATION_SQL_LIST = narrationSqlList();

const TURNS: Record<EmbeddableSurface, string> = {
  liftoff: 'liftoff_chat_turns',
  insights: 'insights_chat_turns',
};
const MESSAGES: Record<EmbeddableSurface, string> = {
  liftoff: 'liftoff_chat_messages',
  insights: 'insights_chat_messages',
};
const THREADS: Record<EmbeddableSurface, string> = {
  liftoff: 'liftoff_chat_threads',
  insights: 'insights_chat_threads',
};

const RECALL_QUERY_PURPOSE: Record<EmbeddableSurface, string> = {
  liftoff: 'liftoff_recall_query',
  insights: 'insights_recall_query',
};

/** The excerpt, windowed on the match when the literal text is present and a
 *  plain head otherwise — a semantic hit need not contain the words, and a
 *  mis-windowed excerpt reads worse than the start of the message. */
function previewExpr(): string {
  return `CASE
             WHEN $4::text IS NOT NULL AND position($4::text IN lower(m.content)) > 0
             THEN substring(m.content
                    FROM greatest(1, position($4::text IN lower(m.content)) - ${PREVIEW_LEAD})
                    FOR ${PREVIEW_CHARS})
             ELSE LEFT(m.content, ${PREVIEW_CHARS})
           END`;
}

/** The messages of one hit: what the two of them said, oldest first, bounded.
 *  The platform's own out-of-turn rows are excluded — an assistant-role status
 *  line is not something anyone said, and quoting it back as "what you
 *  discussed" wastes the preview budget and confuses the answer. */
function messagesLateral(surface: EmbeddableSurface, turnRef: string): string {
  return `CROSS JOIN LATERAL (
  SELECT COALESCE(jsonb_agg(e ORDER BY e.created_at ASC), '[]'::jsonb) AS messages
  FROM (
    SELECT m.role, m.created_at, ${previewExpr()} AS preview
    FROM ${MESSAGES[surface]} m
    WHERE m.turn_id = ${turnRef}
      AND m.role IN ('user','assistant')
      AND (m.message_type IS NULL OR m.message_type NOT IN (${NARRATION_SQL_LIST}))
    -- THE MATCHING MESSAGE COMES FIRST, then context in time order. Ordering by
    -- time alone and cutting at the bound returns a hit whose excerpts never
    -- mention the words that matched it: the keyword arm matches if ANY message
    -- in the turn contains them, so a match in the seventh message showed six
    -- excerpts about something else. A model then quotes an unrelated excerpt as
    -- its evidence, or — being careful — reports the hit as irrelevant and drops
    -- a conversation that did answer the question.
    --
    -- On the semantic arm $4 is still the person's words, so this orders by them
    -- when they happen to appear and is inert when they do not, which is the
    -- normal case there.
    --
    -- The outer jsonb_agg re-sorts by created_at, so the excerpts a model reads
    -- are still in reading order; this ordering only decides WHICH ones survive
    -- the bound.
    ORDER BY (CASE
                WHEN $4::text IS NOT NULL AND position($4::text IN lower(m.content)) > 0 THEN 0
                ELSE 1
              END), m.created_at ASC
    LIMIT ${MESSAGES_PER_HIT}
  ) e
) x`;
}

/** Shared by both arms: $1 tenant, $2 account, $3 limit, $4 lowered raw query
 *  (the excerpt window) or NULL, $5 turn to exclude or NULL. Keyword-only: $6
 *  ILIKE pattern or NULL.
 *
 *  Every parameter a statement is given is REFERENCED by it. Postgres infers a
 *  parameter's type from its use, so one passed and never mentioned fails the
 *  whole statement with "could not determine data type" — which is why the two
 *  arms do not share one positional list. */
export function keywordSql(surface: EmbeddableSurface): string {
  return `
SELECT tr.id AS turn_id, tr.thread_id, th.title, tr.created_at, x.messages
FROM ${TURNS[surface]} tr
JOIN ${THREADS[surface]} th
  ON th.id = tr.thread_id AND th.tenant_id = tr.tenant_id
${messagesLateral(surface, 'tr.id')}
WHERE tr.tenant_id = $1
  AND tr.sender_account_id = $2
  AND th.deleted_at IS NULL
  AND ($5::uuid IS NULL OR tr.id <> $5)
  AND ($6::text IS NULL OR EXISTS (
        SELECT 1 FROM ${MESSAGES[surface]} mq
        WHERE mq.turn_id = tr.id
          AND mq.role IN ('user','assistant')
          AND mq.content ILIKE $6))
ORDER BY tr.created_at DESC
LIMIT $3
`;
}

/** Semantic-only after the shared five: $6 query vector, $7 provider, $8 model.
 *  Vectors from different providers or models are different spaces and must
 *  never be compared, which is why both are predicates rather than assumptions.
 *  No ILIKE pattern is passed here — this arm never uses one. */
export function semanticSql(surface: EmbeddableSurface): string {
  return `
WITH ranked AS (
  -- At most ONE hit per conversation. Without it a single long thread that
  -- discussed a topic repeatedly takes every slot and the other conversations
  -- that also touched it never surface.
  SELECT DISTINCT ON (tr.thread_id)
         tr.id AS turn_id, tr.thread_id, tr.created_at,
         tr.content_embedding <=> $6::vector AS distance
  FROM ${TURNS[surface]} tr
  JOIN ${THREADS[surface]} th
    ON th.id = tr.thread_id AND th.tenant_id = tr.tenant_id
  WHERE tr.tenant_id = $1
    AND tr.sender_account_id = $2
    AND th.deleted_at IS NULL
    AND ($5::uuid IS NULL OR tr.id <> $5)
    AND tr.content_embedding IS NOT NULL
    AND tr.content_embedding_provider = $7
    AND tr.content_embedding_model = $8
  ORDER BY tr.thread_id, tr.content_embedding <=> $6::vector, tr.created_at DESC, tr.id
)
SELECT r.turn_id, r.thread_id, th.title, r.created_at, x.messages,
       1 - r.distance AS similarity
FROM ranked r
JOIN ${THREADS[surface]} th ON th.id = r.thread_id AND th.tenant_id = $1
${messagesLateral(surface, 'r.turn_id')}
ORDER BY r.distance, r.created_at DESC, r.turn_id
LIMIT $3
`;
}

interface HitRow {
  turn_id: string;
  thread_id: string;
  title: string | null;
  created_at: Date;
  messages: Array<{ role: string; preview: string; created_at: string }>;
}

export interface RecallContext {
  surface: EmbeddableSurface;
  tenantId: string;
  /** The person asking. Recall never crosses to another person's words. */
  accountId: string;
  /** The turn being executed, excluded so a search does not return the question
   *  that asked it. */
  excludeTurnId?: string;
}

export interface RecallInput {
  query?: string;
  limit?: number;
}

function boundedLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_HITS;
  return Math.min(MAX_HITS, Math.max(1, Math.floor(n)));
}

function render(hits: HitRow[], query: string | null): string {
  if (hits.length === 0) {
    return query
      ? `No other conversation with this person mentions "${query}".`
      : 'There are no other conversations with this person yet.';
  }
  const header = query
    ? `${hits.length} earlier conversation(s) with this person mentioning "${query}", most recent first.`
    : `The ${hits.length} most recent other conversation(s) with this person.`;
  const body = hits.map((hit) => {
    const when = hit.created_at instanceof Date
      ? hit.created_at.toISOString().slice(0, 16).replace('T', ' ')
      : String(hit.created_at).slice(0, 16).replace('T', ' ');
    const title = hit.title?.trim() || 'Untitled conversation';
    const lines = (hit.messages ?? []).map((m) => `    ${m.role === 'user' ? 'Person' : 'You'}: ${m.preview}`);
    return `[${when}] ${title}\n${lines.join('\n')}`;
  }).join('\n\n');
  return `${header}\n\n${body}\n\n(Excerpts only. For something said earlier in the CURRENT conversation, `
    + 'use read_conversation_history instead — it reads this thread in full.)';
}

/** Search the person's other conversations with this assistant. Never throws. */
export async function recallConversations(
  ctx: RecallContext,
  input: RecallInput,
): Promise<string> {
  const limit = boundedLimit(input.limit);
  const trimmed = typeof input.query === 'string' && input.query.trim().length > 0
    ? input.query.trim().slice(0, MAX_QUERY_CHARS)
    : null;
  // LIKE-escaped so a model's `%` is a literal percent rather than a wildcard
  // that matches the whole table.
  const pattern = trimmed ? `%${trimmed.replace(/[%_\\]/g, '\\$&')}%` : null;
  const rawLower = trimmed ? trimmed.toLowerCase() : null;
  const exclude = ctx.excludeTurnId ?? null;

  try {
    const keyword = await withTenantScope(ctx.tenantId, (client) => client.query(
      keywordSql(ctx.surface),
      [ctx.tenantId, ctx.accountId, limit, rawLower, exclude, pattern],
    ).then((r) => r.rows as HitRow[]));

    let rows = keyword;
    let retrieval = 'keyword';

    // The semantic arm only earns its cost when keyword left a slot unfilled.
    if (trimmed && keyword.length < limit && process.env.RECALL_SEMANTIC_READ_ENABLED === 'true') {
      const embedding = await getRecallQueryEmbedding(trimmed, {
        tenantId: ctx.tenantId,
        purpose: RECALL_QUERY_PURPOSE[ctx.surface],
      });
      if (embedding) {
        const semantic = await withTenantScope(ctx.tenantId, (client) => client.query(
          semanticSql(ctx.surface),
          [
            ctx.tenantId, ctx.accountId, limit, rawLower, exclude,
            `[${embedding.vector.join(',')}]`, embedding.provider, embedding.model,
          ],
        ).then((r) => r.rows as HitRow[]));
        const seen = new Set(keyword.map((r) => r.turn_id));
        rows = [...keyword, ...semantic.filter((r) => !seen.has(r.turn_id))].slice(0, limit);
        retrieval = 'semantic+keyword';
      }
      // A null embedding keeps the keyword rows: a search that found something
      // is worth more than an error about the arm that could not run.
    }

    log.info(
      {
        event: 'platform_assistant_recall',
        surface: ctx.surface,
        tenantId: ctx.tenantId,
        mode: trimmed ? 'search' : 'recent',
        retrieval,
        matchCount: rows.length,
      },
      'platform assistant recall executed',
    );

    return render(rows, trimmed);
  } catch (err) {
    log.warn(
      { surface: ctx.surface, tenantId: ctx.tenantId, err: (err as Error).message },
      'platform assistant recall failed',
    );
    return 'Those conversations could not be searched right now. Say plainly that the earlier conversations could not be reached.';
  }
}
