// Per-side-effect idempotency (plan §4.2).
//
// Claim-before / replay over `event_processing_ledger` — the existing
// claim-before idempotency ledger — using `event_type='side_effect'` rows keyed
// `event_id = step_key`. Large replay payloads (a Gmail list, a Sheet read often
// exceed result_metadata's 4096-char cap) live in `idempotency_result_payloads`
// (migration 299); the ledger row holds only status + the step_key reference.
//
// step_key = sha256(tenantId | triggerKey | toolName | canonicalJson(args)) —
// stable across redelivery of the same trigger (triggerKey, §4.1) and identical
// for an LLM re-emitting the same call; distinct for genuinely different calls.
//
// Posture governs the ambiguous `processing` (crashed/in-flight) case:
//   - effectively_once → re-claim and run (a vendor idempotency key or natural
//     idempotency makes the retry safe);
//   - at_most_once    → `blocked` (never auto-re-fire; surface for reconciliation).
// Default posture is at_most_once (the safe fallback — a missing tag never
// double-fires). Fail-open: any DB error returns `run`.

import { createHash } from 'crypto';
import { armWatch, MAINTENANCE_PATHS } from '../infrastructure/maintenance-tasks';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

export type DedupPolicy = 'effectively_once' | 'at_most_once';

export type SideEffectClaim =
  | { outcome: 'run'; stepKey: string }
  | { outcome: 'replay'; stepKey: string; result: unknown }
  | { outcome: 'blocked'; stepKey: string };

const STALE_INTERVAL = "INTERVAL '5 minutes'";

function ledgerPool() {
  return getPoolForService('default');
}

/** Recursively key-sorted JSON so structurally-equal args canonicalize to the
 *  same string (free-text fields stay exact — a different body is a different
 *  side effect and SHOULD re-fire). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function stepKey(i: {
  tenantId: string;
  triggerKey: string;
  toolName: string;
  args: unknown;
}): string {
  const fp = createHash('sha256').update(canonicalJson(i.args)).digest('hex');
  return createHash('sha256')
    .update(`${i.tenantId}|${i.triggerKey}|${i.toolName}|${fp}`)
    .digest('hex');
}

/**
 * Claim a side effect BEFORE it fires. Returns `run` to execute, `replay` with
 * the stored result (skip the side effect), or `blocked` (at_most_once + a prior
 * attempt's outcome is unknown). Fail-open → `run` on any DB error.
 */
export async function claimSideEffect(input: {
  tenantId: string;
  triggerKey: string;
  toolName: string;
  args: unknown;
  policy: DedupPolicy;
}): Promise<SideEffectClaim> {
  const key = stepKey(input);
  try {
    const claimed = await ledgerPool().query<{ status: string }>(
      // result_metadata carries the dedup policy so the §4.8 reconciler can
      // abandon ONLY stuck at_most_once rows (effectively_once stuck rows are
      // reclaimed by the next attempt via the WHERE clause below).
      `INSERT INTO event_processing_ledger
         (tenant_id, event_id, event_type, entity_type, entity_id, result_metadata)
       VALUES ($1::uuid, $2, 'side_effect', 'side_effect', $2,
               jsonb_build_object('policy', $3::text))
       ON CONFLICT (tenant_id, event_id) DO UPDATE SET
         attempt_count = event_processing_ledger.attempt_count + 1,
         status = CASE WHEN event_processing_ledger.status = 'failed' THEN 'processing'
                       ELSE event_processing_ledger.status END,
         updated_at = NOW()
       WHERE event_processing_ledger.status = 'failed'
          OR ($3 = 'effectively_once'
              AND event_processing_ledger.status = 'processing'
              AND event_processing_ledger.updated_at < NOW() - ${STALE_INTERVAL})
       RETURNING status`,
      [input.tenantId, key, input.policy],
    );
    if (claimed.rows.length > 0) {
      // An at_most_once claim that its run never resolves blocks every
      // redelivery until the reconciler abandons it; arm the reconciler for
      // just past its 10-minute window.
      if (input.policy === 'at_most_once') {
        armWatch('idempotency', MAINTENANCE_PATHS.idempotencyReconcile, { delayMs: 11 * 60 * 1000 });
      }
      return { outcome: 'run', stepKey: key };
    }

    const existing = await ledgerPool().query<{ status: string }>(
      `SELECT status FROM event_processing_ledger
       WHERE tenant_id = $1::uuid AND event_id = $2`,
      [input.tenantId, key],
    );
    const row = existing.rows[0];
    if (!row) return { outcome: 'run', stepKey: key }; // race — safe to proceed
    if (row.status === 'completed') {
      const result = await loadPayload(input.tenantId, key);
      return { outcome: 'replay', stepKey: key, result };
    }
    // status === 'processing': for at_most_once we did NOT reclaim above (the
    // WHERE only reclaims stale processing for effectively_once), so an unknown
    // prior attempt is blocked rather than re-fired.
    if (input.policy === 'at_most_once') return { outcome: 'blocked', stepKey: key };
    // effectively_once, active processing (<5min) — another delivery owns it.
    return { outcome: 'blocked', stepKey: key };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, toolName: input.toolName },
      'claimSideEffect failed; running without idempotency (fail-open)',
    );
    return { outcome: 'run', stepKey: key };
  }
}

/** Mark the side effect completed and persist its full result for replay. */
export async function resolveSideEffect(input: {
  tenantId: string;
  stepKey: string;
  result: unknown;
}): Promise<void> {
  try {
    await ledgerPool().query(
      `INSERT INTO idempotency_result_payloads (step_key, tenant_id, payload)
       VALUES ($1, $2::uuid, $3::jsonb)
       ON CONFLICT (step_key) DO UPDATE SET payload = EXCLUDED.payload`,
      [input.stepKey, input.tenantId, JSON.stringify(input.result ?? null)],
    );
    await ledgerPool().query(
      `UPDATE event_processing_ledger
         SET status='completed', completed_at=NOW(), updated_at=NOW()
       WHERE tenant_id=$1::uuid AND event_id=$2 AND status='processing'`,
      [input.tenantId, input.stepKey],
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, stepKey: input.stepKey },
      'resolveSideEffect failed (non-fatal — a retry may re-run the side effect)',
    );
  }
}

/** Mark the side effect failed so a redelivery re-runs it. */
export async function failSideEffect(input: {
  tenantId: string;
  stepKey: string;
  error: string;
}): Promise<void> {
  await ledgerPool()
    .query(
      `UPDATE event_processing_ledger SET status='failed', error=$3, updated_at=NOW()
       WHERE tenant_id=$1::uuid AND event_id=$2 AND status='processing'`,
      [input.tenantId, input.stepKey, input.error.slice(0, 1024)],
    )
    .catch(() => undefined);
}

async function loadPayload(tenantId: string, key: string): Promise<unknown> {
  try {
    const res = await ledgerPool().query<{ payload: unknown }>(
      `SELECT payload FROM idempotency_result_payloads
       WHERE step_key = $1 AND tenant_id = $2::uuid`,
      [key, tenantId],
    );
    return res.rows[0]?.payload ?? null;
  } catch {
    return null;
  }
}
