// Judge calibration — Cohen's κ between the LLM-judge verdict and a
// human-labeled set, per the plan: "calibrated against a human-labeled set
// (Cohen's κ) before scores gate." Until κ clears the trust threshold, judge
// scores stay advisory (they never gate regardless; this governs whether their
// alerts are trusted / surfaced as regressions).

import type { AgentKind, ReconstructedRun } from '../../reconstruct/trace-model';
import { judgeGoalSuccess } from './goal';
import { judgeSpecConformance } from './conformance';
import { judgeArgumentAppropriateness } from './arguments';

/** κ ≥ this is "substantial agreement" (Landis & Koch) — the gate for trusting
 *  a judge's regression alerts. */
export const KAPPA_TRUST_THRESHOLD = 0.6;

export interface LabeledRun {
  agentKind: AgentKind;
  tenantId: string;
  agentId: string;
  key: string;
  /** Optional stable id for per-fixture diagnostics (golden set). Falls back to key. */
  id?: string;
  /** Human ground-truth labels. */
  goalPass?: boolean;
  conformancePass?: boolean;
  argAppropriatenessPass?: boolean;
  /** Optional inline run — when present the calibrator scores THIS run directly
   *  instead of reconstructing from storage (drives the synthetic golden set;
   *  see golden-fixtures.ts). */
  run?: ReconstructedRun;
}

export interface BinaryPair {
  human: boolean;
  judge: boolean;
}

/** Cohen's κ for two binary raters. Returns NaN for an empty set. */
export function computeCohenKappa(pairs: BinaryPair[]): number {
  const n = pairs.length;
  if (n === 0) return NaN;
  let agree = 0;
  let humanPos = 0;
  let judgePos = 0;
  for (const p of pairs) {
    if (p.human === p.judge) agree++;
    if (p.human) humanPos++;
    if (p.judge) judgePos++;
  }
  const po = agree / n;
  const pHumanPos = humanPos / n;
  const pJudgePos = judgePos / n;
  // Expected agreement by chance.
  const pe = pHumanPos * pJudgePos + (1 - pHumanPos) * (1 - pJudgePos);
  if (pe === 1) return 1; // degenerate: all same label both raters
  return (po - pe) / (1 - pe);
}

export interface CalibrationResult {
  dimension: 'goal' | 'conformance' | 'arg_appropriateness';
  n: number;
  kappa: number;
  trusted: boolean;
}

/** Run the judges over a labeled set and report κ per dimension. The caller
 *  supplies a reconstruct function so this module stays adapter-agnostic. */
export async function calibrateJudges(
  labeled: LabeledRun[],
  reconstruct: (l: LabeledRun) => Promise<ReconstructedRun | null>,
  /** Called for every scored (fixture, dimension) so callers can log where the
   *  judge agreed/disagreed and why — the per-fixture diagnostic behind κ. */
  onVerdict?: (v: {
    dimension: CalibrationResult['dimension'];
    id: string; human: boolean; judge: boolean; reasoning: string;
  }) => void,
): Promise<CalibrationResult[]> {
  const goalPairs: BinaryPair[] = [];
  const confPairs: BinaryPair[] = [];
  const argPairs: BinaryPair[] = [];

  for (const l of labeled) {
    const run = await reconstruct(l);
    if (!run) continue;
    const id = l.id ?? l.key;
    if (l.goalPass != null) {
      const v = await judgeGoalSuccess(run);
      if (!v.unavailable) {
        goalPairs.push({ human: l.goalPass, judge: v.pass });
        onVerdict?.({ dimension: 'goal', id, human: l.goalPass, judge: v.pass, reasoning: v.reasoning });
      }
    }
    if (l.conformancePass != null) {
      const v = await judgeSpecConformance(run);
      if (!v.unavailable) {
        confPairs.push({ human: l.conformancePass, judge: v.pass });
        onVerdict?.({ dimension: 'conformance', id, human: l.conformancePass, judge: v.pass, reasoning: v.reasoning });
      }
    }
    if (l.argAppropriatenessPass != null) {
      const v = await judgeArgumentAppropriateness(run);
      if (!v.unavailable) {
        argPairs.push({ human: l.argAppropriatenessPass, judge: v.pass });
        onVerdict?.({ dimension: 'arg_appropriateness', id, human: l.argAppropriatenessPass, judge: v.pass, reasoning: v.reasoning });
      }
    }
  }

  const results: CalibrationResult[] = [];
  if (goalPairs.length) {
    const kappa = computeCohenKappa(goalPairs);
    results.push({ dimension: 'goal', n: goalPairs.length, kappa, trusted: kappa >= KAPPA_TRUST_THRESHOLD });
  }
  if (confPairs.length) {
    const kappa = computeCohenKappa(confPairs);
    results.push({ dimension: 'conformance', n: confPairs.length, kappa, trusted: kappa >= KAPPA_TRUST_THRESHOLD });
  }
  if (argPairs.length) {
    const kappa = computeCohenKappa(argPairs);
    results.push({ dimension: 'arg_appropriateness', n: argPairs.length, kappa, trusted: kappa >= KAPPA_TRUST_THRESHOLD });
  }
  return results;
}
