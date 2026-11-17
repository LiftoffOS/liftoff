// recall_conversations
//
// Searching the person's OTHER conversations with the Chief AI Officer by words.
//
// The CAIO could already BROWSE its conversations (conversations__list) and READ
// one whole (conversation__read). What it could not do is find the one that
// mentioned a thing — so a person saying "the plan we discussed for the invoice
// chasing team" had to be asked which conversation that was, or have every recent
// thread read in turn. This is the search the other three surfaces have.
//
// THE PERSON IS THE BOUNDARY, NOT THE THREAD, and here that is a narrowing rather
// than a widening. Team-plan threads are shared workspace-wide, which is exactly
// why conversation__read may open any of them: the person could open it
// themselves. A cross-thread SEARCH is different — it puts words in front of the
// model that nobody asked it to look at — so it is scoped to turns THIS person
// spoke in, by account_id on the turn (migration 031).
//
// TWO ARMS, keyword always and semantic only when keyword left room: no
// incremental result means no embed charge and no added latency. A failed query
// embedding falls back to the keyword rows rather than failing the search.
//
// Bounded because it lands in the model's context whole and is re-sent on every
// later round of the turn that asked for it — the same argument conversation__read
// makes for its own budget.

import { log } from '../../infrastructure/logging.js';
import { withTenantContext } from '../../infrastructure/rls.js';
import { requestEmbedding } from '../turn-embedding.js';
import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';

/** Conversations returned. A bound rather than a preference: the point of a
 *  search is to narrow, and ten excerpted conversations is already a lot of
 *  context for one answer. */
const MAX_HITS = 10;
const DEFAULT_HITS = 5;

/** Messages previewed per conversation. Without a bound one long turn crowds out
 *  every other conversation the search found; six is the opening and the
 *  resolution of an exchange, which is what makes a hit recognisable. */
const MESSAGES_PER_HIT = 6;

const PREVIEW_CHARS = 200;
const PREVIEW_LEAD = 80;
const MAX_QUERY_CHARS = 200;

/** The excerpt, windowed on the match when the literal words are present and a
 *  plain head otherwise — a semantic hit need not contain them, and a
 *  mis-windowed excerpt reads worse than the start of the message.
 *
 *  Message rows carrying a message_type are excluded: those are written ABOUT the
 *  conversation (a status line, a forwarded note), and quoting one back as "what
 *  you discussed" is both confusing and a waste of the preview budget. */
const MESSAGES_LATERAL = (turnRef: string) => `CROSS JOIN LATERAL (
  SELECT COALESCE(jsonb_agg(e ORDER BY e.created_at ASC), '[]'::jsonb) AS messages
  FROM (
    SELECT m.role, m.created_at,
           CASE
             WHEN $4::text IS NOT NULL AND position($4::text IN lower(m.content)) > 0
             THEN substring(m.content
                    FROM greatest(1, position($4::text IN lower(m.content)) - ${PREVIEW_LEAD})
                    FOR ${PREVIEW_CHARS})
             ELSE LEFT(m.content, ${PREVIEW_CHARS})
           END AS preview
    FROM team_plan_messages m
    WHERE m.turn_id = ${turnRef}
      AND m.role IN ('user','assistant')
      AND m.message_type IS NULL
    -- THE MATCHING MESSAGE COMES FIRST, then context in time order. Ordering by
    -- time alone and cutting at the bound returns a hit whose excerpts never
    -- mention the words that matched it: the keyword arm matches if ANY message
    -- in the turn contains them, so a match in the seventh message showed six
    -- excerpts about something else. Observed live — the Chief AI Officer
    -- returned two conversations and correctly dropped them for not containing
    -- the word, which is the good outcome; the bad one is a model quoting an
    -- unrelated excerpt as its evidence.
    --
    -- On the semantic arm $4 is still the person's words, so this orders by them
    -- when they happen to appear and is inert when they do not.
    --
    -- The outer jsonb_agg re-sorts by created_at, so the excerpts stay in reading
    -- order; this ordering only decides WHICH ones survive the bound.
    ORDER BY (CASE
                WHEN $4::text IS NOT NULL AND position($4::text IN lower(m.content)) > 0 THEN 0
                ELSE 1
              END), m.created_at ASC
    LIMIT ${MESSAGES_PER_HIT}
  ) e
) x`;

/** Shared: $1 tenant, $2 account, $3 limit, $4 lowered query (the excerpt
 *  window) or NULL, $5 turn to exclude or NULL. Keyword-only: $6 ILIKE pattern
 *  or NULL.
 *
 *  Every parameter a statement is given is REFERENCED by it: Postgres infers a
 *  parameter's type from its use, so one passed and never mentioned fails the
 *  whole statement with "could not determine data type". That is why the two arms
 *  do not share one positional list. */
export const KEYWORD_SQL = `
SELECT tr.id AS turn_id, tr.thread_id, th.title, tr.created_at, x.messages
FROM team_plan_turns tr
JOIN team_plan_threads th ON th.id = tr.thread_id AND th.tenant_id = tr.tenant_id
${MESSAGES_LATERAL('tr.id')}
WHERE tr.tenant_id = $1
  AND tr.account_id = $2
  AND th.deleted_at IS NULL
  AND ($5::uuid IS NULL OR tr.id <> $5)
  AND ($6::text IS NULL OR EXISTS (
        SELECT 1 FROM team_plan_messages mq
        WHERE mq.turn_id = tr.id
          AND mq.role IN ('user','assistant')
          AND mq.content ILIKE $6))
ORDER BY tr.created_at DESC
LIMIT $3
`;

/** Semantic-only after the shared five: $6 query vector, $7 provider, $8 model.
 *  Provider and model are PREDICATES rather than assumptions: vectors from
 *  different spaces are not comparable, and comparing them returns confident
 *  nonsense rather than an error. */
export const SEMANTIC_SQL = `
WITH ranked AS (
  -- At most ONE hit per conversation. Without it a single long thread that
  -- discussed a topic repeatedly takes every slot, and the other conversations
  -- that also touched it never surface.
  SELECT DISTINCT ON (tr.thread_id)
         tr.id AS turn_id, tr.thread_id, tr.created_at,
         tr.content_embedding <=> $6::vector AS distance
  FROM team_plan_turns tr
  JOIN team_plan_threads th ON th.id = tr.thread_id AND th.tenant_id = tr.tenant_id
  WHERE tr.tenant_id = $1
    AND tr.account_id = $2
    AND th.deleted_at IS NULL
    AND ($5::uuid IS NULL OR tr.id <> $5)
    AND tr.content_embedding IS NOT NULL
    AND tr.content_embedding_provider = $7
    AND tr.content_embedding_model = $8
  ORDER BY tr.thread_id, tr.content_embedding <=> $6::vector, tr.created_at DESC, tr.id
)
SELECT r.turn_id, r.thread_id, th.title, r.created_at, x.messages
FROM ranked r
JOIN team_plan_threads th ON th.id = r.thread_id AND th.tenant_id = $1
${MESSAGES_LATERAL('r.turn_id')}
ORDER BY r.distance, r.created_at DESC, r.turn_id
LIMIT $3
`;

interface HitRow {
  turn_id: string;
  thread_id: string;
  title: string | null;
  created_at: Date;
  messages: Array<{ role: string; preview: string }>;
}

function boundedLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_HITS;
  return Math.min(MAX_HITS, Math.max(1, Math.floor(n)));
}

export const recallConversationsTool: WorkforcePlanTool = {
  definition: {
    name: 'recall_conversations',
    description:
      'Search OTHER conversations you have had with this person, by words. Use when they refer to something '
      + 'settled in a previous session — "the plan we discussed", "as we agreed", an agent or a connector '
      + 'named before — instead of asking them which conversation it was. Omit query for the most recent ones. '
      + 'This returns short excerpts and at most one hit per conversation: once you know WHICH conversation, read it '
      + 'whole with conversation__read.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words to search for; omit for the most recent conversations.',
        },
        limit: {
          type: 'integer',
          description: `Conversations to return, 1-${MAX_HITS} (default ${DEFAULT_HITS}).`,
        },
      },
    },
  },

  async execute(input: Record<string, unknown>, ctx: WorkforcePlanToolContext): Promise<unknown> {
    const limit = boundedLimit(input.limit);
    const trimmed = typeof input.query === 'string' && input.query.trim().length > 0
      ? input.query.trim().slice(0, MAX_QUERY_CHARS)
      : null;
    // LIKE-escaped so a model's `%` is a literal percent and not a wildcard that
    // matches every conversation.
    const pattern = trimmed ? `%${trimmed.replace(/[%_\\]/g, '\\$&')}%` : null;
    const rawLower = trimmed ? trimmed.toLowerCase() : null;
    // The executing turn, so a search does not return the question that asked it.
    const exclude = ctx.turnId ?? null;

    const keyword = await withTenantContext(ctx.tenantId, (client) => client.query(
      KEYWORD_SQL,
      [ctx.tenantId, ctx.accountId, limit, rawLower, exclude, pattern],
    ).then((r) => r.rows as HitRow[]));

    let rows = keyword;
    let retrieval: 'keyword' | 'semantic+keyword' = 'keyword';

    if (trimmed && keyword.length < limit) {
      const space = await requestEmbedding(ctx.tenantId, trimmed, 'retrieval_query', 'caio_recall_query');
      if (space) {
        const semantic = await withTenantContext(ctx.tenantId, (client) => client.query(
          SEMANTIC_SQL,
          [
            ctx.tenantId, ctx.accountId, limit, rawLower, exclude,
            `[${space.vector.join(',')}]`, space.provider, space.model,
          ],
        ).then((r) => r.rows as HitRow[]));
        const seen = new Set(keyword.map((r) => r.turn_id));
        rows = [...keyword, ...semantic.filter((r) => !seen.has(r.turn_id))].slice(0, limit);
        retrieval = 'semantic+keyword';
      }
      // A null space keeps the keyword rows: a search that found something is
      // worth more than an error about the arm that could not run.
    }

    log.info(
      {
        event: 'caio_recall_conversations',
        tenantId: ctx.tenantId,
        mode: trimmed ? 'search' : 'recent',
        retrieval,
        matchCount: rows.length,
      },
      'CAIO conversation recall executed',
    );

    return {
      // The thread id is what conversation__read takes, so a model that has found
      // the right conversation can read it whole without asking again.
      conversations: rows.map((r) => ({
        threadId: r.thread_id,
        title: r.title?.trim() || 'Untitled conversation',
        at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        excerpts: (r.messages ?? []).map((m) => ({
          speaker: m.role === 'user' ? 'person' : 'you',
          text: m.preview,
        })),
      })),
      excerptsOnly: true,
      readWhole: 'conversation__read',
    };
  },
};
