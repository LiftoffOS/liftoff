// Did the refinement help?
//
// This job answers that for each applied suggestion by invoking
// `recordSuggestionOutcome`, which writes the columns migration 063 added:
// `applied_at`, `applied_by`, `effective_measure`, `feedback`.
//
// The reachability gate checks exports rather than class members, so a public
// method on a reached class is not covered by it. That is worth knowing about
// the gate as much as about this method.
//
// WHAT IT MEASURES. `expected_outcome` names an observable the reflection said
// should change. The comparison here is deliberately narrow and mechanical: the
// agent's failure rate over the runs before the suggestion was applied, against
// the runs after. A suggestion that cannot be judged that way is recorded as
// `no_change` with the reason, not guessed at — an outcome invented to fill a
// column is worse than an empty one, because it would then be used.

import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { ReflectionEngineService } from '../reflection-engine/service';

/** How long an applied suggestion is left before it is judged.
 *
 *  Long enough for the agent to have run under the change: judging it an hour
 *  after apply measures noise. */
const SETTLE_HOURS = 24;

/** Runs needed on each side of the change before a comparison means anything.
 *  Below this the rate is one or two outcomes, and calling that "improved" or
 *  "degraded" would be reading a coin flip. */
const MIN_RUNS_PER_SIDE = 5;

/** How much the failure rate must move to be called a change rather than noise.
 *  Ten points on a rate built from at least five runs a side. */
const MATERIAL_DELTA = 0.10;

export interface OutcomeClosureResult {
  assessed: number;
  improved: number;
  degraded: number;
  noChange: number;
  insufficientData: number;
}

export async function runReflectionOutcomeClosure(
  opts: { limit?: number } = {},
): Promise<OutcomeClosureResult> {
  const pool = getPoolForService('reflection-engine');
  const service = new ReflectionEngineService();
  const result: OutcomeClosureResult = {
    assessed: 0, improved: 0, degraded: 0, noChange: 0, insufficientData: 0,
  };

  const pending = await service.suggestionsAwaitingOutcome(SETTLE_HOURS, opts.limit ?? 50);
  for (const s of pending) {
    try {
      const before = await failureRate(pool, s.agentId, s.appliedAt, 'before');
      const after = await failureRate(pool, s.agentId, s.appliedAt, 'after');

      if (before === null || after === null) {
        result.insufficientData += 1;
        // Recorded, not skipped. A suggestion left unjudged forever is
        // indistinguishable from one nobody has got to yet, and the whole point
        // is to stop having a column nothing ever fills.
        await service.recordSuggestionOutcome(s.id, {
          applied: true,
          effectiveMeasure: 'no_change',
          feedback: `Not enough runs to judge (need ${MIN_RUNS_PER_SIDE} either side of the change).`
            + (s.expectedOutcome ? ` Expected: ${s.expectedOutcome}` : ''),
        });
        result.assessed += 1;
        continue;
      }

      const delta = before - after;   // positive = fewer failures after
      const measure: 'improved' | 'no_change' | 'degraded' =
        delta >= MATERIAL_DELTA ? 'improved'
          : delta <= -MATERIAL_DELTA ? 'degraded'
            : 'no_change';

      await service.recordSuggestionOutcome(s.id, {
        applied: true,
        effectiveMeasure: measure,
        feedback: `Failure rate ${(before * 100).toFixed(0)}% before, ${(after * 100).toFixed(0)}% after.`
          + (s.expectedOutcome ? ` Expected: ${s.expectedOutcome}` : ''),
      });
      result.assessed += 1;
      if (measure === 'improved') result.improved += 1;
      else if (measure === 'degraded') result.degraded += 1;
      else result.noChange += 1;
    } catch (err) {
      logger.warn(
        { suggestionId: s.id, error: (err as Error).message },
        'could not close the outcome for one reflection suggestion',
      );
    }
  }

  logger.info({ event: 'reflection_outcome_closure', ...result }, 'reflection outcomes assessed');
  return result;
}

/** The agent's failure rate over the runs on one side of `appliedAt`.
 *
 *  Null when there were fewer than MIN_RUNS_PER_SIDE — the honest answer to "did
 *  this help?" when there is not enough evidence is "cannot tell", and returning
 *  a rate built from two runs would let noise be recorded as a verdict. */
async function failureRate(
  pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ total: string; failed: string }> }> },
  agentId: string,
  appliedAt: Date,
  side: 'before' | 'after',
): Promise<number | null> {
  const comparison = side === 'before' ? '<' : '>=';
  const r = await pool.query(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE outcome = 'error')::text AS failed
       FROM invocations
      WHERE agent_id = $1 AND completed_at IS NOT NULL AND completed_at ${comparison} $2`,
    [agentId, appliedAt],
  );
  const total = Number(r.rows[0]?.total ?? 0);
  const failed = Number(r.rows[0]?.failed ?? 0);
  if (!Number.isFinite(total) || total < MIN_RUNS_PER_SIDE) return null;
  return failed / total;
}
