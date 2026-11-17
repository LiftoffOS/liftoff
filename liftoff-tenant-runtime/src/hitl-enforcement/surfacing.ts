// The Escalation setting, given the meaning the oversight page states.
//
// The page promises three levels of surfacing and the code implemented two:
// `oversight.escalation` had exactly one reader, section 5 of checkHitlGate,
// where "Only exceptions" and "Important decisions" were identical and
// neither was consulted when a run asked or escalated. This is the one
// function that says what reaches the review page under each setting; it is
// read at section 5 and at the three points where a recovery decision becomes
// an item for a person.
//
//   exceptions   blockers; confident contract deviations; hard invariants
//   important    the above, plus questions and escalations that pass the
//                ask check
//   sensitive    the above, plus sensitive-work gates from the opted-in
//                categories, as today
//
// Hard invariants (super_destructive_gate, merge_to_main,
// external_content_write) reach the page under every setting; they never
// consult this. In force only when the workspace has saved its Escalation
// setting since the meaning changed (`escalationSemantics >= 2`, carried from
// the control plane) and the kill is on; otherwise section 5 reads the
// setting as it always has and every ask posts as today.

import { isSurfacingPolicyEnabled } from '../typesafe/flags';
import type { OversightSettings } from './types';

export type EscalationSetting = OversightSettings['escalation'];

export interface SurfacingPolicy {
  /** Sensitive-work gates from the opted-in categories reach the page. */
  sensitiveWorkGates: boolean;
  /** Questions and customer-facing escalations that pass the ask check are
   *  announced to a person. A question still parks under every setting: the
   *  run cannot proceed without the value, and the setting changes
   *  notification, not correctness. */
  asksAndEscalations: boolean;
}

export function surfacingPolicyFor(setting: EscalationSetting): SurfacingPolicy {
  switch (setting) {
    case 'exceptions':
      return { sensitiveWorkGates: false, asksAndEscalations: false };
    case 'important':
      return { sensitiveWorkGates: false, asksAndEscalations: true };
    case 'sensitive':
      return { sensitiveWorkGates: true, asksAndEscalations: true };
  }
}

/** Whether the policy governs this workspace: the kill is on and the
 *  workspace chose its setting under the page's stated meaning. */
export function surfacingPolicyInForce(oversight: Pick<OversightSettings, 'escalationSemantics'> | undefined): boolean {
  if (!isSurfacingPolicyEnabled()) return false;
  return (oversight?.escalationSemantics ?? 1) >= 2;
}

/** The policy for this workspace when it is in force, else null: the caller
 *  keeps today's behaviour on null. */
export function surfacingPolicyOf(oversight: OversightSettings | undefined): SurfacingPolicy | null {
  if (!oversight || !surfacingPolicyInForce(oversight)) return null;
  return surfacingPolicyFor(oversight.escalation);
}
