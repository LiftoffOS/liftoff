// Turn-content embedding for the Chief AI Officer's own threads.
//
// THE VECTOR LIVES HERE, THE EMBED CALL DOES NOT. `team_plan_turns` is in this
// service's database and nothing else can write it, but the embedding itself is
// asked of platform-backend over /api/internal/embedding — the same seam every
// CAIO model call already uses (llm/client.ts). Two reasons, both load-bearing:
//
//   Attribution. `llm_usage_log` is platform-backend's table. An embed is a
//   charged model call, and one made from a client configured here would spend
//   money that side could not see.
//
//   One embedding space. Retrieval is space-gated — a vector is comparable only
//   with vectors from the same provider AND model, which is why all three are
//   stored together. Two independently configured clients can default to two
//   different spaces, and the failure is silent: a search returns nothing.
//
// DELIVERY IS BEST-EFFORT INLINE AND DURABLE BY SWEEP. Correctness never depends
// on either path: an unembedded turn is still found by the keyword arm.
//
// A TURN WITH NO ACCOUNT IS NEVER EMBEDDED. A search is scoped to the person
// asking, so a vector nobody can be matched against is a cost with no reader.

import { log } from '../infrastructure/logging.js';
import { loadConfig } from '../infrastructure/config.js';
import { withTenantContext } from '../infrastructure/rls.js';

/** The repo-wide embed input budget, matching platform-backend's. Longer input is
 *  trimmed HERE rather than by the route, so what is stored is what was sent. */
const EMBED_CHAR_BUDGET = 4000;

/** What a sweep needs to tell apart: a row it should retry from one it should
 *  leave alone. Same taxonomy platform-backend's embedders use. */
export type EmbedTurnOutcome =
  | 'embedded'
  | 'skipped_guest'   // no resolved account — never embedded, by design
  | 'skipped_empty'   // nothing was said
  | 'missing'         // the turn row is gone
  | 'failed';         // provider error, transport failure, or a lost UPDATE race

export interface EmbeddingSpace {
  vector: number[];
  provider: string;
  model: string;
}

/** Ask platform-backend to embed text, under a purpose it recognises. Null on any
 *  failure — the caller decides what that means for it. */
export async function requestEmbedding(
  tenantId: string,
  input: string,
  taskType: 'retrieval_document' | 'retrieval_query',
  purpose: 'caio_recall_embed' | 'caio_recall_query',
  itemId?: string,
): Promise<EmbeddingSpace | null> {
  const baseUrl = loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
  const secret = loadConfig().WORKFORCE_SERVICE_TOKEN;
  try {
    const resp = await fetch(`${baseUrl}/api/internal/embedding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Auth': secret },
      body: JSON.stringify({
        tenantId,
        input: input.slice(0, EMBED_CHAR_BUDGET),
        taskType,
        purpose,
        ...(itemId ? { itemId } : {}),
      }),
    });
    if (!resp.ok) {
      log.warn({ tenantId, purpose, status: resp.status }, 'embedding request refused');
      return null;
    }
    const body = await resp.json() as { vector?: unknown; provider?: unknown; model?: unknown };
    if (!Array.isArray(body.vector) || typeof body.provider !== 'string' || typeof body.model !== 'string') {
      log.warn({ tenantId, purpose }, 'embedding response was not a vector in a named space');
      return null;
    }
    return { vector: body.vector as number[], provider: body.provider, model: body.model };
  } catch (err) {
    log.warn({ tenantId, purpose, error: (err as Error).message }, 'embedding request failed');
    return null;
  }
}

/** What the turn said, oldest first: the person's words and the reply. A row
 *  written ABOUT the conversation carries a message_type and is skipped —
 *  embedding one would make "waiting on an approval" something a search matches. */
function turnText(rows: Array<{ content: string }>): string {
  return rows.map((r) => r.content).join('\n').slice(0, EMBED_CHAR_BUDGET).trim();
}

/** Embed one turn. Never throws: every outcome is named, because a sweep's
 *  decision to retry or move on depends on which one it was. */
export async function embedTeamPlanTurn(tenantId: string, turnId: string): Promise<EmbedTurnOutcome> {
  const loaded = await withTenantContext(tenantId, async (client) => {
    const turn = await client.query(
      `SELECT account_id FROM team_plan_turns WHERE id = $1 AND tenant_id = $2`,
      [turnId, tenantId],
    );
    const messages = await client.query(
      `SELECT content FROM team_plan_messages
        WHERE turn_id = $1
          AND role IN ('user','assistant')
          AND message_type IS NULL
        ORDER BY created_at ASC`,
      [turnId],
    );
    return { turn: turn.rows[0], messages: messages.rows as Array<{ content: string }> };
  });

  if (!loaded.turn) return 'missing';
  if (loaded.turn.account_id === null) return 'skipped_guest';
  const text = turnText(loaded.messages);
  if (!text) return 'skipped_empty';

  const space = await requestEmbedding(tenantId, text, 'retrieval_document', 'caio_recall_embed', turnId);
  if (!space) return 'failed';

  const updated = await withTenantContext(tenantId, (client) => client.query(
    `UPDATE team_plan_turns
        SET content_embedding = $1,
            content_embedding_provider = $2,
            content_embedding_model = $3
      WHERE id = $4 AND tenant_id = $5`,
    [`[${space.vector.join(',')}]`, space.provider, space.model, turnId, tenantId],
  ));
  if (updated.rowCount !== 1) {
    log.warn({ tenantId, turnId }, 'team-plan turn embedding update affected 0 rows');
    return 'failed';
  }
  return 'embedded';
}
