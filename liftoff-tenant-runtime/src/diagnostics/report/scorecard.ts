// Per-agent scorecard across the four first-class dimensions, aggregated from a
// batch of EvaluatedRuns. Goal-success / spec-conformance / trajectory&efficiency
// / failure-localization — the report the understanding layer produces.

import type { AgentKind } from '../reconstruct/trace-model';
import type { EvaluatedRun } from '../analyze/evaluate';

export interface AgentScorecard {
  agentKind: AgentKind;
  tenantId: string;
  agentId: string;
  /** ISO timestamp the scorecard was computed (stamped by the caller). */
  computedAt: string;
  runCount: number;
  /** Deterministic gating dimension. */
  gatingFailureRate: number; // fraction of runs with an error/critical finding
  invariantFindingCount: number;
  /** Trajectory & efficiency. */
  avgToolCorrectness: number | null;
  avgStepEfficiency: number;
  loopRate: number;
  avgCostUsd: number | null;
  avgLatencyMs: number | null;
  /** Semantic dimensions (advisory; present only when judges ran). */
  goalSuccessRate: number | null;
  specConformanceRate: number | null;
  /** Argument scoring — deterministic validity (mean over scoreable runs) +
   *  advisory appropriateness (judge pass-rate). Null when nothing scoreable. */
  avgArgValidity: number | null;
  argAppropriatenessRate: number | null;
  /** Deliverable grader (0-100 scale). Null when no run in the batch was graded. */
  avgDeliverableScore: number | null;
  gradedRunCount: number;
  /** Failure-localization: counts of findings by component stage. */
  findingsByStage: Record<string, number>;
}

export function buildScorecard(
  agentKind: AgentKind,
  tenantId: string,
  agentId: string,
  runs: EvaluatedRun[],
  computedAt: string,
): AgentScorecard {
  const n = runs.length;
  const gatingFailures = runs.filter((r) => r.gating).length;
  let invariantFindingCount = 0;
  const findingsByStage: Record<string, number> = {};
  let toolCorrSum = 0;
  let toolCorrN = 0;
  let stepEffSum = 0;
  let loopCount = 0;
  let costSum = 0;
  let costN = 0;
  let latSum = 0;
  let latN = 0;
  let goalPass = 0;
  let goalN = 0;
  let confPass = 0;
  let confN = 0;
  let argValSum = 0;
  let argValN = 0;
  let argJudgePass = 0;
  let argJudgeN = 0;
  let deliverableSum = 0;
  let deliverableN = 0;

  for (const r of runs) {
    invariantFindingCount += r.findings.length;
    for (const f of r.findings) findingsByStage[f.component] = (findingsByStage[f.component] ?? 0) + 1;
    if (r.metrics.toolCorrectness != null) {
      toolCorrSum += r.metrics.toolCorrectness;
      toolCorrN++;
    }
    stepEffSum += r.metrics.stepEfficiency;
    if (r.metrics.loopDetected) loopCount++;
    if (r.metrics.costUsd != null) {
      costSum += r.metrics.costUsd;
      costN++;
    }
    if (r.metrics.latencyMs != null) {
      latSum += r.metrics.latencyMs;
      latN++;
    }
    if (r.goal && !r.goal.unavailable) {
      goalN++;
      if (r.goal.pass) goalPass++;
    }
    if (r.conformanceJudge && !r.conformanceJudge.unavailable) {
      confN++;
      if (r.conformanceJudge.pass) confPass++;
    }
    if (r.argValidity && r.argValidity.score != null) {
      argValSum += r.argValidity.score;
      argValN++;
    }
    if (r.argJudge && !r.argJudge.unavailable) {
      argJudgeN++;
      if (r.argJudge.pass) argJudgePass++;
    }
    if (r.grade) {
      deliverableSum += r.grade.score;
      deliverableN++;
    }
  }

  return {
    agentKind,
    tenantId,
    agentId,
    computedAt,
    runCount: n,
    gatingFailureRate: n ? gatingFailures / n : 0,
    invariantFindingCount,
    avgToolCorrectness: toolCorrN ? toolCorrSum / toolCorrN : null,
    avgStepEfficiency: n ? stepEffSum / n : 1,
    loopRate: n ? loopCount / n : 0,
    avgCostUsd: costN ? costSum / costN : null,
    avgLatencyMs: latN ? latSum / latN : null,
    goalSuccessRate: goalN ? goalPass / goalN : null,
    specConformanceRate: confN ? confPass / confN : null,
    avgArgValidity: argValN ? argValSum / argValN : null,
    argAppropriatenessRate: argJudgeN ? argJudgePass / argJudgeN : null,
    avgDeliverableScore: deliverableN ? deliverableSum / deliverableN : null,
    gradedRunCount: deliverableN,
    findingsByStage,
  };
}
