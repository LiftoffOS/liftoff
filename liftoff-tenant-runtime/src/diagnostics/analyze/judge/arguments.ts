// Argument-appropriateness judge — "Were the tool ARGUMENT VALUES right for the
// user's request?" The advisory (LLM) half of argument scoring, complementing
// the deterministic schema-validity floor (analyze/critics/schema-validity.ts).
// Advisory only (alert + scorecard, never gates) until κ-calibrated. Mirrors
// judge/goal.ts + judge/conformance.ts.
//
// PII: the reconstructed trajectory's tool inputs are already PII-redacted at the
// GCS sink; the judge runs in-boundary (Vertex) and only its verdict leaves. The
// prompt instructs the model not to echo raw values in its reasoning.

import type { ReconstructedRun } from '../../reconstruct/trace-model';
import { collectToolUses } from '../trajectory-util';
import { runStructuredJudge, serializeForJudge, type JudgeResult } from './llm-judge';

const SYSTEM = `You are an impartial evaluator of an AI agent's TOOL ARGUMENTS. You are given the
user's objective and the tool calls the agent made (tool name + arguments). Decide whether the
ARGUMENT VALUES were APPROPRIATE for the user's request — e.g. the right query, the right time
range, the right filters — not merely well-formed. Be strict: plausible-but-wrong values are NOT
appropriate. Do NOT quote raw argument values in your reasoning.

Respond with ONLY a JSON object:
{"score": <0.0-1.0 argument appropriateness>, "pass": <true if score >= 0.7>, "reasoning": "<one sentence>"}`;

/** Compact tool-call + args view for the judge. */
function serializeToolArgs(run: ReconstructedRun): string {
  const uses = collectToolUses(run.trajectory);
  if (uses.length === 0) return '(no tool calls)';
  return uses.map((u, i) => `${i + 1}. ${u.name}(${JSON.stringify(u.input)})`).join('\n');
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export async function judgeArgumentAppropriateness(run: ReconstructedRun): Promise<JudgeResult> {
  // MODE-AWARE (see judgeGoalSuccess). Only a real, persisted, interactive
  // conversation with reliably-captured tool inputs can be graded for argument
  // appropriateness. Non-interactive / synthesized-objective / unreliable-input
  // runs, and runs with no tool calls, have nothing trustworthy to judge args
  // against → unavailable (skipped, never a fabricated verdict).
  const triggeredBy = run.raw.invocation?.triggeredBy;
  const isInteractive = triggeredBy == null || triggeredBy === 'human';
  const synthesized = run.trajectory.trajectory_meta.synthesized_objective === true;
  const inputsReliable = run.trajectory.trajectory_meta.inputs_reliable !== false;
  const uses = collectToolUses(run.trajectory);
  if (!isInteractive || synthesized || !inputsReliable || uses.length === 0) {
    const reason =
      uses.length === 0 ? 'no tool calls to judge' : !inputsReliable ? 'tool inputs unreliable' : 'no persisted interactive conversation';
    return { score: 0, pass: false, reasoning: `argument appropriateness not judged — ${reason}`, unavailable: true };
  }

  const user = [serializeForJudge(run.trajectory), `\nTOOL CALLS WITH ARGUMENTS:\n${serializeToolArgs(run)}`].join('\n');
  const verdict = await runStructuredJudge<{ score?: number; pass?: boolean; reasoning?: string }>({
    system: SYSTEM,
    user,
    tenantId: run.ref.tenantId,
    purpose: 'diagnostics_arg_appropriateness_judge',
  });
  if (!verdict) {
    return { score: 0, pass: false, reasoning: 'arg-appropriateness judge unavailable', unavailable: true };
  }
  const score = clamp01(verdict.score ?? (verdict.pass ? 1 : 0));
  return { score, pass: verdict.pass ?? score >= 0.7, reasoning: verdict.reasoning ?? '' };
}
