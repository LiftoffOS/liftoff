// Loads historical retrieval events (with non-null cited_ids) from
// memory_retrieval_events for replay. Filters out rows from before
// migration 261 (query_text is NULL).

import { pool } from '../../infrastructure/database';

export interface EvalEvent {
  tenantId: string;
  invocationId: string;
  agentId: string | null;
  threadId: string | null;
  query: string;
  retrievedIds: string[];
  citedIds: string[];
  createdAt: Date;
}

export interface LoadOptions {
  since: Date;
  until: Date;
  /** Minimum length of cited_ids — events with fewer cites are dropped. */
  minCited: number;
  /** Restrict to these tenants if provided. */
  tenantIds?: string[];
  /** Cap the result set. */
  limit?: number;
}

export async function loadEvents(opts: LoadOptions): Promise<EvalEvent[]> {
  const r = await pool.query<{
    tenant_id: string;
    agent_id: string | null;
    invocation_id: string;
    thread_id: string | null;
    query_text: string;
    retrieved_ids: string[];
    cited_ids: string[];
    created_at: Date;
  }>(`
    SELECT tenant_id, agent_id, invocation_id, thread_id, query_text,
           retrieved_ids, cited_ids, created_at
    FROM memory_retrieval_events
    WHERE created_at >= $1 AND created_at < $2
      AND query_text IS NOT NULL
      AND array_length(cited_ids, 1) >= $3
      AND ($4::uuid[] IS NULL OR tenant_id = ANY($4))
    ORDER BY created_at ASC
    LIMIT COALESCE($5::int, 100000)
  `, [
    opts.since,
    opts.until,
    opts.minCited,
    opts.tenantIds ?? null,
    opts.limit ?? null,
  ]);

  return r.rows.map(row => ({
    tenantId: row.tenant_id,
    invocationId: row.invocation_id,
    agentId: row.agent_id,
    threadId: row.thread_id,
    query: row.query_text,
    retrievedIds: row.retrieved_ids,
    citedIds: row.cited_ids,
    createdAt: row.created_at,
  }));
}
