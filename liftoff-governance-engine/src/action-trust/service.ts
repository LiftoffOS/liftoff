// Action-trust service. Two reads of the same (tenant, agent, action_class) trust standing,
// both SHADOW / read-only (they never change a gate today):
//
//  - getTrust (the one the router's GET / SERVES): computes the tier on-read
//    from the ingested decisions ledger (action_trust_decisions, via computeTrust) using the
//    calibrated operating points from the calibration loop, falling back to env overrides.
//    POST /decisions feeds its ledger; the shadow HITL gate + the autonomy advisor consume it.
//  - getAgentActionTrust: reads the SEPARATE pre-computed rollup table `agent_action_trust`
//    (written by the rollup job src/jobs/trust-rollup, from the `actions` WAL + HITL
//    rejections). A parallel substrate with its own tests; NOT served on GET / (the trust
//    endpoint is decisions-derived). Kept intact for reconnection if the rollup is later
//    chosen as the canonical source.
//
// Env for getTrust (REQUIRED, no shipped defaults; unset ⇒ null so the endpoint 404s and
// uncalibrated numbers never leak into shadow logs):
//   TRUST_WINDOW_DAYS, TRUST_MIN_RUNS, TRUST_AUTO_PASS_RATE, TRUST_QUEUE_PASS_RATE

import { withTenantScope } from '../infrastructure/database';
import { computeTrust } from './repository';
import { calibrationStore } from '../calibration/repository';
import { normalizeActionClass } from './normalize';
import { passRateOf, type TrustTier } from './tier';
import type { TrustResult } from './types';

export interface AgentActionTrust {
  tier: TrustTier;
  runs: number;
  passRate: number;
}

interface TrustRow {
  runs: number;
  passes: number;
  rejects: number;
  tier: string;
}

/**
 * Look up the trust standing for a single (tenant, agent, action_class) from the rollup.
 * `actionClass` is normalized the same way the rollup stores it, so callers may pass
 * either a bare action or a dispatch-prefixed tool name. Returns null when the rollup has
 * never recorded that triple.
 */
export async function getAgentActionTrust(
  tenantId: string,
  agentId: string,
  actionClass: string,
): Promise<AgentActionTrust | null> {
  const normalized = normalizeActionClass(actionClass);
  if (!normalized) return null;

  return withTenantScope(tenantId, async (client) => {
    const result = await client.query<TrustRow>(
      `SELECT runs, passes, rejects, tier
         FROM agent_action_trust
        WHERE tenant_id = $1 AND agent_id = $2 AND action_class = $3
        LIMIT 1`,
      [tenantId, agentId, normalized],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      tier: row.tier as TrustTier,
      runs: row.runs,
      passRate: passRateOf(row.runs, row.passes),
    };
  });
}

function envNum(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Decisions-native tier compute. null when the constants are unset OR runs < TRUST_MIN_RUNS.
 *
 * The two pass-rate operating points come from the calibration loop's IN-FORCE value for this
 * tenant (the most recent run — a promote, or a rollback that reverted it); otherwise they fall
 * back to the env override, else stay unset. Cold start (no calibrated value + no env) therefore
 * returns null ⇒ 404 ⇒ never-auto-clear — uncalibrated numbers never leak. Reading the in-force
 * value (not the last promote) is what lets an auto-rollback of a too-loose threshold take effect. */
export async function getTrust(
  tenantId: string,
  agentId: string,
  actionClass: string,
): Promise<TrustResult | null> {
  const windowDays = envNum('TRUST_WINDOW_DAYS');
  const minRuns = envNum('TRUST_MIN_RUNS');
  const [calibratedAuto, calibratedQueue] = await Promise.all([
    calibrationStore.currentValue(tenantId, 'TRUST_AUTO_PASS_RATE'),
    calibrationStore.currentValue(tenantId, 'TRUST_QUEUE_PASS_RATE'),
  ]);
  const autoRate = calibratedAuto ?? envNum('TRUST_AUTO_PASS_RATE');
  const queueRate = calibratedQueue ?? envNum('TRUST_QUEUE_PASS_RATE');
  if (windowDays === undefined || minRuns === undefined || autoRate === undefined || queueRate === undefined) {
    return null;
  }
  const { runs, passRate, distinctApprovers } = await computeTrust(tenantId, agentId, actionClass, windowDays);
  if (runs < minRuns) return null;
  const tier: TrustResult['tier'] = passRate >= autoRate ? 'auto' : passRate >= queueRate ? 'queue' : 'watch';
  return { tier, runs, passRate, distinctApprovers };
}
