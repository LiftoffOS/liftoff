// Agent Capability Embedding Service
//
// Generates and stores an embedding vector for an agent's capability
// description. Used by find_teammates for semantic search. Uses
// @liftoffos/embedding for multi-provider + proper cost instrumentation.
//
// Fire-and-forget: callers should not await this; embedding failures log an
// error but never surface to the user. The ILIKE fallback in find_teammates
// (mcp-server/service.ts:80, 100) handles agents with null embeddings until
// the next successful embed.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { embeddingClient } from '@liftoffos/embedding';
import { readActiveSkills } from './row-mapper';

// Pinned to match internal_agents.capability_embedding_v2 vector(768) after
// migration 237. All three providers can produce 768d via Matryoshka.
const STORAGE_DIMENSIONS = 768;

interface AgentEmbeddingSource {
  id: string;
  tenantId: string;
  role: string;
  responsibilities: string | null;
  summary: string | null;
  skills: unknown;
}

/**
 * What a team member can do, as text.
 *
 * The capability half of this used to read a `capabilities` column that has
 * never existed on `internal_agents`, so the SELECT threw on every call and no
 * embedding was ever stored — `find_teammates` has been on its ILIKE fallback
 * for the whole life of the feature. The skills column is the authoritative
 * answer to the same question (ADR-043), and carries a description per skill
 * rather than a bare label, so semantic search now has real signal to match on.
 */
export function buildEmbeddingText(agent: AgentEmbeddingSource): string {
  const skillsText = readActiveSkills(agent.skills)
    .map((s) => [s.name, s.description].filter(Boolean).join(': '))
    .join('\n');
  return [agent.role, agent.responsibilities, agent.summary, skillsText]
    .filter(Boolean).join('\n').trim();
}

/** Exported so the schema-contract integration test can check every name in it
 *  against the live `internal_agents` table. */
export const AGENT_EMBEDDING_COLUMNS = 'id, tenant_id, role, responsibilities, summary, skills';

export async function generateAndStoreEmbedding(agentId: string, tenantId: string): Promise<void> {
  const result = await withTenantScope(tenantId, (client) => client.query<AgentEmbeddingSource>(
    `SELECT ${AGENT_EMBEDDING_COLUMNS}
     FROM internal_agents
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [agentId, tenantId],
  ));
  if (result.rows.length === 0) return;
  const text = buildEmbeddingText(result.rows[0]);
  if (!text) return;

  let response;
  try {
    response = await embeddingClient.embed({
      input: text,
      dimensions: STORAGE_DIMENSIONS,
      taskType: 'retrieval_document',
      context: { tenantId, agentId, purpose: 'capability_embedding' },
    });
  } catch (err) {
    // embeddingClient already wrote a failure row to llm_usage_log via the
    // onUsage callback. Local log is for operator visibility.
    log.error({ agentId, err: (err as Error).message }, 'capability embedding failed');
    return;
  }

  await withTenantScope(tenantId, (client) => client.query(
    `UPDATE internal_agents
        SET capability_embedding_v2 = $1
      WHERE id = $2 AND tenant_id = $3`,
    [`[${response.embeddings[0].join(',')}]`, agentId, tenantId],
  ));
  log.info({ agentId, tenantId, tokens: response.promptTokens }, 'capability embedding stored');
}

/** Used by mcp-server find_teammates. Caller passes agent attribution. */
export async function getQueryEmbedding(
  query: string,
  attribution: {
    tenantId: string;
    agentId?: string;
    threadId?: string;
    invocationId?: string;
  },
): Promise<number[] | null> {
  try {
    const response = await embeddingClient.embed({
      input: query,
      dimensions: STORAGE_DIMENSIONS,
      taskType: 'retrieval_query',
      context: {
        ...Object.fromEntries(
          Object.entries(attribution).filter(([, v]) => v !== undefined),
        ) as Record<string, string>,
        purpose: 'capability_embedding_query',
      },
    });
    return response.embeddings[0];
  } catch {
    // Already logged via onUsage; caller falls back to ILIKE per the existing
    // mcp-server/service.ts logic at lines 80, 100.
    return null;
  }
}
