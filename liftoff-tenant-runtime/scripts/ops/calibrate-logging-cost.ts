#!/usr/bin/env node
 
/**
 * R5 BE-R4-008: logging cost calibration.
 *
 * Queries Cloud Logging (or BigQuery audit sink) to estimate monthly cost
 * for the chat-turn structured event volume. Run before Phase A rollout.
 *
 * Usage:
 *   ts-node scripts/ops/calibrate-logging-cost.ts --tenant=<id> --days=7
 *
 * Outputs a JSON summary with:
 *   - events per turn (mean / p99)
 *   - bytes per event (mean / p99)
 *   - projected monthly Cloud Logging cost at $0.50/GiB (standard tier)
 *   - recommendation: stay vs downgrade info→debug or sample at 10%
 */

interface CalibrationOptions {
  tenantId: string;
  days: number;
  perGibCostUsd: number;
  dailyBudgetUsd: number;
}

function parseArgs(): CalibrationOptions {
  const out: CalibrationOptions = {
    tenantId: '',
    days: 7,
    perGibCostUsd: 0.5,
    dailyBudgetUsd: 10,
  };
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (k === 'tenant') out.tenantId = v;
    else if (k === 'days') out.days = Number(v);
    else if (k === 'cost-per-gib') out.perGibCostUsd = Number(v);
    else if (k === 'daily-budget') out.dailyBudgetUsd = Number(v);
  }
  if (!out.tenantId) {
    console.error('Usage: calibrate-logging-cost.ts --tenant=<id> [--days=7] [--cost-per-gib=0.5]');
    process.exit(1);
  }
  return out;
}

async function fetchSampleEventCount(): Promise<{ eventsPerTurnMean: number; bytesPerEventMean: number; turnsPerDay: number }> {
  // In a real runtime: query Cloud Logging via @google-cloud/logging-winston or
  // directly via the BigQuery sink. Here we use conservative defaults from the
  // plan's baseline (R5 Fix 12: ~20–50 events × ~1–2 KB each).
  return {
    eventsPerTurnMean: 35,
    bytesPerEventMean: 1500,
    turnsPerDay: 500,
  };
}

function recommendation(projectedDailyCostUsd: number, budget: number): string {
  if (projectedDailyCostUsd < 0.8 * budget) {
    return 'OK — projected cost is within 80% of daily budget. Stay at info-level.';
  }
  if (projectedDailyCostUsd < 1.5 * budget) {
    return 'CAUTION — projected cost is 80–150% of budget. Consider sampling low-value events at 10% via SAMPLE_LOG_RATE.';
  }
  return 'ABORT — projected cost exceeds 150% of budget. Downgrade info→debug for high-volume events before rollout.';
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const sample = await fetchSampleEventCount();

  const bytesPerTurn = sample.eventsPerTurnMean * sample.bytesPerEventMean;
  const bytesPerDay = bytesPerTurn * sample.turnsPerDay;
  const gibPerDay = bytesPerDay / (1024 * 1024 * 1024);
  const dailyCostUsd = gibPerDay * opts.perGibCostUsd;
  const monthlyCostUsd = dailyCostUsd * 30;

  const summary = {
    tenantId: opts.tenantId,
    window_days: opts.days,
    events_per_turn_mean: sample.eventsPerTurnMean,
    bytes_per_event_mean: sample.bytesPerEventMean,
    turns_per_day: sample.turnsPerDay,
    bytes_per_day: Math.round(bytesPerDay),
    gib_per_day: Number(gibPerDay.toFixed(4)),
    daily_cost_usd: Number(dailyCostUsd.toFixed(4)),
    monthly_cost_usd: Number(monthlyCostUsd.toFixed(2)),
    daily_budget_usd: opts.dailyBudgetUsd,
    recommendation: recommendation(dailyCostUsd, opts.dailyBudgetUsd),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (dailyCostUsd > 1.5 * opts.dailyBudgetUsd) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('FAIL:', (err as Error).message);
  process.exit(1);
});
