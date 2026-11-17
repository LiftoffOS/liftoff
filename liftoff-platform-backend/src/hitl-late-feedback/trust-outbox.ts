// Durable outbox that delivers late-feedback trust decisions to the governance engine.
// Mirrors the internal_agent_outbox worker (claim FOR UPDATE SKIP LOCKED, reaper, bounded
// retry with backoff), except delivery is a service-to-service POST to
// /api/governance/action-trust/decisions rather than a Pub/Sub publish. The row is enqueued
// in the same transaction as the hitl_late_feedback insert, so a decision is never lost.

import type { PoolClient } from 'pg';
import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

const REAPER_THRESHOLD_MIN = 5;

export interface EnqueueTrustOutboxInput {
  tenantId: string;
  feedbackId: string;
  payload: Record<string, unknown>;
}

/** Enqueue inside the caller's transaction (same client as the feedback insert). */
export async function enqueueLateFeedbackTrustOutbox(
  client: PoolClient,
  input: EnqueueTrustOutboxInput,
): Promise<void> {
  await client.query(
    `INSERT INTO late_feedback_trust_outbox (tenant_id, feedback_id, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (tenant_id, feedback_id) DO NOTHING`,
    [input.tenantId, input.feedbackId, JSON.stringify(input.payload)],
  );
}

interface OutboxRow {
  id: string;
  tenant_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

async function postDecisionsToGovernance(payload: Record<string, unknown>): Promise<void> {
  const base = (process.env.GOVERNANCE_SERVICE_URL ?? '').replace(/\/$/, '');
  if (!base) throw new Error('GOVERNANCE_SERVICE_URL is not set');
  const url = `${base}/api/governance/action-trust/decisions`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = process.env.GOVERNANCE_SERVICE_TOKEN;
  if (token) headers['X-Service-Auth'] = token;
  try {
    const oidc = await buildOidcAuthHeader(new URL(url).origin);
    for (const [k, v] of Object.entries(oidc)) headers[k] = v;
  } catch {
    // Local/test without a metadata server: X-Service-Auth still gates governance.
  }
  // Bounded like the tenant-runtime governance client — a hung endpoint must not stall the drain.
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`governance POST failed: ${res.status} ${body}`.slice(0, 500));
  }
}

export async function runLateFeedbackTrustOutboxOnce(): Promise<void> {
  await reapStuck();
  for (let i = 0; i < 25; i++) {
    const row = await claimOne();
    if (!row) break;
    await processRow(row);
  }
}

async function reapStuck(): Promise<void> {
  await withAdminScope(
    { caller: 'late-feedback-trust-outbox.reaper', reason: 'reset stuck in_progress rows' },
    (c) => c.query(
      `UPDATE late_feedback_trust_outbox SET status='pending', updated_at=NOW()
       WHERE status='in_progress' AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')`,
      [REAPER_THRESHOLD_MIN],
    ),
  );
}

async function claimOne(): Promise<OutboxRow | null> {
  return withAdminScope(
    { caller: 'late-feedback-trust-outbox.claim', reason: 'claim one due row' },
    async (c) => {
      const r = await c.query<OutboxRow>(
        `UPDATE late_feedback_trust_outbox SET status='in_progress', updated_at=NOW()
         WHERE id = (
           SELECT id FROM late_feedback_trust_outbox
           WHERE status='pending' AND next_attempt_at <= NOW()
           ORDER BY next_attempt_at
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         RETURNING id, tenant_id, payload, attempts, max_attempts`,
      );
      return r.rows[0] ?? null;
    },
  );
}

async function processRow(row: OutboxRow): Promise<void> {
  try {
    await postDecisionsToGovernance(row.payload);
    await markCompleted(row.id);
  } catch (err) {
    await markRetry(row.id, row.attempts + 1, row.max_attempts, (err as Error).message);
  }
}

async function markCompleted(id: string): Promise<void> {
  await withAdminScope(
    { caller: 'late-feedback-trust-outbox.markCompleted', reason: 'mark row completed' },
    (c) => c.query(
      `UPDATE late_feedback_trust_outbox SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [id],
    ),
  );
}

async function markRetry(id: string, attempts: number, maxAttempts: number, error: string): Promise<void> {
  const backoffMin = Math.min(10, 2 ** attempts);
  const terminal = attempts >= maxAttempts;
  if (terminal) {
    log.error({ outboxId: id, attempts, error }, 'late-feedback trust outbox row failed permanently (ops alert)');
  }
  await withAdminScope(
    { caller: 'late-feedback-trust-outbox.markRetry', reason: terminal ? 'max attempts exceeded' : 'schedule retry' },
    (c) => c.query(
      terminal
        ? `UPDATE late_feedback_trust_outbox SET status='failed', attempts=$2, last_error=$3, updated_at=NOW() WHERE id=$1`
        : `UPDATE late_feedback_trust_outbox SET status='pending', attempts=$2, last_error=$3,
             next_attempt_at = NOW() + ($4::int * INTERVAL '1 minute'), updated_at=NOW() WHERE id=$1`,
      terminal ? [id, attempts, error] : [id, attempts, error, backoffMin],
    ),
  );
}

let workerInterval: NodeJS.Timeout | null = null;

/** 30s poll loop. Idempotent — calling twice does nothing. */
export function startLateFeedbackTrustOutboxWorker(): void {
  if (workerInterval) return;
  workerInterval = setInterval(() => {
    runLateFeedbackTrustOutboxOnce().catch((err) =>
      log.error({ err: (err as Error).message }, 'late-feedback-trust-outbox-worker tick failed'),
    );
  }, 30_000);
  workerInterval.unref();
  log.info('late-feedback-trust-outbox-worker started (30s tick)');
}

export function stopLateFeedbackTrustOutboxWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}
