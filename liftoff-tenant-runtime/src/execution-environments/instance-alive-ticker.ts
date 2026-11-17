// Instance-alive ticker — bills every live sandbox for the exact wall-clock
// time the underlying Cloud Run instance has been provisioned. Fires every
// 30 s by default (tunable via SANDBOX_ALIVE_TICK_MS env, clamped to
// [10_000, 300_000]) and walks sandbox_state — NOT the per-resource tables.
// A faster tick reduces the unbilled-window risk on a runtime crash and
// gives entitlement enforcement quicker reaction time when a sandbox is
// about to bust its cost ceiling; the DB write cost scales linearly with
// the inverse of the interval and is trivial at the 200-concurrent-sandbox
// tenant cap (400 writes/min at 30 s).
//
// Atomic billing model:
//   1. Read every sandbox with status NOT IN ('destroyed','error')
//   2. For each, compute elapsed = NOW() - last_billed_at
//   3. UPDATE sandbox_state SET last_billed_at = NOW(), cost_micro_credits_total += charge
//      WHERE sandbox_id = $1 AND last_billed_at = $previous (CAS)
//      → If the CAS fails (another ticker beat us), skip; no double-bill.
//   4. INSERT into sandbox_usage_log (idempotency key = ${sandboxId}:${billed_to_ms})
//      → If a duplicate insert collides on the unique key, the bill was
//        already written; advance and continue.
//   5. UsageLedger.recordUsage — telemetry + the row the control plane's
//      cost-attribution ingester reads. It no longer drains any runtime-side
//      counter; spend authority lives entirely in the control plane.
//
// Crash recovery: if the runtime is down for N seconds, the next tick after
// recovery bills the full gap because last_billed_at hasn't advanced. The
// per-sandbox CAS update prevents two replicas from billing the same window.

import { v4 as uuid } from 'uuid';
import { getPoolForService } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import {
  calculateInstanceAliveMicroCredits,
  microCreditsToCredits,
  type CreditCostProvider,
} from './credit-calculator';
import type { SandboxUsageRecord, ExecutionEnvironmentType } from './types';

const pool = getPoolForService('default');

export interface UsageRecorder {
  recordUsage(record: SandboxUsageRecord): Promise<void>;
}

export interface UsageLedger {
  recordUsage(record: {
    tenantId: string;
    agentId: string;
    workflowId: string | null;
    actionId: string;
    eventType: string;
    credits: number;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * Default tick interval — 30 s. Operator override via SANDBOX_ALIVE_TICK_MS
 * env, clamped to [10_000, 300_000] so a typo can't disable the meter or
 * thrash the DB. The first tick fires immediately on start() so a sandbox
 * destroyed within the first interval still gets billed for the seconds it
 * was alive.
 */
function resolveTickMs(): number {
  const raw = parseInt(process.env.SANDBOX_ALIVE_TICK_MS ?? '30000', 10);
  if (Number.isNaN(raw)) return 30_000;
  return Math.min(300_000, Math.max(10_000, raw));
}

/**
 * Cap a single catch-up bill at one hour so a multi-hour runtime outage
 * doesn't dump a single multi-dollar charge on a tenant. The remaining
 * unbilled time is forfeited; this is conservative on the tenant's side
 * (we don't bill for time we lost track of).
 */
const MAX_CATCHUP_MS = 60 * 60_000;

export class InstanceAliveTicker {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly recorder: UsageRecorder,
    private readonly creditCostProvider: CreditCostProvider,
    private readonly usageLedger: UsageLedger,
  ) {}

  start(): void {
    if (this.timer) return;
    const tickMs = resolveTickMs();
    log.info({ message: 'instance-alive ticker started', tickMs });
    // Run one tick immediately so a sandbox that lives less than one tick
    // before teardown still gets billed for the seconds it was alive.
    this.tick().catch(err => log.error({ message: 'instance-alive ticker error', err: (err as Error).message }));
    this.timer = setInterval(
      () => this.tick().catch(err => log.error({ message: 'instance-alive ticker error', err: (err as Error).message })),
      tickMs,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One billing pass. Public so the cleanup path (`SandboxExecutor.cleanup`)
   * can flush the final partial minute before teardown.
   */
  async tick(): Promise<void> {
    const result = await pool.query<{
      sandbox_id: string;
      session_id: string;
      tenant_id: string;
      agent_id: string;
      invocation_id: string;
      template: string;
      last_billed_at: Date;
    }>(
      `SELECT sandbox_id, session_id, tenant_id, agent_id, invocation_id, template, last_billed_at
         FROM sandbox_state
        WHERE status NOT IN ('destroyed','error')
          AND last_billed_at IS NOT NULL`,
    );

    const now = Date.now();
    for (const row of result.rows) {
      const lastBilledMs = row.last_billed_at.getTime();
      const elapsedMs = Math.min(now - lastBilledMs, MAX_CATCHUP_MS);
      if (elapsedMs <= 0) continue;
      await this.billOne({
        sandboxId: row.sandbox_id,
        tenantId: row.tenant_id,
        agentId: row.agent_id,
        invocationId: row.invocation_id,
        template: row.template as ExecutionEnvironmentType,
        elapsedMs,
        priorLastBilledAt: row.last_billed_at,
      }).catch(err => log.warn({ message: 'instance-alive bill failed', sandboxId: row.sandbox_id, err: (err as Error).message }));
    }
  }

  /**
   * Bill one sandbox. Atomic CAS on sandbox_state.last_billed_at prevents
   * two concurrent tickers from billing the same window twice.
   */
  private async billOne(params: {
    sandboxId: string;
    tenantId: string;
    agentId: string;
    invocationId: string;
    template: ExecutionEnvironmentType;
    elapsedMs: number;
    priorLastBilledAt: Date;
  }): Promise<void> {
    const microCredits = await calculateInstanceAliveMicroCredits(
      this.creditCostProvider,
      params.tenantId,
      params.elapsedMs,
    );
    if (microCredits <= 0) return;

    // CAS advance: only update if last_billed_at is still what we read.
    // Postgres TIMESTAMPTZ stores microsecond precision (NOW() picks that up)
    // but node-pg roundtrips through JavaScript Date which is millisecond-
    // precise — so an exact `last_billed_at = $3` compare always misses by
    // the dropped microseconds and the CAS rowCount stays 0 forever. Both
    // sides go through date_trunc('milliseconds', …) to make the compare
    // precision-tolerant. Concurrency safety still holds: a competing
    // ticker that already advanced last_billed_at past our snapshot will
    // see a different millisecond bucket and lose this CAS, so we never
    // double-bill a window.
    const cas = await pool.query<{ new_last_billed_at: Date }>(
      `UPDATE sandbox_state
          SET last_billed_at = NOW(),
              cost_micro_credits_total = cost_micro_credits_total + $2
        WHERE sandbox_id = $1
          AND date_trunc('milliseconds', last_billed_at) = date_trunc('milliseconds', $3::timestamptz)
          AND status NOT IN ('destroyed','error')
        RETURNING last_billed_at AS new_last_billed_at`,
      [params.sandboxId, microCredits, params.priorLastBilledAt],
    );
    if (cas.rowCount === 0) {
      // Someone else billed this window first, or the sandbox was destroyed.
      return;
    }
    const billedToMs = cas.rows[0].new_last_billed_at.getTime();

    // Convert to legacy credits unit for sandbox_usage_log (rounding up so
    // we never undercharge across the bridge to the legacy report path).
    //
    // UNIT: these "legacy credits" are MILLI-USD, not action credits.
    // credit-calculator rates 1,000,000 micro-credits = $1, and
    // microCreditsToCredits divides by 1,000 — so one credit here is one
    // thousandth of a dollar. The magnitude is correct and is deliberately left
    // alone; what was missing was anyone being able to know that without
    // re-deriving it, which is why `metadata.unit` is stamped on the ledger row
    // below. usage_events.credits carries more than one unit across event
    // types; the field is what tells them apart.
    const credits = microCreditsToCredits(microCredits);
    const idempotencyKey = `${params.sandboxId}:instance_alive:${billedToMs}`;

    await this.recorder.recordUsage({
      tenantId: params.tenantId,
      invocationId: params.invocationId,
      agentId: params.agentId,
      sandboxId: params.sandboxId,
      phase: 'instance_alive',
      toolName: null,
      cpuMillis: 0,
      memoryMbSeconds: 0,
      egressBytes: 0,
      wallClockMs: params.elapsedMs,
      creditsConsumed: credits,
      template: params.template,
      exitCode: null,
      idempotencyKey,
    });

    // usage_events.action_id is typed UUID (migration 001); the stringy
    // `${sandboxId}:instance_alive:${billedToMs}` tracing handle goes into
    // metadata.actionRef so it stays queryable. Without this, every alive
    // ticker tick silently fails on the usage_events insert with
    // "invalid input syntax for type uuid" — usage_log still advances and
    // last_billed_at progresses, but the OU bucket never drains for
    // alive-time costs (the dominant component of any long-running
    // sandbox bill).
    await this.usageLedger.recordUsage({
      tenantId: params.tenantId,
      agentId: params.agentId,
      workflowId: null,
      actionId: uuid(),
      eventType: 'sandbox_instance_alive',
      credits,
      metadata: {
        sandboxId: params.sandboxId,
        elapsedMs: params.elapsedMs,
        microCredits,
        billedToMs,
        actionRef: idempotencyKey,
        // The unit of the `credits` value on THIS event type. Stated on the row
        // so an aggregation over usage_events does not have to guess which of
        // the column's several units it is summing.
        unit: 'milli_usd',
      },
    });

    log.info({
      message: 'sandbox instance-alive bill',
      sandboxId: params.sandboxId,
      tenantId: params.tenantId,
      elapsedMs: params.elapsedMs,
      microCredits,
      credits,
      billedToMs,
    });
  }
}
