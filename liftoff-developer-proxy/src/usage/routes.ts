// Usage Ingestion Feed — internal service endpoint.
//
//   GET /api/usage/ingestion-feed?after_id=<n>&limit=<n>
//
// Consumed by platform-backend's cost-attribution ingester. Cursors on the
// monotonic developer_proxy_usage_log.id (assigned at insert = stream
// completion), so a long-running request whose row lands after the cursor
// last advanced is never skipped.
//
// Served set = the terminal states the vendor actually bills for output the
// model generated: `completed` (normal), `incomplete` (hit the token cap, e.g.
// OpenAI max_output_tokens — full usage captured), and the client/timeout
// aborts `aborted_by_client` / `timed_out` (the vendor bills tokens generated
// before teardown; we charge whatever streamed through — accurate input, best-
// effort partial output, and a $0 no-op when nothing was captured). Genuine
// non-billed failures (`failed` provider 4xx/5xx and rejections, `transport_error`)
// are excluded — the vendor did not bill them. Charging is by row id, so this is
// forward-only: pre-existing rows behind the ingester cursor are never back-charged.
//
// Auth: X-Service-Token header validated against
// DEVELOPER_PROXY_SERVICE_TOKEN_SECRET. In Cloud Run, IAM audience
// restrictions provide a second layer of defence.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../infrastructure/database.js';
import { resolveServiceToken } from '../infrastructure/service-token.js';
import { drainOutboxes } from '../outbox/worker.js';

interface UsageLogRow {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  invocation_id: string | null;
  action_id: string | null;
  attempt_id: string | null;
  vendor: string;
  model: string;
  operation: string | null;
  input_tokens: string;
  output_tokens: string;
  cost_micros: string;
  started_at: Date;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

async function handleIngestionFeed(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.headers['x-service-token'];
  if (!token || typeof token !== 'string') {
    return reply.code(401).send({ error: 'x-service-token header required' });
  }
  let expectedToken: string;
  try {
    expectedToken = await resolveServiceToken();
  } catch (err) {
    request.log.error({ err }, 'Failed to resolve service token');
    return reply.code(500).send({ error: 'Internal auth error' });
  }
  if (token !== expectedToken) {
    return reply.code(401).send({ error: 'Invalid service token' });
  }

  // The feed poll is also when the outbox is delivered (outbox/worker.ts):
  // developer-proxy runs on request-based CPU and has no loop of its own. A
  // delivery failure is retried on the next poll and never fails the feed.
  try {
    await drainOutboxes();
  } catch (err) {
    request.log.warn({ err }, 'Outbox drain failed; retried on the next poll');
  }

  const query = request.query as { after_id?: string; limit?: string };
  const afterId = query.after_id !== undefined ? parseInt(query.after_id, 10) : 0;
  if (isNaN(afterId) || afterId < 0) {
    return reply.code(400).send({ error: '`after_id` must be a non-negative integer' });
  }
  const rawLimit = query.limit !== undefined ? parseInt(query.limit, 10) : DEFAULT_LIMIT;
  if (isNaN(rawLimit) || rawLimit < 1) {
    return reply.code(400).send({ error: '`limit` must be a positive integer' });
  }
  const limit = Math.min(rawLimit, MAX_LIMIT);

  const pool = await getPool();
  const result = await pool.query<UsageLogRow>(
    `SELECT id::text, tenant_id::text, agent_id, invocation_id, action_id, attempt_id::text,
            vendor, model, operation,
            input_tokens::text, output_tokens::text, cost_micros::text, started_at
       FROM developer_proxy_usage_log
      WHERE id > $1
        AND lifecycle_status IN ('completed', 'incomplete', 'aborted_by_client', 'timed_out')
      ORDER BY id ASC
      LIMIT $2`,
    [afterId, limit + 1],
  );

  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  const lastRow = rows[rows.length - 1];
  const nextAfterId = lastRow ? Number(lastRow.id) : afterId;

  return reply.send({
    rows: rows.map((row) => ({
      id:           row.id,
      tenantId:     row.tenant_id,
      agentId:      row.agent_id ?? null,
      invocationId: row.invocation_id ?? null,
      actionId:     row.action_id ?? null,
      attemptId:    row.attempt_id ?? null,
      vendor:       row.vendor,
      model:        row.model,
      operation:    row.operation ?? null,
      inputTokens:  Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      costMicros:   Number(row.cost_micros),
      startedAt:    row.started_at.toISOString(),
    })),
    hasMore,
    nextAfterId,
  });
}

export async function registerUsageRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (sub: FastifyInstance) => {
    sub.get('/api/usage/ingestion-feed', handleIngestionFeed);
  });
}
