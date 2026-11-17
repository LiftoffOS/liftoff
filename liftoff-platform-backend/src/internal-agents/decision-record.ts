// Configuration provenance: what an agent's shape was decided BY.
//
// The agent row already holds what the agent IS. This holds why, and it exists
// because a redistill that cannot see the previous run's reasoning re-derives
// it from scratch — and re-derives it differently, because the input that
// settled it was a conversation rather than a document.
//
// The failure is worst exactly where the feature is most used. In the CAIO and
// HRBP build-and-refine loop a person says "this team has no email", the
// distiller writes that into prose, and the next "tweak my agent" reverses it.
// Prose is not a decision; it is a sentence a later generation is free to
// rewrite. Recorded, a refinement becomes a merge against what the user already
// settled — the ADR-043 skill-provenance discipline applied to configuration.
//
// Four members, from two sources, and the split is not arbitrary:
//
//   trigger           derivable in code, from what the model already emitted
//   capabilityStates  derivable in code, from the template and the bindings
//   cadenceClamps     ONLY the model knows — the floor is a prompt rule, not a
//                     post-hoc clamp, so no code site sees the cadence that was
//                     wanted and refused
//   assumptions       ONLY the model knows, by definition
//
// Deriving the first two in code rather than asking for them keeps the schema
// small and keeps two fields that have a single correct answer from becoming
// something the model can get wrong.

import type { DecisionRecord } from './types';

export interface DecisionRecordInputs {
  /** What the model emitted for the trigger, reasoning included. */
  triggerConfig?: { type?: string; reasoning?: string } | null;
  /** Per-capability states as resolved for this hire. */
  capabilityStates?: Record<string, 'live' | 'unwired' | 'absent'>;
  /** The half only the model can supply. */
  fromModel?: {
    cadenceClamps?: Array<{ requested: string; applied: string; reason: string }>;
    assumptions?: Array<{ about: string; assumed: string }>;
  };
  /** Override keys this distillation authored — the marker that makes the
   *  override merge a merge. See tool-override-provenance.ts. */
  distilledOverrideTools?: string[];
  /** The subject each flow was minted from, keyed by skill id. The marker that
   *  makes the flow-identity carry-forward possible. See flow-incumbency.ts. */
  flowSubjects?: Record<string, string[]>;
}

/** Assemble the record this distillation should store. */
export function buildDecisionRecord(inputs: DecisionRecordInputs): DecisionRecord {
  const record: DecisionRecord = { recordedAt: new Date().toISOString() };

  const type = inputs.triggerConfig?.type;
  const reason = inputs.triggerConfig?.reasoning;
  if (type) {
    // The reason is the load-bearing half. A later run that sees only "cron"
    // re-derives a cron from prose; one that sees "cron because no
    // webhook-capable connector was bound" knows the choice was FORCED, and can
    // revisit it the day one is.
    record.trigger = { type, reason: reason ?? '' };
  }
  if (inputs.capabilityStates && Object.keys(inputs.capabilityStates).length > 0) {
    record.capabilityStates = inputs.capabilityStates;
  }
  const clamps = inputs.fromModel?.cadenceClamps ?? [];
  if (clamps.length > 0) record.cadenceClamps = clamps;
  const assumptions = inputs.fromModel?.assumptions ?? [];
  if (assumptions.length > 0) record.assumptions = assumptions;
  if (inputs.distilledOverrideTools && inputs.distilledOverrideTools.length > 0) {
    record.distilledOverrideTools = inputs.distilledOverrideTools;
  }
  if (inputs.flowSubjects && Object.keys(inputs.flowSubjects).length > 0) {
    record.flowSubjects = inputs.flowSubjects;
  }
  return record;
}

/** One decision this redistill reversed. */
export interface DecisionReversal {
  field: string;
  was: string;
  now: string;
}

/**
 * What a redistill CHANGED about decisions the previous one recorded.
 *
 * Reported rather than blocked, and that is deliberate. A reversal is often
 * right — an agent that had no email connector may have one now, and the
 * trigger that was forced to cron should become an event. What must not happen
 * is a reversal nobody can see, because that is indistinguishable from the
 * model quietly re-litigating a settled question.
 *
 * `absent` is the state worth watching. It is a fact about the business rather
 * than about today's bindings, so a redistill turning `absent` back into
 * `unwired` has not learned something — it has forgotten something.
 */
export function diffDecisionRecords(
  previous: DecisionRecord | undefined,
  next: DecisionRecord | undefined,
): DecisionReversal[] {
  if (!previous || !next) return [];
  const out: DecisionReversal[] = [];

  if (previous.trigger?.type && next.trigger?.type
      && previous.trigger.type !== next.trigger.type) {
    out.push({ field: 'trigger.type', was: previous.trigger.type, now: next.trigger.type });
  }

  const before = previous.capabilityStates ?? {};
  const after = next.capabilityStates ?? {};
  for (const [cap, wasState] of Object.entries(before)) {
    const nowState = after[cap];
    if (nowState && nowState !== wasState) {
      out.push({ field: `capability.${cap}`, was: wasState, now: nowState });
    }
  }

  return out;
}

/**
 * The section a redistill puts in front of the model.
 *
 * Rendered as instructions rather than as data, because a record the model reads
 * as background is a record it feels free to contradict. It has to arrive as a
 * constraint with a stated escape: honour these unless the inputs now say
 * otherwise, and say so when you depart from one.
 *
 * Returns an empty string when there is nothing recorded — a heading with no
 * content teaches the model that this section is usually empty and can be
 * skimmed.
 */
export function renderDecisionRecordSection(record: DecisionRecord | undefined): string {
  if (!record) return '';
  const lines: string[] = [];

  if (record.trigger?.type) {
    lines.push(`- Trigger: ${record.trigger.type}${record.trigger.reason ? ` — ${record.trigger.reason}` : ''}`);
  }
  for (const [cap, state] of Object.entries(record.capabilityStates ?? {})) {
    lines.push(`- Capability ${cap}: ${state}`);
  }
  for (const c of record.cadenceClamps ?? []) {
    lines.push(`- Cadence: wanted ${c.requested}, used ${c.applied} — ${c.reason}`);
  }
  for (const a of record.assumptions ?? []) {
    lines.push(`- Assumed ${a.about}: ${a.assumed}`);
  }
  if (lines.length === 0) return '';

  return [
    '## DECISIONS ALREADY MADE ABOUT THIS AGENT',
    '',
    'These were settled by a previous configuration of this agent, some of them by a person.',
    'Honour them unless the inputs above now contradict one. Where you depart from one, the',
    'inputs must say why — a decision reversed because you did not see it is the failure this',
    'section exists to prevent.',
    '',
    'A capability recorded as `absent` is a fact about the business, not about today\'s',
    'bindings: it means there is no such tool and never will be. Do not restore it because',
    'nothing is currently connected.',
    '',
    ...lines,
  ].join('\n');
}
