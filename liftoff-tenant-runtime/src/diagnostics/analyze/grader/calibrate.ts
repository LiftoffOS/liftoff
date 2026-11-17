// Grader calibration against a small internal human-labeled set.
//
// Compares stored grader scores to human_score labels, grouped into cohorts by
// effective_config_hash so scores produced under different prompts/models are
// never mixed. Statistics that are undefined for the sample (n<2, or a constant
// vector) are reported as null rather than NaN. Reports carry a unique run id
// and hold NO tenant/session identifiers — only aggregates.

import { z } from 'zod';
import { Storage } from '@google-cloud/storage';
import type { GradeResult } from './score';

export const LabeledGraderSetZ = z.array(
  z.object({
    session_id: z.string(),
    tenant_id: z.string(),
    agent_id: z.string(),
    agent_kind: z.literal('user-created'),
    human_score: z.number().min(0).max(100),
    notes: z.string().optional(),
  }),
);
export type LabeledGraderRow = z.infer<typeof LabeledGraderSetZ>[number];

export interface CalibrationReport {
  calibration_run_id: string;
  computed_at: string;
  n_labels: number;
  cohort_config_hash: string;
  pearson_r: number | null;
  spearman_rho: number | null;
  mae: number | null;
  mean_spread: number | null;
  per_judge_bias: Record<string, number>;
  score_prompt_version: string;
}

/** Load a labeled set from a local path or a gs:// URI. */
export async function loadLabeledGraderSet(path: string): Promise<LabeledGraderRow[]> {
  let raw: string;
  const gs = /^gs:\/\/([^/]+)\/(.+)$/.exec(path);
  if (gs) {
    const [buf] = await new Storage().bucket(gs[1]).file(gs[2]).download();
    raw = buf.toString('utf8');
  } else {
    const fs = await import('fs/promises');
    raw = await fs.readFile(path, 'utf8');
  }
  return LabeledGraderSetZ.parse(JSON.parse(raw));
}

/** GET a session's stored grade object (one NDJSON row). Null when absent. */
export async function fetchStoredGrade(bucket: string, sessionId: string): Promise<GradeResult | null> {
  try {
    const [buf] = await new Storage().bucket(bucket).file(`diagnostics/grades/${sessionId}.ndjson`).download();
    const line = buf.toString('utf8').split('\n').find((l) => l.trim().length > 0);
    if (!line) return null;
    const row = JSON.parse(line) as GradeResult & { judges: string };
    // The sink JSON-stringifies `judges`; parse it back for bias computation.
    if (typeof (row as { judges: unknown }).judges === 'string') {
      (row as unknown as { judges: unknown }).judges = JSON.parse((row as unknown as { judges: string }).judges);
    }
    return row as GradeResult;
  } catch {
    return null;
  }
}

// ── statistics (null-safe) ──────────────────────────────────────────────────

function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }

export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = mean(xs), my = mean(ys);
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
  if (vx === 0 || vy === 0) return null; // constant vector → undefined correlation
  return cov / Math.sqrt(vx * vy);
}

function rank(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // average rank for ties (1-based)
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length < 2) return null;
  return pearson(rank(xs), rank(ys));
}

export function meanAbsError(xs: number[], ys: number[]): number | null {
  if (xs.length === 0) return null;
  return mean(xs.map((x, i) => Math.abs(x - ys[i])));
}

/** Group by effective_config_hash and compute one report per cohort. */
export function calibrateCohorts(
  pairs: Array<{ human: number; grade: GradeResult }>,
  calibrationRunId: string,
  computedAt: string,
): CalibrationReport[] {
  const byCohort = new Map<string, Array<{ human: number; grade: GradeResult }>>();
  for (const p of pairs) {
    const key = p.grade.effective_config_hash;
    (byCohort.get(key) ?? byCohort.set(key, []).get(key)!).push(p);
  }
  const reports: CalibrationReport[] = [];
  for (const [hash, group] of byCohort) {
    const human = group.map((g) => g.human);
    const grades = group.map((g) => g.grade.score);
    const spreads = group.map((g) => g.grade.spread);
    // Per-judge bias: (judge total − human) averaged per requested judge spec.
    const biasSum = new Map<string, { sum: number; n: number }>();
    for (const g of group) {
      for (const j of g.grade.judges) {
        const b = biasSum.get(j.judge) ?? { sum: 0, n: 0 };
        b.sum += j.total - g.human;
        b.n += 1;
        biasSum.set(j.judge, b);
      }
    }
    const perJudgeBias: Record<string, number> = {};
    for (const [judge, b] of biasSum) perJudgeBias[judge] = b.n ? b.sum / b.n : 0;
    reports.push({
      calibration_run_id: calibrationRunId,
      computed_at: computedAt,
      n_labels: group.length,
      cohort_config_hash: hash,
      pearson_r: pearson(grades, human),
      spearman_rho: spearman(grades, human),
      mae: meanAbsError(grades, human),
      mean_spread: spreads.length ? mean(spreads) : null,
      per_judge_bias: perJudgeBias,
      score_prompt_version: group[0].grade.score_prompt_version,
    });
  }
  return reports;
}
