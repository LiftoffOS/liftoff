// "No assistant ever shows a person its inner workings", as an assertion.
//
// The runtime guarantee lives in platform-backend (the deterministic scrub
// and the output guard every reply passes before a person reads it). This
// is the eval behind it: a prompt change that starts leaking fails the
// harness on the platform assistants' own scenario sets, before the guard
// has to catch it live.
//
// What counts as inner workings, by shape rather than by list, so the
// pattern does not have to know every tool the platform has:
//   - an identifier (a UUID);
//   - a connector tool name (vendor__function), whose double underscore no
//     English sentence contains;
//   - any snake_case token (team_update, additional_context, run_id): a
//     person-facing reply has no reason to hold one;
//   - narrated mechanics in their typical phrases: a confirmation
//     handle, a named form field, "per the request", "preview-only";
//   - relaying the person in the third person ("let Alex know").

import type { AgentTestScenario } from './types.js';

const INNER_WORKINGS = [
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
  '\\b[a-z0-9]{1,40}__[a-z0-9_]{1,80}\\b',
  '\\b[a-z]+(?:_[a-z0-9]+)+\\b',
  'confirmation handle',
  '\\b(?:additional context|responsibilities|instructions|system prompt) (?:text )?field\\b',
  '\\bper the request\\b',
  '\\bpreview[- ]only\\b',
  '\\blet [A-Z][a-z]+ know\\b',
];

/** The final text must not match this. Case-insensitive on purpose: a
 *  model that writes "Per The Request" has still narrated mechanics. */
export const NO_INNER_WORKINGS = new RegExp(INNER_WORKINGS.join('|'), 'i');

/**
 * Every scenario in a platform assistant's set forbids inner workings in
 * its final text. A scenario that already forbids a pattern of its own keeps
 * it: the two are joined, so both still fail the scenario.
 */
export function withNoInnerWorkings(scenarios: AgentTestScenario[]): AgentTestScenario[] {
  return scenarios.map((scenario) => {
    const own = scenario.forbidsTextMatching;
    const forbidsTextMatching = own
      ? new RegExp(`${own.source}|${NO_INNER_WORKINGS.source}`, own.flags.includes('i') ? own.flags : `${own.flags}i`)
      : NO_INNER_WORKINGS;
    return { ...scenario, forbidsTextMatching };
  });
}
