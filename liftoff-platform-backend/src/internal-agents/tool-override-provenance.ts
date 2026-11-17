// Provenance merging for per-tool description overrides.
//
// The same discipline ADR-043 applies to skills, applied to the layer table's
// first row: a redistill REPLACES what the last distillation wrote and leaves
// everything else alone. Without it a redistill is a rewrite, and the thing it
// rewrites away is whatever a human put there.
//
// The wire shape is a flat `{toolName: text}` map, which carries no room for a
// per-entry provenance marker. So the marker lives beside it, in the decision
// record — which is the column for exactly this: what this agent's shape was
// decided by. `decisionRecord.distilledOverrideTools` is the set of keys the
// LAST distillation authored, and it is the only thing that makes the merge a
// merge rather than a replace.
//
// The three cases, and why each is what it is:
//
//   in incoming            -> take the incoming text. This run reasoned about
//                             the tool; its answer is the current one.
//   absent, was distilled  -> DROP. The previous run wrote it and this run
//                             decided the tool needs no rule. Keeping it would
//                             apply a retired policy forever, which is the
//                             failure resultRules' full-list replace avoids.
//   absent, not distilled  -> KEEP. Nobody's distillation wrote it, so a human
//                             did, and a redistill has no business deleting it.
//
// The third case is the whole point and is currently empty: no operator surface
// writes these yet. That is not a reason to defer it — the merge has to be
// correct BEFORE the surface exists, or the first human-authored override is
// deleted by the next redistill and nobody connects the two events.

import type { DecisionRecord } from './types';

export interface OverrideMergeResult {
  merged: Record<string, string>;
  /** The keys this distillation authored, to record for the next merge. */
  distilledTools: string[];
  /** Kept because no distillation wrote them — a human did. Logged rather than
   *  silently preserved, so the first time it is non-empty somebody sees it. */
  preserved: string[];
  /** Dropped because the previous distillation wrote them and this one did not. */
  retired: string[];
}

/**
 * Merge a fresh distillation's overrides over what the agent already carries.
 *
 * `previouslyDistilled` comes from the stored decision record. When it is
 * absent — a legacy row, or the first distillation after this column existed —
 * every existing key is treated as NOT distilled and therefore preserved. That
 * direction is deliberate: the cost of keeping a stale distilled override is a
 * rule that no longer applies, and the cost of dropping a human's is silent
 * data loss. Only one of those is recoverable by reading the agent.
 */
export function mergeToolDescriptionOverrides(
  current: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined,
  previouslyDistilled: readonly string[] | undefined,
): OverrideMergeResult {
  const existing = current ?? {};
  const fresh = incoming ?? {};
  const wasDistilled = new Set(previouslyDistilled ?? []);

  const merged: Record<string, string> = {};
  const preserved: string[] = [];
  const retired: string[] = [];

  for (const [tool, text] of Object.entries(existing)) {
    if (tool in fresh) continue;          // superseded below
    if (wasDistilled.has(tool)) {
      retired.push(tool);
      continue;
    }
    merged[tool] = text;
    preserved.push(tool);
  }
  for (const [tool, text] of Object.entries(fresh)) {
    merged[tool] = text;
  }

  return {
    merged,
    distilledTools: Object.keys(fresh).sort(),
    preserved: preserved.sort(),
    retired: retired.sort(),
  };
}

/** The override keys the last distillation authored, as stored. */
export function distilledOverrideTools(record: DecisionRecord | undefined): string[] {
  return record?.distilledOverrideTools ?? [];
}
