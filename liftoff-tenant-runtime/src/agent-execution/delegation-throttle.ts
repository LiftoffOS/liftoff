// Part 5 §F — soft-throttle on shared-resource backpressure.
//
// Adds inter-batch sleep to the delegateToAgents fan-out when either:
//   • Anthropic agent-execution pool 429 rate exceeds 5% (60s window)
//   • Shared Cloud SQL connection pool utilization exceeds 85%
// Never rejects work; never lowers max_concurrent. Throughput stays at the
// tenant's configured cap; the only effect is small inter-batch sleeps
// that smooth simultaneous bursts.
//
// Hampering tenant usage hampers their OU spend, which is our revenue.
// The throttle protects shared infrastructure, not tenant wallets.

import { getPoolForService } from '../infrastructure/database';
import { getAnthropicPool429Rate } from '../llm/anthropic-pool-stats';
import { logger as log } from '../infrastructure/logging';
import {
  delegation_soft_throttle_engaged_total,
  delegation_soft_throttle_backoff_ms,
  delegation_shared_db_utilization,
  delegation_anthropic_pool_429_rate,
} from '../observability/runtime-extensions-metrics';

// Thresholds for entering "backoff" mode. Both are soft — exceeding them only
// adds inter-batch sleep, never rejects work.
const THROTTLE_THRESHOLDS = {
  ANTHROPIC_429_RATE: 0.05,         // 5% of agent-execution pool requests 429'd in last 60s
  CLOUD_SQL_POOL_UTILIZATION: 0.85, // 85% of max_connections in use
};

// Backoff curve: how long to sleep between batches when throttled.
// Multiplicative on consecutive throttled batches, capped.
const BACKOFF = {
  INITIAL_MS: 250,
  MAX_MS: 5_000,
  MULTIPLIER: 2,
};

export interface ThrottleState {
  consecutiveThrottledBatches: number;
  lastBackoffMs: number;
}

/**
 * Check shared-resource pressure and return the sleep-ms to insert before
 * the next p-limit batch. Zero when both signals are below threshold.
 */
export async function computeThrottleDelay(state: ThrottleState): Promise<number> {
  const pool = getPoolForService('default');

  // Anthropic agent-execution pool 429 rate (1-minute rolling window).
  const anthropic429Rate = getAnthropicPool429Rate('agent-execution', 60_000);

  // Cloud SQL pool utilization. Requires the tenant-runtime DB role to hold
  // `pg_monitor` so it sees every backend, not just its own. Grant via:
  //   GRANT pg_monitor TO liftoff_app;
  // (apply once per environment; idempotent). Without pg_monitor the query
  // returns this connection only, which makes utilization look near-zero and
  // the throttle never fires.
  const dbUtilizationRow = await pool.query<{ utilization: number }>(
    `SELECT (count(*)::float / current_setting('max_connections')::float) AS utilization
     FROM pg_stat_activity
     WHERE state IS NOT NULL`,
  );
  const dbUtilization = dbUtilizationRow.rows[0]?.utilization ?? 0;

  // Part 7 §A — sample the two pressure signals as gauges each tick.
  delegation_anthropic_pool_429_rate.set(anthropic429Rate);
  delegation_shared_db_utilization.set(dbUtilization);

  const throttled =
    anthropic429Rate > THROTTLE_THRESHOLDS.ANTHROPIC_429_RATE ||
    dbUtilization > THROTTLE_THRESHOLDS.CLOUD_SQL_POOL_UTILIZATION;

  if (!throttled) {
    state.consecutiveThrottledBatches = 0;
    state.lastBackoffMs = 0;
    return 0;
  }

  const nextBackoff = Math.min(
    BACKOFF.MAX_MS,
    state.lastBackoffMs === 0
      ? BACKOFF.INITIAL_MS
      : state.lastBackoffMs * BACKOFF.MULTIPLIER,
  );
  state.consecutiveThrottledBatches++;
  state.lastBackoffMs = nextBackoff;

  log.warn({
    message: 'delegation soft-throttle engaged',
    anthropic429Rate,
    dbUtilization,
    nextBackoffMs: nextBackoff,
    consecutiveBatches: state.consecutiveThrottledBatches,
  });
  delegation_soft_throttle_engaged_total.inc();
  delegation_soft_throttle_backoff_ms.observe(nextBackoff);

  return nextBackoff;
}
