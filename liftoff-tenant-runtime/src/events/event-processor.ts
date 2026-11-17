// Event Processing Ledger
// Provides idempotent, step-tracked event processing for multi-step handlers.
// Redeliveries skip completed steps and resume from where the prior attempt failed.
// Failed events are routed to the DLQ instead of being dropped.

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { ControlPlaneEvent } from './types';
import { logger } from '../infrastructure/logging';
import { setTraceContext } from '../infrastructure/safe-trace-context';

// --- Interfaces ---

export interface StepDefinition {
  name: string;
  execute: (ctx: EventContext) => Promise<void>;
}

export interface EventContext {
  event: ControlPlaneEvent;
  metadata: Record<string, unknown>;
  pool: Pool;
}

interface LedgerRow {
  event_id: string;
  tenant_id: string;
  status: 'processing' | 'completed' | 'failed';
  steps_completed: string[];
  result_metadata: Record<string, unknown> | null;
  attempt_count: number;
  error: string | null;
  first_seen_at: Date;
}

// --- DlqRoutedError ---

export class DlqRoutedError extends Error {
  constructor(eventId: string) {
    super(`Event ${eventId} routed to DLQ`);
    this.name = 'DlqRoutedError';
  }
}

// --- EntityBusyError ---
//
// Thrown by EventProcessor.process() when claimEvent fails because a
// DIFFERENT event for the same entity is currently in flight (the
// idx_epl_entity_processing unique partial index rejects the INSERT).
//
// This is a TRANSIENT condition — the in-flight event will complete shortly
// and the deferred event must be retried. The subscriber MUST nack the
// Pub/Sub message on this error so Pub/Sub redelivers it after the ack
// deadline. Without that, fast-arriving event pairs (e.g. pause + resume
// in <1s) silently lose the second event.
//
// Distinct from "same event_id is in flight on a sibling instance" (which
// IS a legitimate no-op) because that case still ack-s the message — the
// other instance is doing the work.
export class EntityBusyError extends Error {
  constructor(public readonly eventId: string, public readonly entityId: string) {
    super(`Entity ${entityId} busy with another event; deferring ${eventId}`);
    this.name = 'EntityBusyError';
  }
}

// --- Step Registry ---
// Static allowlist of step names per event_type:subStatus.
// Prevents step name manipulation and collisions across event types.

const STEP_REGISTRY: Record<string, string[]> = {
  'tenant.internal_agent.status_changed:active': [
    'create_instruction', 'persist_trigger_config', 'activate_lifecycle', 'ensure_scheduler', 'update_cache',
  ],
  'tenant.ai_team.status_changed:active': [
    'create_instruction', 'persist_trigger_config', 'activate_lifecycle', 'ensure_scheduler', 'update_cache',
  ],
  'tenant.internal_agent.status_changed:paused': [
    'pause_lifecycle', 'cancel_tasks', 'update_cache',
  ],
  'tenant.ai_team.status_changed:paused': [
    'pause_lifecycle', 'cancel_tasks', 'update_cache',
  ],
};

// --- Metadata & Error Sanitization ---

const ALLOWED_METADATA_KEYS = new Set([
  'instructionId', 'schedulerJobId', 'agentId', 'duration',
]);

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const key of Object.keys(metadata)) {
    if (ALLOWED_METADATA_KEYS.has(key)) sanitized[key] = metadata[key];
  }
  return sanitized;
}

function sanitizeError(error: Error): string {
  let msg = error.message.substring(0, 1024);
  msg = msg.replace(/postgresql?:\/\/[^\s]+/gi, '[REDACTED_CONN]');
  msg = msg.replace(/Bearer [^\s]+/gi, '[REDACTED_TOKEN]');
  return msg;
}

// --- EventProcessor ---

export class EventProcessor {
  constructor(
    private pool: Pool,
    private maxAttempts: number = 5,
  ) {}

  async process(event: ControlPlaneEvent, steps: StepDefinition[]): Promise<boolean> {
    const tenantId = event.tenant_id;
    if (!tenantId) throw new Error('tenant_id required for EventProcessor');

    // WS-1.2 — bind tenant_id to the logging trace context at the event
    // boundary so every subsequent log emission from a step body carries
    // tenant attribution.
    setTraceContext({ tenantId });

    const eventId = event.event_id;

    // Validate step names against static registry (cross-cutting #9)
    this.validateStepNames(event, steps);

    // 1. CLAIM
    const ledger = await this.claimEvent(event);
    if (ledger === null) return false; // Another handler active or entity locked
    if (ledger.status === 'completed') return true;

    if (ledger.attempt_count > this.maxAttempts) {
      await this.sendToDlq(event, ledger);
      throw new DlqRoutedError(eventId);
    }

    // 2. Version ordering guard (cross-cutting #7)
    if (event.entity_version != null) {
      const laterCompleted = await this.pool.query(
        `SELECT 1 FROM event_processing_ledger
         WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3
           AND entity_version > $4 AND status = 'completed' LIMIT 1`,
        [tenantId, event.entity_type, event.entity_id, event.entity_version],
      );
      if (laterCompleted.rows.length > 0) {
        await this.markCompleted(tenantId, eventId, {});
        return true;
      }
    }

    // 3. Build context
    const ctx: EventContext = {
      event,
      metadata: ledger.result_metadata || {},
      pool: this.pool,
    };
    const completedSteps = new Set(ledger.steps_completed);

    // 4. Execute steps, skipping completed ones
    for (const step of steps) {
      if (completedSteps.has(step.name)) continue;

      try {
        await step.execute(ctx);

        // Atomic CAS append — prevents concurrent overwrites
        const updateResult = await this.pool.query(
          `UPDATE event_processing_ledger
           SET steps_completed = steps_completed || $3::jsonb,
               result_metadata = $4, updated_at = NOW()
           WHERE tenant_id = $1 AND event_id = $2
             AND NOT steps_completed @> $3::jsonb
           RETURNING event_id`,
          [
            tenantId,
            eventId,
            JSON.stringify(step.name),
            JSON.stringify(sanitizeMetadata(ctx.metadata)),
          ],
        );

        if (updateResult.rowCount === 0) {
          logger.warn('Step CAS append returned 0 rows — possible concurrent execution', {
            event_id: eventId, step: step.name,
          });
        }
      } catch (error) {
        // Set status to 'failed' so it's queryable and distinguishable from 'processing'
        await this.pool.query(
          `UPDATE event_processing_ledger
           SET error = $3, status = 'failed', updated_at = NOW()
           WHERE tenant_id = $1 AND event_id = $2`,
          [tenantId, eventId, sanitizeError(error as Error)],
        );
        throw error;
      }
    }

    // 5. Mark complete
    await this.markCompleted(tenantId, eventId, ctx.metadata);
    return true;
  }

  // --- Claim ---

  private async claimEvent(event: ControlPlaneEvent): Promise<LedgerRow | null> {
    const tenantId = event.tenant_id!;

    try {
      // Atomic claim with explicit status handling:
      // - First delivery: INSERT succeeds
      // - Redelivery of FAILED event: ON CONFLICT updates, resets to 'processing'
      // - Stale PROCESSING (>5 min, crashed handler): ON CONFLICT updates
      // - Active PROCESSING (<5 min): WHERE excludes → RETURNING empty → null
      // - COMPLETED: WHERE excludes → RETURNING empty → separate query returns status
      const result = await this.pool.query(
        `INSERT INTO event_processing_ledger
           (tenant_id, event_id, event_type, entity_type, entity_id, entity_version)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, event_id) DO UPDATE SET
           attempt_count = event_processing_ledger.attempt_count + 1,
           status = CASE
             WHEN event_processing_ledger.status = 'failed' THEN 'processing'
             ELSE event_processing_ledger.status
           END,
           updated_at = NOW()
         WHERE event_processing_ledger.status = 'failed'
            OR (event_processing_ledger.status = 'processing'
                AND event_processing_ledger.updated_at < NOW() - INTERVAL '5 minutes')
         RETURNING *`,
        [
          tenantId, event.event_id, event.event_type,
          event.entity_type, event.entity_id, event.entity_version,
        ],
      );

      if (result.rows.length > 0) return this.mapRow(result.rows[0]);

      // RETURNING empty: either completed or actively processing.
      // Query to distinguish.
      const existing = await this.pool.query(
        `SELECT status, steps_completed, result_metadata, attempt_count, first_seen_at, error
         FROM event_processing_ledger WHERE tenant_id = $1 AND event_id = $2`,
        [tenantId, event.event_id],
      );

      if (existing.rows.length === 0) {
        logger.error('claimEvent: INSERT and SELECT both returned nothing', {
          event_id: event.event_id, tenant_id: tenantId,
        });
        return null;
      }

      const row = existing.rows[0];
      if (row.status === 'completed') {
        return { ...this.mapRow(row), status: 'completed' };
      }

      // Actively processing by another handler
      return null;

    } catch (error: any) {
      // Handle idx_epl_entity_processing unique violation:
      // Different event_id for same entity while another is processing.
      if (error.code === '23505' && error.constraint?.includes('entity_processing')) {
        // Before throwing EntityBusyError, check if the blocking event is
        // stale (>5 min old). A permanently stuck 'processing' row blocks
        // all future events for the entity indefinitely — Pub/Sub stops
        // redelivering the old event after max retries, so the same-event-id
        // reclaim timeout never fires. Forcibly failing stale locks here
        // unblocks the queue while preserving the short-window protection
        // for genuinely in-flight events.
        const cleared = await this.pool.query(
          `UPDATE event_processing_ledger
           SET status = 'failed', error = 'Stale processing lock cleared by newer event', updated_at = NOW()
           WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3
             AND status = 'processing' AND updated_at < NOW() - INTERVAL '5 minutes'
           RETURNING event_id`,
          [tenantId, event.entity_type, event.entity_id],
        );

        if (cleared.rows.length > 0) {
          logger.info('Cleared stale entity processing lock, retrying claim', {
            event_id: event.event_id,
            entity_id: event.entity_id,
            cleared_event_id: cleared.rows[0].event_id,
          });
          // Retry claim now that the stale lock is cleared
          return this.claimEvent(event);
        }

        logger.info('Entity already being processed by another event, will nack for redelivery', {
          event_id: event.event_id, entity_id: event.entity_id,
        });
        throw new EntityBusyError(event.event_id, event.entity_id);
      }
      throw error;
    }
  }

  // --- DLQ ---

  private async sendToDlq(event: ControlPlaneEvent, ledger: LedgerRow): Promise<void> {
    try {
      await this.pool.query(
        // failure_class 'transient': this path is reached by exhausting the
        // retry budget, and the retry budget exists for recoverable faults.
        // Replaying once the dependency is healthy is the remediation, which
        // is what separates these rows from the schema-invalid ones.
        `INSERT INTO dlq_messages
           (id, original_topic, original_message_id, tenant_id, payload, error,
            delivery_attempt, max_delivery_attempts, first_received_at, failed_at, status,
            failure_class)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), 'pending', 'transient')
         ON CONFLICT (id) DO NOTHING`,
        [
          uuidv4(), event.event_type, event.event_id, event.tenant_id,
          JSON.stringify(event),
          sanitizeError(new Error(ledger.error || 'Max attempts exceeded')),
          ledger.attempt_count, this.maxAttempts, ledger.first_seen_at,
        ],
      );

      await this.pool.query(
        `UPDATE event_processing_ledger SET status = 'failed', updated_at = NOW()
         WHERE tenant_id = $1 AND event_id = $2`,
        [event.tenant_id, event.event_id],
      );

      // Emit critical log for alerting
      logger.error('Event routed to DLQ after max attempts', {
        event_id: event.event_id,
        event_type: event.event_type,
        tenant_id: event.tenant_id,
        attempt_count: ledger.attempt_count,
        severity: 'CRITICAL',
      });
    } catch (dlqError) {
      // DLQ write failed — log but don't throw DlqRoutedError.
      // The original error will be rethrown, message nacked, and Pub/Sub retries.
      logger.error('Failed to write to DLQ', {
        event_id: event.event_id,
        error: (dlqError as Error).message,
      });
      throw new Error(`DLQ write failed: ${(dlqError as Error).message}`);
    }
  }

  // --- Helpers ---

  private async markCompleted(
    tenantId: string,
    eventId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE event_processing_ledger
       SET status = 'completed', result_metadata = $3, completed_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $1 AND event_id = $2`,
      [tenantId, eventId, JSON.stringify(sanitizeMetadata(metadata))],
    );
  }

  private validateStepNames(event: ControlPlaneEvent, steps: StepDefinition[]): void {
    const payload = event.payload as Record<string, unknown> | undefined;
    // Both names for the status, for the same reason the status_changed handler
    // accepts both. Reading only `newStatus` built a key no STEP_REGISTRY entry
    // matches, so `allowedSteps` came back undefined and this allow-list quietly
    // stopped enforcing anything on exactly the events it was written for.
    const subStatus = payload?.newStatus || payload?.status || '';
    const registryKey = `${event.event_type}:${subStatus}`;
    const allowedSteps = STEP_REGISTRY[registryKey];

    if (allowedSteps) {
      for (const step of steps) {
        if (!allowedSteps.includes(step.name)) {
          throw new Error(`Invalid step name '${step.name}' for ${registryKey}`);
        }
      }
    }
  }

  private mapRow(row: Record<string, unknown>): LedgerRow {
    return {
      event_id: row.event_id as string,
      tenant_id: row.tenant_id as string,
      status: row.status as LedgerRow['status'],
      steps_completed: (row.steps_completed as string[]) || [],
      result_metadata: row.result_metadata as Record<string, unknown> | null,
      attempt_count: row.attempt_count as number,
      error: row.error as string | null,
      first_seen_at: row.first_seen_at as Date,
    };
  }
}
