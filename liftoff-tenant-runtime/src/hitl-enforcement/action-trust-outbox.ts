// Durable outbox that delivers approval-resolution trust decisions to the governance engine.
// A row is enqueued in the same transaction as the approval-status UPDATE, then drained on a
// poll loop and delivered with postActionTrustDecisions. The governance side dedupes on
// source_key, so redelivery is safe.
//
// The table is FORCE-RLS (migration 311), so the drain runs inside withTenantScope once per
// tenant this runtime serves. Scoping it to a single tenant does not just delay the others:
// nothing else claims those rows, so their trust decisions never reach governance at all.

import type { PoolClient } from 'pg';
import { withTenantScope } from '../infrastructure/database';
import { forEachTenant } from '../infrastructure/tenant-registry';
import { log } from '../infrastructure/logging';
import { postActionTrustDecisions } from '../governance/governance-service-client';

const REAPER_THRESHOLD_MIN = 5;

export interface TrustDecisionsPayload {
  tenantId: string;
  agentId: string;
  gateReason: string;
  approvalId: string;
  decisions: Array<{
    actionClass: string;
    decision: 'approved' | 'rejected';
    decidedBy: string;
    decidedAt: string;
    sourceKey: string;
  }>;
}

/** Enqueue inside the caller's transaction (same client as the approval UPDATE). */
export async function enqueueActionTrustOutbox(
  client: PoolClient,
  input: { tenantId: string; approvalId: string; payload: TrustDecisionsPayload },
): Promise<void> {
  await client.query(
    `INSERT INTO action_trust_outbox (tenant_id, approval_id, payload)
     VALUES ($1, $2, $3::jsonb)`,
    [input.tenantId, input.approvalId, JSON.stringify(input.payload)],
  );
}

interface OutboxRow {
  id: string;
  payload: TrustDecisionsPayload;
  attempts: number;
  max_attempts: number;
}

export async function runActionTrustOutboxOnce(): Promise<void> {
  // One drain per tenant. The table is FORCE-RLS, so a drain scoped to a single
  // tenant cannot see any other tenant's rows — and those rows are not merely
  // delayed, they are never claimed by anything, so their approval-resolution
  // trust decisions never reach the governance engine at all.
  await forEachTenant('action-trust-outbox', async (tenantId) => {
    // Per-operation transactions (mirrors internal_agent_outbox + the PB sibling): the claim COMMITS
    // before the POST, the POST runs OUTSIDE any transaction, and the mark is its own transaction —
    // never a DB transaction held open across network I/O.
    await reapStuck(tenantId);
    let drained = 0;
    for (let i = 0; i < 25; i++) {
      const row = await claimOne(tenantId);
      if (!row) break;
      await processRow(tenantId, row);
      drained++;
    }
    return { drained };
  });
}

async function reapStuck(tenantId: string): Promise<void> {
  await withTenantScope(tenantId, (client: PoolClient) => client.query(
    `UPDATE action_trust_outbox SET status='pending', updated_at=NOW()
     WHERE status='in_progress' AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')`,
    [REAPER_THRESHOLD_MIN],
  ));
}

async function claimOne(tenantId: string): Promise<OutboxRow | null> {
  return withTenantScope(tenantId, async (client: PoolClient) => {
    const r = await client.query<OutboxRow>(
      `UPDATE action_trust_outbox SET status='in_progress', updated_at=NOW()
       WHERE id = (
         SELECT id FROM action_trust_outbox
         WHERE status='pending' AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING id, payload, attempts, max_attempts`,
    );
    return r.rows[0] ?? null;
  });
}

async function processRow(tenantId: string, row: OutboxRow): Promise<void> {
  try {
    await postActionTrustDecisions(row.payload);
    await withTenantScope(tenantId, (client: PoolClient) => client.query(
      `UPDATE action_trust_outbox SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [row.id],
    ));
  } catch (err) {
    await markRetry(tenantId, row.id, row.attempts + 1, row.max_attempts, (err as Error).message);
  }
}

async function markRetry(tenantId: string, id: string, attempts: number, maxAttempts: number, error: string): Promise<void> {
  const backoffMin = Math.min(10, 2 ** attempts);
  const terminal = attempts >= maxAttempts;
  if (terminal) {
    log.error({ outboxId: id, attempts, error }, 'action-trust outbox row failed permanently (ops alert)');
  }
  await withTenantScope(tenantId, (client: PoolClient) => client.query(
    terminal
      ? `UPDATE action_trust_outbox SET status='failed', attempts=$2, last_error=$3, updated_at=NOW() WHERE id=$1`
      : `UPDATE action_trust_outbox SET status='pending', attempts=$2, last_error=$3,
           next_attempt_at = NOW() + ($4::int * INTERVAL '1 minute'), updated_at=NOW() WHERE id=$1`,
    terminal ? [id, attempts, error] : [id, attempts, error, backoffMin],
  ));
}

let drainerHandle: ReturnType<typeof setInterval> | null = null;

/** 30s poll loop. Idempotent — calling twice does nothing. */
export function startActionTrustOutboxDrainer(): void {
  if (drainerHandle) return;
  drainerHandle = setInterval(() => {
    runActionTrustOutboxOnce().catch((err) =>
      log.error({ err: (err as Error).message }, 'action-trust-outbox drainer tick failed'),
    );
  }, 30_000);
  drainerHandle.unref?.();
  log.info('action-trust-outbox drainer started (30s tick)');
}

export function stopActionTrustOutboxDrainer(): void {
  if (drainerHandle) {
    clearInterval(drainerHandle);
    drainerHandle = null;
  }
}
