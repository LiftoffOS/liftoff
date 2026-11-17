// Canonical MAST + TRAIL failure taxonomy (plan Fixed decisions: "MAST + TRAIL
// failure taxonomy"). Findings carry a descriptive `failureMode` label; this
// module canonicalizes those labels to stable taxonomy CODES so cross-run
// clustering groups the same failure consistently and the report can show the
// formal category + description.
//
// MAST — "Multi-Agent System Failure Taxonomy" (Cemri et al.): three categories,
// 14 modes. TRAIL — "Trace Reasoning and Agentic Issue Localization": adds
// fine-grained execution/tool-localization codes the per-step attribution uses.

export type TaxonomyCode =
  // MAST FM-1.x — Specification & System Design
  | 'MAST-1.1' // disobey task specification
  | 'MAST-1.2' // disobey role specification (out-of-set tool / role / oversight)
  | 'MAST-1.3' // step repetition / loops / double-execution
  | 'MAST-1.4' // loss of conversation history / state
  | 'MAST-1.5' // unaware of termination conditions (stuck / runaway / budget)
  // MAST FM-3.x — Task Verification & Termination
  | 'MAST-3.1' // premature termination
  | 'MAST-3.2' // no or incomplete verification (silent failure / partial rollback)
  // TRAIL — execution / tool localization
  | 'TRAIL-exec.tool_result_missing'
  | 'TRAIL-exec.orphan_tool_result'
  | 'TRAIL-exec.tool_selection'
  | 'TRAIL-exec.invalid_tool_args'
  | 'unknown';

export const TAXONOMY: Record<TaxonomyCode, { source: 'MAST' | 'TRAIL' | 'unknown'; title: string }> = {
  'MAST-1.1': { source: 'MAST', title: 'Disobey task specification' },
  'MAST-1.2': { source: 'MAST', title: 'Disobey role specification' },
  'MAST-1.3': { source: 'MAST', title: 'Step repetition / non-idempotent re-execution' },
  'MAST-1.4': { source: 'MAST', title: 'Loss of conversation history / state' },
  'MAST-1.5': { source: 'MAST', title: 'Unaware of termination conditions' },
  'MAST-3.1': { source: 'MAST', title: 'Premature termination' },
  'MAST-3.2': { source: 'MAST', title: 'No or incomplete verification' },
  'TRAIL-exec.tool_result_missing': { source: 'TRAIL', title: 'Tool call without a result' },
  'TRAIL-exec.orphan_tool_result': { source: 'TRAIL', title: 'Tool result without a call' },
  'TRAIL-exec.tool_selection': { source: 'TRAIL', title: 'Incorrect tool selection' },
  'TRAIL-exec.invalid_tool_args': { source: 'TRAIL', title: 'Incorrect tool arguments' },
  unknown: { source: 'unknown', title: 'Unclassified' },
};

// Map the descriptive failureMode labels the invariants emit onto canonical codes.
const LABEL_TO_CODE: Record<string, TaxonomyCode> = {
  'TRAIL.tool_result_missing': 'TRAIL-exec.tool_result_missing',
  'TRAIL.orphan_tool_result': 'TRAIL-exec.orphan_tool_result',
  'MAST.state_loss': 'MAST-1.4',
  'MAST.stuck_pending': 'MAST-1.5',
  'MAST.oversight_bypass': 'MAST-1.2',
  'MAST.delegation_orphan': 'MAST-3.1',
  'MAST.double_spawn': 'MAST-1.3',
  'MAST.idempotency_double_exec': 'MAST-1.3',
  'TRAIL.repetitive_actions': 'MAST-1.3',
  'TRAIL.runaway': 'MAST-1.5',
  'MAST.no_termination': 'MAST-1.5',
  'MAST.budget_overrun': 'MAST-1.5',
  'MAST.silent_failure': 'MAST-3.2',
  'MAST.partial_rollback': 'MAST-3.2',
  'MAST.out_of_set_tool': 'TRAIL-exec.tool_selection',
  'MAST.role_violation': 'MAST-1.2',
  'MAST.sequence_break': 'MAST-1.1',
  'TRAIL.missing_output_format': 'MAST-1.1',
  'MAST.timer_resume_lost': 'MAST-3.1',
  'MAST.hitl_bypass': 'MAST-1.2',
  'TRAIL.invalid_tool_args': 'TRAIL-exec.invalid_tool_args',
};

/** Canonicalize a finding's failureMode label to a taxonomy code. Unknown
 *  labels (e.g. from the RCA agent) pass through as 'unknown' so they still
 *  cluster, but separately from the known codes. */
export function normalizeFailureMode(label: string | undefined): TaxonomyCode {
  if (!label) return 'unknown';
  if (label in TAXONOMY) return label as TaxonomyCode;
  return LABEL_TO_CODE[label] ?? 'unknown';
}

export function describeCode(code: TaxonomyCode): string {
  const e = TAXONOMY[code];
  return `${code} (${e.source}): ${e.title}`;
}
