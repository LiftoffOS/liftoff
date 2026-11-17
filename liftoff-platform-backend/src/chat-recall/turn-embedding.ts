// Turn-content embedding for the two in-process platform assistants.
//
// The team-chat embedder (agent-chat/turn-embedding-service) stays as it is: its
// attribution names a responding agent, which these surfaces have no row for.
// What IS shared is everything that must not drift — the 768 storage dimension
// pinned to the column, the input character budget, the text builder, and the
// query-side embedder whose provider and model decide which vector space a
// search is comparable in.
//
// DELIVERY IS BEST-EFFORT INLINE AND DURABLE BY SWEEP, the same split team chat
// uses: this process throttles CPU outside a request, so an inline call after
// the reply has streamed is not guaranteed to finish. Correctness never depends
// on either path — an unembedded turn stays reachable through the keyword arm.
//
// A TURN WITH NO RESOLVED SENDER IS NEVER EMBEDDED. Recall is scoped to the
// person asking, so a vector nobody can be matched against is a cost with no
// reader.

import { getPool, withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { embeddingClient } from '@liftoffos/embedding';
import {
  STORAGE_DIMENSIONS,
  buildTurnEmbeddingText,
  type EmbedTurnOutcome,
} from '../agent-chat/turn-embedding-service';
import { isConversationRow } from '../agent-chat/transcript-context';

export type { EmbedTurnOutcome };

/** The surfaces this module embeds. Team chat has its own, because its
 *  attribution names the agent that answered. */
export type EmbeddableSurface = 'liftoff' | 'insights';

/** Table names are literals here and never reach a statement from input. */
const TURNS: Record<EmbeddableSurface, string> = {
  liftoff: 'liftoff_chat_turns',
  insights: 'insights_chat_turns',
};

const MESSAGES: Record<EmbeddableSurface, string> = {
  liftoff: 'liftoff_chat_messages',
  insights: 'insights_chat_messages',
};

/** Which assistant's line the embed cost lands on. Registered in
 *  insights/platform-assistants.ts, without which the spend is unattributed —
 *  INV-PB-017: every charged dollar is on the line of whoever spent it. */
export const RECALL_EMBED_PURPOSE: Record<EmbeddableSurface, string> = {
  liftoff: 'liftoff_recall_embed',
  insights: 'insights_recall_embed',
};

/**
 * Embed one turn's speech. Never throws: every outcome is named, because the
 * sweeper's decision to retry or move on depends on which one it was.
 */
export async function embedPlatformTurn(
  surface: EmbeddableSurface,
  tenantId: string,
  turnId: string,
): Promise<EmbedTurnOutcome> {
  // The turn under tenant scope — these tables are FORCE RLS, so this read is
  // also the tenancy check.
  const turn = await withTenantScope(tenantId, (client) => client.query(
    `SELECT sender_account_id FROM ${TURNS[surface]}
      WHERE id = $1 AND tenant_id = $2`,
    [turnId, tenantId],
  ));
  if (!turn.rows[0]) return 'missing';
  if (turn.rows[0].sender_account_id === null) return 'skipped_guest';

  // The messages by turn. These tables carry no tenant_id and are not RLS
  // (they are scoped through their thread), and the turn above has already been
  // resolved under this tenant, so the unscoped pool is correct here.
  const messages = await getPool().query(
    `SELECT role, content, message_type FROM ${MESSAGES[surface]}
      WHERE turn_id = $1 AND role IN ('user','assistant')
      ORDER BY created_at ASC`,
    [turnId],
  );

  // Only what was said. A status row is written ABOUT the conversation, and
  // embedding it would make "waiting on an approval" a thing a search matches.
  const spoken = messages.rows.filter((r) => isConversationRow({ messageType: r.message_type }));
  const text = buildTurnEmbeddingText(spoken);
  if (!text) return 'skipped_empty';

  let response;
  try {
    response = await embeddingClient.embed({
      input: text,
      dimensions: STORAGE_DIMENSIONS,
      taskType: 'retrieval_document',
      // itemId = turnId attributes the embed cost to the exact turn in
      // cost_attribution_events. No agentId: these assistants have no
      // internal_agents row, and `purpose` is the only thing that tells them
      // apart (insights/platform-assistants.ts).
      context: {
        tenantId,
        purpose: RECALL_EMBED_PURPOSE[surface],
        itemId: turnId,
      },
    });
  } catch (err) {
    log.error({ tenantId, surface, turnId, err: (err as Error).message }, 'platform turn embedding failed');
    return 'failed';
  }

  const updated = await withTenantScope(tenantId, (client) => client.query(
    `UPDATE ${TURNS[surface]}
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
    log.warn({ tenantId, surface, turnId }, 'platform turn embedding update affected 0 rows');
    return 'failed';
  }
  return 'embedded';
}
