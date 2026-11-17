// Shared read helpers over a CanonicalTrajectory. Used by the invariant
// auditors, the tool-conformance auditor, and the DeepEval-style metrics so
// they all agree on what "the tool calls" and "the results" are.

import type { CanonicalTrajectory, CanonicalContentBlock } from '../reconstruct/trace-model';

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Position in the flattened block stream — defines call order. */
  order: number;
}

export interface ToolResult {
  toolUseId: string;
  isError: boolean;
  order: number;
}

/** All tool_use blocks in call order. */
export function collectToolUses(traj: CanonicalTrajectory): ToolUse[] {
  const out: ToolUse[] = [];
  let order = 0;
  for (const m of traj.messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use') out.push({ id: b.id, name: b.name, input: b.input, order: order++ });
      else order++;
    }
  }
  return out;
}

/** All tool_result blocks keyed by tool_use_id (last write wins). */
export function collectToolResults(traj: CanonicalTrajectory): Map<string, ToolResult> {
  const out = new Map<string, ToolResult>();
  let order = 0;
  for (const m of traj.messages) {
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        out.set(b.tool_use_id, { toolUseId: b.tool_use_id, isError: b.is_error === true, order: order++ });
      } else order++;
    }
  }
  return out;
}

/** Concatenated assistant text (last-turn-biased) — the "final answer" surface
 *  the goal judge and output checks read.
 *
 *  REFUSALS. `refusal` is a first-class canonical block. Including it here
 *  changes what the goal and conformance judges read, so it is a scoring-input
 *  change: shipped behind a flag, OFF by default, flipped only on eval evidence.
 *  Never ship a first-guess default on a scoring input.
 *
 *  The case for eventually turning it on: a refusal-terminated run currently
 *  yields an EMPTY final answer, which the goal judge scores as a failure with
 *  no explanation — the run is marked wrong rather than declined, and the
 *  distinction is exactly what an operator needs. The case against: refusal text
 *  is not an answer, and feeding it in as one may inflate goal-completion scores
 *  on runs that completed nothing. Only an eval set settles that. */
export function finalAssistantText(traj: CanonicalTrajectory): string {
  const includeRefusals = process.env.JUDGE_FINAL_ANSWER_INCLUDES_REFUSALS === 'true';
  const parts: string[] = [];
  for (const m of traj.messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) {
      if (b.type === 'text') parts.push(b.text);
      else if (includeRefusals && b.type === 'refusal') parts.push(b.text);
    }
  }
  return parts.join('\n').trim();
}

/** The initial user objective (first user text block). */
export function objective(traj: CanonicalTrajectory): string {
  for (const m of traj.messages) {
    if (m.role !== 'user') continue;
    for (const b of m.content) if (b.type === 'text') return b.text;
  }
  return '';
}

/** A stable signature for a tool call (name + canonicalized input) used to
 *  detect exact-repeat loops and idempotency double-execution. */
export function toolCallSignature(name: string, input: Record<string, unknown>): string {
  let inputKey: string;
  try {
    inputKey = JSON.stringify(input, Object.keys(input).sort());
  } catch {
    inputKey = '<unserializable>';
  }
  return `${name}::${inputKey}`;
}

export function isToolUse(b: CanonicalContentBlock): b is Extract<CanonicalContentBlock, { type: 'tool_use' }> {
  return b.type === 'tool_use';
}
