// Liftoff Switch — report the FIRST terminal outcome of an imported routine.
//
// Cutover completing does not mean imported recurring work has succeeded. A
// routine that silently fails after a migration is the worst possible first
// impression for someone who just moved off OpenClaw or Hermes, and nothing in
// the control plane could see it: `invocation.completed` is a BILLING event
// carrying token counts, it does not report a terminal outcome, and a stalled
// run never publishes it at all.
//
// So an imported routine carries a stable `migrationRoutineRef` in its trigger
// config, and this module reports the first terminal outcome for it.
//
// INV-TR-010 / ADR-039: anything published to the control plane carries the
// INTERNAL agent id. The two id spaces are disjoint, and a wrong-space id
// matches zero rows with no error — a "successful" write that updated nothing.
// The resolution happens HERE, on the side that owns the mapping. The platform
// deliberately REJECTS a payload carrying only a runtime agent id rather than
// translating it, so a mapping miss must fail loudly here instead of sending a
// half-payload the platform would refuse.

import { getPlatformCallbackClient } from './client';
import { resolveInternalAgentId } from '../agent-lifecycle/resolve-runtime-agent-id';
import { logger } from '../infrastructure/logging';

export interface FirstRunReport {
  tenantId: string;
  /** Runtime agents.id. Resolved to internal_agents.id before sending. */
  agentId: string;
  /** The stable reference the migration stamped on the imported routine. */
  migrationRoutineRef: string;
  outcome: 'succeeded' | 'failed';
  /** Non-secret category only. Never a message from a customer's run: the
   *  control plane surfaces this in a migration view, and an error string from
   *  a customer's own workload can carry their data. */
  errorCategory?: string;
  occurredAt?: Date;
}

/** Map an invocation outcome to the two states the migration view understands. */
export function outcomeToFirstRunStatus(outcome: string): 'succeeded' | 'failed' {
  return outcome === 'success' ? 'succeeded' : 'failed';
}

/** Coarse, non-secret failure category. Deliberately a small closed set: this
 *  is displayed to a user who has just migrated, and it must never leak the
 *  content of their run. */
export function toErrorCategory(failureClass?: string | null): string | undefined {
  if (!failureClass) return undefined;
  const known = new Set([
    'timeout',
    'provider_error',
    'tool_error',
    'permission_denied',
    'rate_limited',
    'cancelled',
    'unknown',
  ]);
  return known.has(failureClass) ? failureClass : 'unknown';
}

export async function reportFirstScheduledRun(report: FirstRunReport): Promise<void> {
  const client = getPlatformCallbackClient();
  if (!client) return;

  let internalAgentId: string | null = null;
  try {
    internalAgentId = await resolveInternalAgentId(
      report.tenantId,
      report.agentId,
      'switch-first-run',
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: report.tenantId, agentId: report.agentId },
      'switch-first-run: internal-agent-id lookup failed',
    );
  }

  if (!internalAgentId) {
    // Do NOT send a runtime-space id and hope the platform sorts it out. It
    // will refuse the payload by design, and a silent no-op write is exactly
    // the failure mode ADR-039 exists to prevent.
    logger.warn(
      { tenantId: report.tenantId, agentId: report.agentId, ref: report.migrationRoutineRef },
      'switch-first-run: no internal agent id; first-run outcome not reported',
    );
    return;
  }

  try {
    // No explicit Content-Type: ServiceClient.buildHeaders already defaults to
    // application/json, and adding a capitalized duplicate produces a
    // comma-joined header that express.json refuses to parse.
    const resp = await client.fetch('platform', '/api/internal/source-migrations/first-run', {
      method: 'POST',
      body: JSON.stringify({
        tenantId: report.tenantId,
        routineRef: report.migrationRoutineRef,
        internalAgentId,
        outcome: report.outcome,
        errorCategory: report.errorCategory,
        occurredAt: (report.occurredAt ?? new Date()).toISOString(),
      }),
      breakerKey: 'platform:switch-first-run',
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    logger.info(
      {
        tenantId: report.tenantId,
        ref: report.migrationRoutineRef,
        outcome: report.outcome,
      },
      'switch-first-run: reported first scheduled-run outcome',
    );
  } catch (err) {
    // Non-fatal. The platform records first-write-wins, so a lost report leaves
    // the routine showing "awaiting", which is honest: we genuinely do not know
    // that it ran.
    logger.warn(
      { err: (err as Error).message, tenantId: report.tenantId, ref: report.migrationRoutineRef },
      'switch-first-run: report failed',
    );
  }
}
