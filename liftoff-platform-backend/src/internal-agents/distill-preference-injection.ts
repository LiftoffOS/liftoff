// preference contrastive injection (durable consolidation on operator redistill).
//
// The PRIMARY reliability path for preferences is the ALREADY-ALWAYS-ON runtime memory recall
// (corrections recalled into the prompt every run); this is the DURABLE path — it bakes recurring
// preferences into the agent's PERMANENT instructions at distill time. Redistill is
// OPERATOR-DRIVEN (redistill-cron stages changes for human review — not an automatic loop), so
// this is the "make it permanent" path, not the reliability floor. Universal: every agent, its
// OWN rejected behavior. Structure mirrors distill-work-inbox-injection: a pure predicate + a
// section builder the caller concatenates unconditionally.

/** A recurring preference: a rejected behavior and the preferred alternative, with how many
 *  times the signal recurred (only sufficiently-recurrent preferences are baked in). */
export interface RecurringPreference {
  preferred: string;
  rejected: string;
  reason: string;
  recurrence: number;
}

// Only bake in a preference that recurred at least this many times — a single rejection is a
// runtime-recall signal, not a permanent-instruction change.
export const PREFERENCE_MIN_RECURRENCE = 3;
// Cap how many are injected so the instruction stays focused.
const MAX_INJECTED = 8;

export function selectInjectablePreferences(preferences: readonly RecurringPreference[]): RecurringPreference[] {
  return [...preferences]
    .filter((p) => p.recurrence >= PREFERENCE_MIN_RECURRENCE)
    .sort((a, b) => b.recurrence - a.recurrence)
    .slice(0, MAX_INJECTED);
}

/** Build the injected section. Returns '' when there are no sufficiently-recurrent preferences,
 *  so the caller can concatenate unconditionally. */
export function buildPreferenceContractSection(preferences: readonly RecurringPreference[]): string {
  const injectable = selectInjectablePreferences(preferences);
  if (injectable.length === 0) return '';

  const lines = injectable
    .map((p) => `- Prefer: ${p.preferred}. Avoid: ${p.rejected}. (${p.reason})`)
    .join('\n');

  return `
LEARNED PREFERENCES (from human corrections on your past work — platform-consolidated):

Humans have repeatedly corrected the following patterns in your prior runs. Apply the preferred
behavior and avoid the rejected one:
${lines}
`;
}
