// Generic control-plane outbox: at-least-once delivery for all non-internal-agent
// events (account.*, tenant.activated, model.approved, etc.). Same lifecycle as
// internal-agent outbox; routed by entityType in publisher.ts dispatcher.

import type { PoolClient } from 'pg';
import { publishEventWithExplicitId } from './publisher';
import { withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

export interface EnqueueControlPlaneOutboxInput {
  tenantId: string | null;
  entityType: string;
  entityId: string;
  eventType: string;
  entityVersion: number | null;
  payload: Record<string, unknown>;
}

export interface ControlPlaneOutboxRowRef {
  outboxId: string;
  eventId: string;
  tenantId: string | null;
  entityType: string;
  entityId: string;
  eventType: string;
  entityVersion: number | null;
  payload: Record<string, unknown>;
}

const INLINE_PUBLISH_TIMEOUT_MS = 3000;
const REAPER_THRESHOLD_MIN = 5;

export async function enqueueControlPlaneOutbox(
  client: PoolClient,
  input: EnqueueControlPlaneOutboxInput,
): Promise<ControlPlaneOutboxRowRef> {
  // Single-statement upsert that REWRITES the row on conflict. Same semantics
  // as internal-agents/outbox.ts:enqueueInternalAgentOutbox — see that file
  // for the concurrent-update race rationale (new event_id + reset state so
  // both publishes reach the runtime, not just the first).
  const result = await client.query<{ id: string; event_id: string }>(
    `INSERT INTO control_plane_outbox
       (tenant_id, entity_type, entity_id, event_type, entity_version, event_payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (entity_type, entity_id, event_type)
       WHERE status IN ('pending', 'in_progress')
       DO UPDATE SET
         event_id        = gen_random_uuid(),
         event_payload   = EXCLUDED.event_payload,
         entity_version  = EXCLUDED.entity_version,
         tenant_id       = EXCLUDED.tenant_id,
         status          = 'pending',
         attempts        = 0,
         last_error      = NULL,
         next_attempt_at = NOW(),
         updated_at      = NOW()
     RETURNING id, event_id`,
    [
      input.tenantId,
      input.entityType,
      input.entityId,
      input.eventType,
      input.entityVersion,
      JSON.stringify(input.payload),
    ],
  );

  if (result.rows.length === 0) {
    throw new Error('enqueueControlPlaneOutbox: upsert returned no rows');
  }

  return {
    outboxId: result.rows[0].id,
    eventId: result.rows[0].event_id,
    tenantId: input.tenantId,
    entityType: input.entityType,
    entityId: input.entityId,
    eventType: input.eventType,
    entityVersion: input.entityVersion,
    payload: input.payload,
  };
}

export async function publishControlPlaneOutboxRowInline(
  row: ControlPlaneOutboxRowRef,
): Promise<{ inlinePublished: boolean }> {
  try {
    await Promise.race([
      publishEventWithExplicitId({
        eventId: row.eventId,
        entityType: row.entityType,
        entityId: row.entityId,
        eventType: row.eventType,
        entityVersion: row.entityVersion,
        eventVersion: 1,
        tenantId: row.tenantId ?? undefined,
        payload: row.payload,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('inline publish timed out after 3s')), INLINE_PUBLISH_TIMEOUT_MS),
      ),
    ]);
    await markCompleted(row.outboxId);
    return { inlinePublished: true };
  } catch (err) {
    log.warn(
      { outboxId: row.outboxId, eventId: row.eventId, err: (err as Error).message },
      'control-plane inline publish failed — leaving row pending for worker',
    );
    await markRetryFromInline(row.outboxId, (err as Error).message).catch(() => { /* non-critical */ });
    return { inlinePublished: false };
  }
}

interface OutboxRow {
  id: string;
  tenant_id: string | null;
  entity_type: string;
  entity_id: string;
  event_id: string;
  event_type: string;
  event_payload: Record<string, unknown>;
  entity_version: number | null;
  attempts: number;
  max_attempts: number;
}

export async function runControlPlaneOutboxOnce(): Promise<void> {
  await reapStuckInProgress();
  for (let i = 0; i < 25; i++) {
    const row = await claimOne();
    if (!row) break;
    await processRow(row);
  }
}

async function reapStuckInProgress(): Promise<void> {
  await withAdminScope(
    { caller: 'control-plane-outbox-worker.reaper', reason: 'reset stuck in_progress rows' },
    (c) => c.query(
      `UPDATE control_plane_outbox
         SET status='pending', updated_at=NOW()
       WHERE status='in_progress'
         AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')`,
      [REAPER_THRESHOLD_MIN],
    ),
  );
}

async function claimOne(): Promise<OutboxRow | null> {
  return withAdminScope(
    { caller: 'control-plane-outbox-worker.claim', reason: 'claim one due row' },
    async (c) => {
      const r = await c.query<OutboxRow>(
        `UPDATE control_plane_outbox
           SET status='in_progress', updated_at=NOW()
         WHERE id = (
           SELECT id FROM control_plane_outbox
           WHERE status='pending' AND next_attempt_at <= NOW()
           ORDER BY next_attempt_at
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         RETURNING id, tenant_id, entity_type, entity_id, event_id, event_type,
                   event_payload, entity_version, attempts, max_attempts`,
      );
      return r.rows[0] ?? null;
    },
  );
}

async function processRow(row: OutboxRow): Promise<void> {
  try {
    await publishEventWithExplicitId({
      eventId: row.event_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      eventType: row.event_type,
      entityVersion: row.entity_version,
      eventVersion: 1,
      tenantId: row.tenant_id ?? undefined,
      payload: row.event_payload,
    });
    await markCompleted(row.id);
  } catch (err) {
    await markRetry(row.id, row.attempts + 1, row.max_attempts, (err as Error).message);
  }
}

async function markCompleted(id: string): Promise<void> {
  await withAdminScope(
    { caller: 'control-plane-outbox.markCompleted', reason: 'mark outbox row completed' },
    (c) => c.query(
      `UPDATE control_plane_outbox
         SET status='completed', completed_at=NOW(), updated_at=NOW()
       WHERE id=$1`,
      [id],
    ),
  );
}

async function markRetryFromInline(id: string, error: string): Promise<void> {
  await withAdminScope(
    { caller: 'control-plane-outbox.markRetryFromInline', reason: 'inline publish failed' },
    (c) => c.query(
      `UPDATE control_plane_outbox
         SET attempts = attempts + 1,
             last_error = $2,
             next_attempt_at = NOW() + (LEAST(10, POWER(2, attempts + 1))::int * INTERVAL '1 minute'),
             updated_at = NOW()
       WHERE id = $1`,
      [id, error],
    ),
  );
}

async function markRetry(
  id: string,
  attempts: number,
  maxAttempts: number,
  error: string,
): Promise<void> {
  const backoffMin = Math.min(10, 2 ** attempts);
  const terminal = attempts >= maxAttempts;
  await withAdminScope(
    { caller: 'control-plane-outbox.markRetry', reason: terminal ? 'max attempts exceeded' : 'schedule retry' },
    (c) => c.query(
      terminal
        ? `UPDATE control_plane_outbox
             SET status='failed', attempts=$2, last_error=$3, updated_at=NOW()
           WHERE id=$1`
        : `UPDATE control_plane_outbox
             SET status='pending', attempts=$2, last_error=$3,
                 next_attempt_at = NOW() + ($4::int * INTERVAL '1 minute'),
                 updated_at = NOW()
           WHERE id=$1`,
      terminal ? [id, attempts, error] : [id, attempts, error, backoffMin],
    ),
  );
}

let workerInterval: NodeJS.Timeout | null = null;

export function startControlPlaneOutboxWorker(): void {
  if (workerInterval) return;
  workerInterval = setInterval(() => {
    runControlPlaneOutboxOnce().catch((err) =>
      log.error({ err: (err as Error).message }, 'control-plane-outbox-worker tick failed'),
    );
  }, 30_000);
  workerInterval.unref();
  log.info('control-plane-outbox-worker started (30s tick)');
}

export function stopControlPlaneOutboxWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}
