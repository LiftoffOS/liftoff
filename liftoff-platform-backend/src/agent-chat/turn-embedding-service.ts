// Turn-content embedding for semantic conversation recall (v2).
//
// Delivery model: the inline chat-service call is BEST-EFFORT ONLY (PB runs
// request-based CPU throttling, so work left running after a response may
// never finish). The DURABLE path is the recurring sweeper.
// Correctness never depends on either: un-embedded turns stay reachable
// through the keyword arm of the merge.
//
// Incomplete turns (user message, no assistant reply — failed or
// HITL-paused) ARE embedded by the sweeper and ARE semantically
// recallable. This is deliberate: v1 already recalls them (the search
// EXISTS at platform-tools-router.ts:717 matches user content, and recent
// mode has no shape requirement), so v2 keeps retrieval semantics
// identical across arms. The inline call only fires at assistant-append,
// so complete turns get vectors soonest.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { embeddingClient } from '@liftoffos/embedding';

// Pinned to agent_chat_turns.content_embedding vector(768) (migration 295), and
// to the same column on the platform assistants' turns tables (547). Shared with
// chat-recall/turn-embedding so the dimension is stated once: a vector written at
// another width is not comparable with the ones already stored.
export const STORAGE_DIMENSIONS = 768;
// Repo-wide embed input budget (src/knowledge/embedding-service.ts:17).
const EMBED_CHAR_BUDGET = 4000;

export type EmbedTurnOutcome =
  | 'embedded'
  | 'skipped_guest'    // sender NULL — never embedded, by design
  | 'skipped_empty'    // zero user/assistant content characters (rare)
  | 'missing'          // turn row not found
  | 'failed';          // provider error or lost UPDATE race

/** Exported for tests. */
export function buildTurnEmbeddingText(
  rows: Array<{ role: string; content: string }>,
): string {
  return rows.map((r) => r.content).join('\n').slice(0, EMBED_CHAR_BUDGET).trim();
}

export async function embedTurn(
  tenantId: string,
  turnId: string,
): Promise<EmbedTurnOutcome> {
  const loaded = await withTenantScope(tenantId, async (client) => {
    const turn = await client.query(
      `SELECT sender_account_id, agent_id FROM agent_chat_turns
        WHERE id = $1 AND tenant_id = $2`,
      [turnId, tenantId],
    );
    const messages = await client.query(
      `SELECT role, content FROM agent_chat_messages
        WHERE turn_id = $1 AND tenant_id = $2
          AND role IN ('user','assistant')
        ORDER BY created_at ASC`,
      [turnId, tenantId],
    );
    return { turn: turn.rows[0], messages: messages.rows };
  });

  if (!loaded.turn) return 'missing';
  if (loaded.turn.sender_account_id === null) return 'skipped_guest';
  const text = buildTurnEmbeddingText(loaded.messages);
  if (!text) return 'skipped_empty';

  let response;
  try {
    response = await embeddingClient.embed({
      input: text,
      dimensions: STORAGE_DIMENSIONS,
      taskType: 'retrieval_document',
      // Background path: default (generous) transport timeout + retries.
      // itemId = turnId attributes the (platform-overhead) embed cost to the
      // exact turn in cost_attribution_events, matching the knowledge worker's
      // per-item attribution (knowledge/embedding-service.ts embedItem).
      context: {
        tenantId,
        agentId: loaded.turn.agent_id,
        purpose: 'conversation_recall',
        itemId: turnId,
      },
    });
  } catch (err) {
    log.error({ tenantId, turnId, err: (err as Error).message }, 'turn embedding failed');
    return 'failed';
  }

  const updated = await withTenantScope(tenantId, (client) => client.query(
    `UPDATE agent_chat_turns
        SET content_embedding = $1,
            content_embedding_provider = $2,
            content_embedding_model = $3
      WHERE id = $4 AND tenant_id = $5`,
    [
      `[${response.embeddings[0].join(',')}]`,
      response.provider,
      response.model,
      turnId,
      tenantId,
    ],
  ));
  if (updated.rowCount !== 1) {
    log.warn({ tenantId, turnId }, 'turn embedding update affected 0 rows');
    return 'failed';
  }
  return 'embedded';
}

export interface RecallQueryEmbedding {
  vector: number[];
  provider: string;
  model: string;
}

/** Query-side embed with a TRUE deadline: timeoutMs/retries ride the
 *  packages/embedding transport options, so a slow call is aborted at the
 *  transport (AbortController) — no orphan request, no discarded-but-billed
 *  success, and the failure usage row is emitted before we return. Deadline
 *  is an operational latency bound (HTTP-timeout class): default 2500ms ≈
 *  one healthy provider round trip, negligible vs the 5-minute turn budget.
 *  Env-overridable: RECALL_QUERY_EMBED_DEADLINE_MS. */
export async function getRecallQueryEmbedding(
  query: string,
  /** Who the search is charged to. `agentId` names the responding agent on
   *  team chat; the platform assistants have no internal_agents row, so they
   *  pass a `purpose` instead and it is the only thing that tells them apart
   *  (insights/platform-assistants.ts). One of the two is always present. */
  attribution:
    | { tenantId: string; agentId: string; purpose?: string }
    | { tenantId: string; agentId?: undefined; purpose: string },
): Promise<RecallQueryEmbedding | null> {
  // Bounded positive int. `parseInt(...) || 2500` accepted negatives
  // ("-500" → -500, truthy → a negative transport timeout that aborts
  // instantly); clamp to (0, 30_000] (the transport default ceiling), else
  // the 2500 default.
  const parsedDeadline = Number.parseInt(process.env.RECALL_QUERY_EMBED_DEADLINE_MS ?? '', 10);
  const deadlineMs = Number.isFinite(parsedDeadline) && parsedDeadline > 0 && parsedDeadline <= 30_000
    ? parsedDeadline
    : 2500;
  try {
    const response = await embeddingClient.embed({
      input: query,
      dimensions: STORAGE_DIMENSIONS,
      taskType: 'retrieval_query',
      timeoutMs: deadlineMs,
      retries: 0,
      // Built key by key rather than spread: the context is Record<string,
      // string>, so an absent agentId has to be an ABSENT KEY and not a key
      // holding undefined. A caller that named its own purpose keeps it, which
      // is what puts the spend on the right assistant's line.
      context: {
        tenantId: attribution.tenantId,
        ...(attribution.agentId ? { agentId: attribution.agentId } : {}),
        purpose: attribution.purpose ?? 'conversation_recall_query',
      },
    });
    return {
      vector: response.embeddings[0],
      provider: response.provider,
      model: response.model,
    };
  } catch {
    return null;
  }
}
