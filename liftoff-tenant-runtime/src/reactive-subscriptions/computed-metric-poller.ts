// Computed-metric fallback poller.
//
// Cloud Run Job entrypoint: ticks every 60s, reads
// reactive_subscriptions WHERE source_kind='computed_metric'
// AND next_poll_at <= NOW(), invokes the registered connector function
// via Connect-RPC, extracts a numeric value, evaluates filter, fires the
// agent on match.

import { reactiveSubscriptionRepo, type SubscriptionRow } from './repository';
import { getConnectorServiceClient, type ExecuteRequest } from '../connectors/connector-service-client';
import { fireAgentForSubscription } from './fire';
import { escalateInvariantViolation } from './invariant';
import { evaluate } from './predicate-evaluator';
import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

export async function runComputedMetricPollingCycle(): Promise<{
  checked: number;
  matched: number;
  errored: number;
  escalated: number;
}> {
  let checked = 0, matched = 0, errored = 0, escalated = 0;
  const due = await reactiveSubscriptionRepo.listDueComputedMetric();
  const client = getConnectorServiceClient();
  for (const sub of due) {
    checked++;
    try {
      const source = sub.source as Extract<SubscriptionRow['source'], { kind: 'computed_metric' }>;
      const connectorId = await resolveConnectorId(sub.tenantId, sub.agentId, source.connectorRef);
      // ExecuteRequest uses google.protobuf.Struct `input` (not inputJson) and
      // ExecuteResponse returns `result` (not outputJson). Verified against
      // liftoff/connector/v1/connector_service.proto.
      const req = {
        tenantContext: { tenantId: sub.tenantId },
        connectorId,
        functionName: source.fn,
        input: source.args ?? {},
      } as unknown as ExecuteRequest;
      const resp = await client.execute(req);
      const result = (resp as unknown as { result: Record<string, unknown> }).result;
      const value = extractNumeric(result, source.extractPath);

      const evt = { data: { value } };
      const predicateHolds = !sub.filter || evaluate(sub.filter, evt);

      if (source.mode === 'invariant') {
        // INVARIANT semantics (the inversion). `filter` asserts a condition
        // that should ALWAYS hold; `predicateHolds` therefore means SATISFIED.
        // The interesting event is the predicate going FALSE. Edge-trigger on
        // satisfied→violated so a persistently-broken invariant escalates once,
        // then re-arms when it returns to satisfied. NULL last_filter_passed is
        // treated as SATISFIED (the inverse of the opportunity default) so a
        // first-check violation still escalates.
        const satisfied = predicateHolds;
        const priorSatisfied = sub.lastFilterPassed ?? true;
        const isViolationEdge = !satisfied && priorSatisfied;
        let escalationId: string | null = null;
        if (isViolationEdge) {
          escalationId = await escalateInvariantViolation(sub, value);
          escalated++;
        }
        // Append EVERY check (satisfied and violated) so the ledger is a full
        // history of when the invariant held and when it broke.
        await reactiveSubscriptionRepo.appendGoalLedger({
          subscriptionId: sub.id,
          tenantId: sub.tenantId,
          agentId: sub.agentId,
          value,
          status: satisfied ? 'satisfied' : 'violated',
          escalated: isViolationEdge,
          escalationId,
        });
        // Re-use last_filter_passed as the prior-satisfied edge state.
        await reactiveSubscriptionRepo.markPolled(sub.id, value, satisfied);
      } else {
        // OPPORTUNITY semantics (default): fire only when the filter crosses
        // false -> true, not on every poll while it holds true.
        // last_filter_passed NULL/false means the prior poll did not match, so a
        // current match is a fresh crossing. When the filter goes back to false
        // the subscription re-arms (markPolled records the new state below), so
        // the next crossing fires again.
        const isEdge = predicateHolds && !sub.lastFilterPassed;
        if (isEdge) {
          await fireAgentForSubscription(sub, evt, `metric:${sub.id}`);
          matched++;
        }
        await reactiveSubscriptionRepo.markPolled(sub.id, value, predicateHolds);
      }
    } catch (err) {
      errored++;
      await reactiveSubscriptionRepo.markError(sub.id, (err as Error).message);
    }
  }
  logger.info('Computed-metric polling cycle', { checked, matched, errored, escalated });
  return { checked, matched, errored, escalated };
}

function extractNumeric(result: unknown, path?: string): number {
  if (path) {
    const v = path.split('.').reduce<unknown>((cur, p) => (cur == null ? cur : (cur as Record<string, unknown>)[p]), result);
    return Number(v);
  }
  if (typeof result === 'number') return result;
  if (typeof result === 'object' && result && 'value' in (result as Record<string, unknown>)) {
    return Number((result as { value: unknown }).value);
  }
  throw new Error('Could not extract numeric value from computed_metric result');
}

// `connectorRef` is the connector TYPE (subscription-router sets it from
// env.connectorType || env.connectorRef). Resolve it to the concrete
// connectors.id UUID that connector-service.execute expects — mirroring the
// tool-gateway dispatch contract where the id passed to .execute is the
// current connectors-table row id. `status = 'active'` is the usable value
// (see ConnectorRepository.listConnectorHealthByTenant / mapHealthStatus).
// Prefer the agent's own connector, falling back to a tenant-shared one
// (agent_id IS NULL) per migration 120's optional agent scoping.
export async function resolveConnectorId(tenantId: string, agentId: string, connectorRef: string): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM connectors
     WHERE tenant_id = $1 AND type = $3 AND status = 'active'
       AND (agent_id = $2 OR agent_id IS NULL)
     ORDER BY (agent_id = $2) DESC, created_at
     LIMIT 1`,
    [tenantId, agentId, connectorRef],
  );
  if (!rows[0]) throw new Error(`connectorRef '${connectorRef}' not found in connectors for tenant ${tenantId}`);
  return rows[0].id;
}
