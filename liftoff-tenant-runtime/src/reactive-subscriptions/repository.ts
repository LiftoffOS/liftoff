// Reactive_subscriptions CRUD + helpers.
//
// Writes fire pg_notify('reactive_subscriptions_changed', '<tenantId>:<agentId>')
// via the trigger declared in migration 222 — the subscription-router listens
// on that channel and invalidates its in-memory cache for the affected tenant.

import { getPool } from '../infrastructure/database';
import type { ReactiveSubscription } from '../agent-lifecycle/types';
import { armNextComputedMetricPoll } from './poll-schedule';

export interface SubscriptionRow extends ReactiveSubscription {
  id: string;
  tenantId: string;
  agentId: string;
  status: 'active' | 'paused' | 'errored';
  lastMatchedAt: Date | null;
  consecutiveErrors: number;
  nextPollAt: Date | null;
  pollIntervalSeconds: number | null;
  // Edge-trigger state for computed_metric: the filter result on the prior
  // poll. The poller fires only on a false->true transition. NULL = never
  // evaluated (treated as false, so the first crossing fires).
  lastFilterPassed: boolean | null;
  // Self-wake one-shot binding: when true, a match RESUMES the bound wake row via the
  // outbox rather than starting a fresh run.
  oneShot: boolean;
  boundScheduledInvocationId: string | null;
}

export const reactiveSubscriptionRepo = {
  async upsertForAgent(tenantId: string, agentId: string, specs: ReactiveSubscription[]): Promise<void> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const s of specs) {
        const isComputedMetric = s.source.kind === 'computed_metric';
        // Strip the discriminator before storing — source_kind column is the
        // discriminator; source_spec carries the remaining fields.
        const sourceSpecObj: Record<string, unknown> = { ...s.source };
        delete (sourceSpecObj as { kind?: unknown }).kind;
        await client.query(
          `INSERT INTO reactive_subscriptions
             (tenant_id, agent_id, label, source_kind, source_spec, filter_expr, window_spec,
              cooldown_seconds, objective, status, next_poll_at, poll_interval_seconds)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active', $10, $11)
           ON CONFLICT (tenant_id, agent_id, label) DO UPDATE SET
             source_kind = EXCLUDED.source_kind,
             source_spec = EXCLUDED.source_spec,
             filter_expr = EXCLUDED.filter_expr,
             window_spec = EXCLUDED.window_spec,
             cooldown_seconds = EXCLUDED.cooldown_seconds,
             objective = EXCLUDED.objective,
             updated_at = NOW()`,
          [
            tenantId, agentId, s.label, s.source.kind,
            JSON.stringify(sourceSpecObj),
            s.filter ? JSON.stringify(s.filter) : null,
            s.window ? JSON.stringify(s.window) : null,
            s.cooldownSeconds ?? 60, s.objective,
            isComputedMetric ? new Date() : null,
            isComputedMetric ? (s.source as { pollIntervalSeconds: number }).pollIntervalSeconds : null,
          ]
        );
      }
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
    // A new computed metric is due now; arm its first poll (see poll-schedule.ts).
    if (specs.some((s) => s.source.kind === 'computed_metric')) {
      void armNextComputedMetricPoll(30_000);
    }
  },

  async deleteNotIn(tenantId: string, agentId: string, keepLabels: string[]): Promise<void> {
    const pool = getPool();
    await pool.query(
      `DELETE FROM reactive_subscriptions
       WHERE tenant_id=$1 AND agent_id=$2 AND label <> ALL($3::text[])`,
      [tenantId, agentId, keepLabels]
    );
  },

  async setAgentStatus(tenantId: string, agentId: string, status: 'active' | 'paused'): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE reactive_subscriptions SET status=$3, updated_at=NOW(),
         next_poll_at = CASE WHEN $3='active' AND source_kind='computed_metric' THEN NOW() ELSE next_poll_at END
       WHERE tenant_id=$1 AND agent_id=$2 AND status <> $3`,
      [tenantId, agentId, status]
    );
    // Reactivation makes its computed metrics due now.
    if (status === 'active') void armNextComputedMetricPoll(30_000);
  },

  async deleteAgent(tenantId: string, agentId: string): Promise<void> {
    const pool = getPool();
    await pool.query(`DELETE FROM reactive_subscriptions WHERE tenant_id=$1 AND agent_id=$2`, [tenantId, agentId]);
  },

  async listForConnectorEvent(tenantId: string, connectorRef: string, entityType: string): Promise<SubscriptionRow[]> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM reactive_subscriptions
       WHERE tenant_id=$1 AND status='active' AND source_kind='connector_event'
         AND consumed_at IS NULL
         AND source_spec->>'connectorRef'=$2
         AND (source_spec->>'entityType' IS NULL OR source_spec->>'entityType'=$3)`,
      [tenantId, connectorRef, entityType]
    );
    return rows.map(rowToSubscription);
  },

  /** Insert a one-shot event subscription bound to a wake ASI row.
   *  Unique label __wake__<id>; a match stages a wake_event_delivery row rather than a fresh run. */
  async insertOneShotEventWake(input: {
    tenantId: string; agentId: string; boundScheduledInvocationId: string;
    source: { kind: 'connector_event' | 'system_event'; connectorRef?: string; entityType?: string; topic?: string };
    filter: unknown; objective?: string;
  }): Promise<string> {
    const pool = getPool();
    const sourceSpecObj: Record<string, unknown> = { ...input.source };
    delete (sourceSpecObj as { kind?: unknown }).kind;
    const label = `__wake__${input.boundScheduledInvocationId}`;
    const { rows } = await pool.query(
      `INSERT INTO reactive_subscriptions
         (tenant_id, agent_id, label, source_kind, source_spec, filter_expr, cooldown_seconds,
          objective, status, one_shot, bound_scheduled_invocation_id)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,'active',true,$8)
       ON CONFLICT (tenant_id, agent_id, label) DO UPDATE SET
         source_kind=EXCLUDED.source_kind, source_spec=EXCLUDED.source_spec, filter_expr=EXCLUDED.filter_expr,
         bound_scheduled_invocation_id=EXCLUDED.bound_scheduled_invocation_id, consumed_at=NULL,
         status='active', updated_at=NOW()
       RETURNING id`,
      [input.tenantId, input.agentId, label, input.source.kind, JSON.stringify(sourceSpecObj),
       input.filter ? JSON.stringify(input.filter) : null, input.objective ?? 'self_wake_event',
       input.boundScheduledInvocationId],
    );
    return rows[0].id as string;
  },

  /** Consume a one-shot subscription AFTER the outbox drain has durably enqueued its resume. */
  async markSubscriptionConsumed(id: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE reactive_subscriptions SET consumed_at=NOW(), status='paused', updated_at=NOW()
       WHERE id=$1 AND consumed_at IS NULL`, [id]);
  },

  /** Consume the one-shot subscription bound to a given wake ASI row (used by the drain worker). */
  async markConsumedByBoundInvocation(scheduledInvocationId: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE reactive_subscriptions SET consumed_at=NOW(), status='paused', updated_at=NOW()
       WHERE one_shot=true AND bound_scheduled_invocation_id=$1 AND consumed_at IS NULL`,
      [scheduledInvocationId]);
  },

  /** Cancel (delete) the one-shot subscription bound to a wake ASI row (cancel/cleanup path). */
  async deleteOneShotByBoundInvocation(scheduledInvocationId: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `DELETE FROM reactive_subscriptions WHERE one_shot=true AND bound_scheduled_invocation_id=$1`,
      [scheduledInvocationId]);
  },

  async listDueComputedMetric(limit = 200): Promise<SubscriptionRow[]> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM reactive_subscriptions
       WHERE status='active' AND source_kind='computed_metric' AND next_poll_at <= NOW()
       ORDER BY next_poll_at ASC LIMIT $1`, [limit]);
    return rows.map(rowToSubscription);
  },

  async markPolled(id: string, _value: number | null, matched: boolean): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE reactive_subscriptions
       SET last_matched_at = CASE WHEN $2 THEN NOW() ELSE last_matched_at END,
           last_filter_passed = $2,
           consecutive_errors = 0,
           next_poll_at = NOW() + (poll_interval_seconds || ' seconds')::interval,
           updated_at = NOW()
       WHERE id=$1`, [id, matched]);
  },

  async markError(id: string, error: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE reactive_subscriptions
       SET last_error=$2, consecutive_errors=consecutive_errors+1,
           status = CASE WHEN consecutive_errors >= 4 THEN 'errored' ELSE status END,
           next_poll_at = CASE WHEN source_kind='computed_metric'
             THEN NOW() + (LEAST(poll_interval_seconds * (consecutive_errors+1), 3600) || ' seconds')::interval
             ELSE next_poll_at END,
           updated_at=NOW()
       WHERE id=$1`, [id, error]);
  },

  // Append one row to the invariant goal_ledger — every check, satisfied or
  // violated. `escalated`/`escalationId` are set only on the satisfied→violated
  // edge. Matches the repository's direct-pool, tenant-scoped-by-column access
  // pattern (reactive_subscriptions is not RLS-forced in this runtime).
  async appendGoalLedger(entry: {
    subscriptionId: string;
    tenantId: string;
    agentId: string;
    value: number | null;
    status: 'satisfied' | 'violated';
    escalated: boolean;
    escalationId: string | null;
  }): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO goal_ledger
         (subscription_id, tenant_id, agent_id, value, status, escalated, escalation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        entry.subscriptionId, entry.tenantId, entry.agentId,
        entry.value != null && Number.isFinite(entry.value) ? entry.value : null,
        entry.status, entry.escalated, entry.escalationId,
      ],
    );
  },
};

export function rowToSubscription(row: {
  id: string;
  tenant_id: string;
  agent_id: string;
  label: string;
  source_kind: 'connector_event' | 'system_event' | 'computed_metric';
  source_spec: Record<string, unknown>;
  filter_expr: unknown;
  window_spec: unknown;
  cooldown_seconds: number;
  objective: string;
  status: 'active' | 'paused' | 'errored';
  last_matched_at: Date | null;
  consecutive_errors: number;
  next_poll_at: Date | null;
  poll_interval_seconds: number | null;
  last_filter_passed?: boolean | null;
  one_shot?: boolean;
  bound_scheduled_invocation_id?: string | null;
}): SubscriptionRow {
  const sourceSpec = row.source_spec;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    label: row.label,
    source: { kind: row.source_kind, ...sourceSpec } as ReactiveSubscription['source'],
    filter: (row.filter_expr ?? undefined) as ReactiveSubscription['filter'],
    window: (row.window_spec ?? undefined) as ReactiveSubscription['window'],
    cooldownSeconds: row.cooldown_seconds,
    objective: row.objective,
    status: row.status,
    lastMatchedAt: row.last_matched_at,
    consecutiveErrors: row.consecutive_errors,
    nextPollAt: row.next_poll_at,
    pollIntervalSeconds: row.poll_interval_seconds,
    lastFilterPassed: row.last_filter_passed ?? null,
    oneShot: row.one_shot ?? false,
    boundScheduledInvocationId: row.bound_scheduled_invocation_id ?? null,
  };
}

// Attach to the exported singleton so the subscription-router can call
// reactiveSubscriptionRepo.rowToSubscription(...) (used by loadAllSubscriptionsIntoCache).
(reactiveSubscriptionRepo as unknown as { rowToSubscription: typeof rowToSubscription }).rowToSubscription =
  rowToSubscription;
