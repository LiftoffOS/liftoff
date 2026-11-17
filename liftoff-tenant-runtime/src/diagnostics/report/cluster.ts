// Cross-run failure-mode clustering, ranked by frequency × severity. Groups
// findings (and RCA attributions) across a batch of runs into clusters keyed by
// the MAST/TRAIL failureMode label + the engine stage, so the report surfaces
// "the top ways this agent breaks" rather than a flat finding list.

import type { Severity } from '../reconstruct/trace-model';
import type { EvaluatedRun } from '../analyze/evaluate';
import { normalizeFailureMode, describeCode, type TaxonomyCode } from '../analyze/taxonomy';

const SEVERITY_WEIGHT: Record<Severity, number> = { info: 0, warn: 1, error: 3, critical: 5 };

export interface FailureCluster {
  /** Cluster key: `${taxonomyCode}@${stage}`. */
  key: string;
  /** Canonical MAST/TRAIL code the cluster groups by. */
  failureMode: TaxonomyCode;
  /** Human description of the taxonomy code. */
  taxonomy: string;
  stage: string;
  /** Number of runs exhibiting this failure mode. */
  frequency: number;
  /** Max severity weight observed in the cluster. */
  severityWeight: number;
  /** frequency × severityWeight — the ranking score. */
  score: number;
  /** Representative invariants + example evidence. */
  invariants: string[];
  exampleMessages: string[];
  /** RCA fix suggestions gathered for this cluster (deduped). */
  fixSuggestions: string[];
}

export function clusterFailures(runs: EvaluatedRun[]): FailureCluster[] {
  const byKey = new Map<string, FailureCluster & { _runs: Set<string> }>();

  for (const r of runs) {
    const runKey = r.ref.key;
    for (const f of r.findings) {
      if (f.severity === 'info') continue;
      const code = normalizeFailureMode(f.failureMode);
      const key = `${code}@${f.component}`;
      let c = byKey.get(key);
      if (!c) {
        c = {
          key,
          failureMode: code,
          taxonomy: describeCode(code),
          stage: f.component,
          frequency: 0,
          severityWeight: 0,
          score: 0,
          invariants: [],
          exampleMessages: [],
          fixSuggestions: [],
          _runs: new Set<string>(),
        };
        byKey.set(key, c);
      }
      c._runs.add(runKey);
      c.severityWeight = Math.max(c.severityWeight, SEVERITY_WEIGHT[f.severity]);
      if (!c.invariants.includes(f.invariant)) c.invariants.push(f.invariant);
      if (c.exampleMessages.length < 3) c.exampleMessages.push(f.message);
      // Attach the run's RCA fix suggestion to the matching failure-mode cluster.
      if (r.rca && normalizeFailureMode(r.rca.failureMode) === code && r.rca.fixSuggestion && !c.fixSuggestions.includes(r.rca.fixSuggestion)) {
        c.fixSuggestions.push(r.rca.fixSuggestion);
      }
    }
  }

  const clusters: FailureCluster[] = [];
  for (const c of byKey.values()) {
    c.frequency = c._runs.size;
    c.score = c.frequency * c.severityWeight;
    const { _runs, ...rest } = c;
    void _runs;
    clusters.push(rest);
  }
  // Ranked by frequency × severity, descending.
  clusters.sort((a, b) => b.score - a.score);
  return clusters;
}
