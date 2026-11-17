// B6 — per-agent benchmark compute (backend only; nothing is surfaced in any UI).
//
// Reads the EXISTING agent_performance_snapshots table (no new tables) and returns, per ACTIVE
// agent, the latest value of each metric plus a DIRECTION-NORMALIZED trend over the trailing
// window. success_rate / autonomy_rate improve UPWARD; correction_rate / escalation_rate
// improve DOWNWARD — the API returns `trend='improving'` when the agent got BETTER, whichever
// way the raw number moved, so a consumer never has to know each metric's polarity.

import { Router, type Request, type Response } from 'express';
import { pool } from '../infrastructure/database';
import { requireServiceAuth } from '../security/service-auth';
import { logger } from '../infrastructure/logging';

export type MetricTrend = 'improving' | 'declining' | 'stable';

// Metric keys whose RAW value improves when it goes UP. Everything else improves going DOWN.
const HIGHER_IS_BETTER = new Set(['taskSuccess', 'autonomy']);

/** Normalize a raw latest-vs-baseline move into better/worse/flat for THIS metric's polarity.
 *
 *  NULL in, null out. `autonomy_rate` is nullable (migration 374) and null means
 *  UNKNOWN, so a null endpoint has no direction to report. Coercing it to 0 first
 *  produced `normalizeTrend(k, 0, 0)` → 'stable', which renders an agent nobody
 *  has a number for as "no change" — a positive claim built out of an absence. */
export function normalizeTrend(
  metricKey: string,
  latest: number | null,
  baseline: number | null,
  epsilon = 0.02,
): MetricTrend | null {
  if (latest === null || baseline === null) return null;
  const delta = latest - baseline;
  if (Math.abs(delta) < epsilon) return 'stable';
  const wentUp = delta > 0;
  const better = HIGHER_IS_BETTER.has(metricKey) ? wentUp : !wentUp;
  return better ? 'improving' : 'declining';
}

/** A trend is null when one of its endpoints is unknown. In practice only
 *  `autonomy` reaches that today — it is the one nullable rate column (migration
 *  374) — but the field is typed uniformly so a consumer handles absence the same
 *  way whichever metric it came from, rather than learning per-metric which ones
 *  are allowed to be missing. */
export interface AgentBenchmark {
  agentId: string;
  name: string;
  metrics: {
    taskSuccess: { value: number; trend: MetricTrend | null };
    /** value/trend are null when autonomy is unknown for this agent — see
     *  performance-tracker's header. Never coerce either to 0/'stable'. */
    autonomy: { value: number | null; trend: MetricTrend | null };
    escalations: { value: number; trend: MetricTrend | null };
    corrections: { value: number; trend: MetricTrend | null };
  };
}

export async function computeAgentBenchmarks(tenantId: string, weeks: number): Promise<AgentBenchmark[]> {
  const { rows } = await pool.query<{
    agent_id: string; name: string;
    latest_success: string | null; latest_autonomy: string | null; latest_escalation: string | null; latest_correction: string | null;
    base_success: string | null; base_autonomy: string | null; base_escalation: string | null; base_correction: string | null;
  }>(
    `WITH ranked AS (
       SELECT s.agent_id, a.name,
         s.success_rate, s.autonomy_rate, s.escalation_rate, s.correction_rate,
         row_number() OVER (PARTITION BY s.agent_id ORDER BY s.period_start DESC) AS rn_desc,
         row_number() OVER (PARTITION BY s.agent_id ORDER BY s.period_start ASC)  AS rn_asc
       FROM agent_performance_snapshots s
       JOIN agents a ON a.id = s.agent_id
       WHERE s.tenant_id = $1 AND a.lifecycle = 'ACTIVE'
         AND s.period_start >= now() - ($2 || ' weeks')::interval
     )
     SELECT agent_id, max(name) AS name,
       max(success_rate)    FILTER (WHERE rn_desc = 1) AS latest_success,
       max(autonomy_rate)   FILTER (WHERE rn_desc = 1) AS latest_autonomy,
       max(escalation_rate) FILTER (WHERE rn_desc = 1) AS latest_escalation,
       max(correction_rate) FILTER (WHERE rn_desc = 1) AS latest_correction,
       max(success_rate)    FILTER (WHERE rn_asc = 1) AS base_success,
       max(autonomy_rate)   FILTER (WHERE rn_asc = 1) AS base_autonomy,
       max(escalation_rate) FILTER (WHERE rn_asc = 1) AS base_escalation,
       max(correction_rate) FILTER (WHERE rn_asc = 1) AS base_correction
     FROM ranked
     GROUP BY agent_id`,
    [tenantId, String(weeks)],
  );

  const n = (v: unknown): number => Number(v ?? 0);
  // autonomy_rate admits NULL (migration 374) and NULL means unknown. `n` folds
  // it to 0, and 0 on this metric reads as complete dependence on a person — so
  // the one column that can be absent gets a null-preserving reader instead.
  const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return rows.map((r) => ({
    agentId: r.agent_id,
    name: r.name,
    metrics: {
      taskSuccess: { value: n(r.latest_success), trend: normalizeTrend('taskSuccess', n(r.latest_success), n(r.base_success)) },
      autonomy: { value: nOrNull(r.latest_autonomy), trend: normalizeTrend('autonomy', nOrNull(r.latest_autonomy), nOrNull(r.base_autonomy)) },
      escalations: { value: n(r.latest_escalation), trend: normalizeTrend('escalations', n(r.latest_escalation), n(r.base_escalation)) },
      corrections: { value: n(r.latest_correction), trend: normalizeTrend('corrections', n(r.latest_correction), n(r.base_correction)) },
    },
  }));
}

export const agentBenchmarksRouter = Router();

// GET /api/internal/agent-benchmarks?tenantId&weeks=N  (service-auth; called cross-service).
agentBenchmarksRouter.get('/agent-benchmarks', requireServiceAuth(), async (req: Request, res: Response) => {
  const tenantId = String(req.query.tenantId ?? '');
  const weeks = Math.min(52, Math.max(1, Number(req.query.weeks ?? 8)));
  if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
  try {
    const agents = await computeAgentBenchmarks(tenantId, weeks);
    return res.json({ agents });
  } catch (err) {
    logger.error({ err: (err as Error).message, tenantId }, 'agent-benchmarks compute failed');
    return res.status(500).json({ error: 'benchmarks_failed' });
  }
});
