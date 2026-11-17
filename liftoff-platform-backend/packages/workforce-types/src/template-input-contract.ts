// The distillation input contract: what a template, a CAIO conversation and a
// Custom Hire document all produce, and what the distiller compiles.
//
// A template is an INPUT SHORTCUT, never a second authoring path. It is
// pre-typed input to the same distillation pipeline a person would otherwise
// type by hand, which is why everything here is optional: a two-field template
// stays valid, and enrichment cost falls on the catalog rather than on users.
//
// Three producers, one shape:
//   1. catalog templates — pre-typed by the platform, once;
//   2. the CAIO/HRBP conversation — elicited turn by turn;
//   3. Custom Hire — INFERRED by the first distillation from the user's own
//      document, then persisted as the incumbent that later redistills merge
//      against.
//
// The third is the reason none of this is an authored-versus-generated
// distinction. The distiller inventing a decomposition from a job description
// is the product. The rule is invented-once-then-OWNED: a flow's key is
// re-minted only when the changed responsibilities implicate it.
//
// Lives beside the section vocabulary because the two are one contract, and a
// second copy of a list like this drifts.

import type { ProseSections } from './agent-prose-sections.js';

/** Which layer of the compiled agent a prose section feeds. */
export type SectionDestination =
  | 'system_prompt'
  | 'workflow_steps'
  | 'output_contract'
  | 'flows';

/**
 * The single statement of which layer each authored section feeds.
 *
 * One constant rather than a rule in the distiller and a matching rule in the
 * validator: those are its two readers, and when they disagree the validator
 * passes a template the distiller then compiles somewhere else. Nothing
 * downstream would report that — the agent simply behaves as though the section
 * were not written.
 *
 * TODAY ONLY THE VALIDATOR READS IT, and that is deliberate rather than half
 * done. Distillation still compiles from the composed `responsibilities` and
 * `additionalContext` strings, so splitting the catalog changed no generated
 * agent — which is what made it a safe migration to run over 57 templates at
 * once. The distiller reads this when compilation routes BY section, and that
 * step does change generated agents, so it is its own change with its own
 * evidence. The constant is declared now because the classification is the work
 * and it is worth doing once.
 *
 * A heading NOT in this map is off-vocabulary. That is not an error on its own;
 * it means the section has to be classified before it can be compiled, which is
 * what `toolNotes` and `flows` are for.
 */
export const SECTION_DESTINATION: Readonly<Record<string, SectionDestination>> = Object.freeze({
  // responsibilities
  '## Responsibilities': 'system_prompt',
  '## Goals': 'system_prompt',
  // The decomposition. Sub-workflows promoted out of here become `flows`; what
  // stays is the ordered procedure.
  '## Workflows': 'workflow_steps',
  '## Instructions': 'system_prompt',
  // What a run owes at the end, which is a different question from how it runs.
  '## Outcomes': 'output_contract',
  // additionalContext
  '## Specific instructions': 'system_prompt',
  '## Rules': 'system_prompt',
  '## Constraints': 'system_prompt',
  '## Edge cases': 'system_prompt',
  '## Anything to avoid': 'system_prompt',
  '## Working with teammates': 'system_prompt',
});

/**
 * One named sub-workflow, with the keys that decide when to retrieve it.
 *
 * `useWhen` and `notNeededFor` are the retrieval keys, and they are the only
 * part of a flow that is genuinely new authoring. The bodies are mostly
 * PROMOTION: around thirty catalog templates already write their decomposition
 * as bold sub-workflow headers inside the prose ("Payment runs (weekly, every
 * Thursday)", "Day 30 check-in"), and promoting one costs nothing but moving
 * the text.
 *
 * `notNeededFor` is not decoration. Without an exclusion a key competes with
 * its siblings inside one agent's top-K, and the observed failure is two flows
 * of one agent both matching every request — at which point retrieval is
 * choosing arbitrarily and the agent's behaviour depends on tie-breaking.
 */
export interface TemplateFlow {
  /** Stable identity. Survives redistills — that is the whole point of it. */
  id: string;
  name: string;
  /** When this flow applies. Never a quoted sample utterance: a key that
   *  matches one phrasing of a request matches nothing else a user might say. */
  useWhen: string;
  /** When it does NOT, naming the sibling that covers that case instead. */
  notNeededFor: string;
  body: string;
  /** A clock the flow carries in its own prose, promoted to a field so the
   *  distiller stops re-deriving it from that prose on every hire. */
  companionCron?: string;
}

/**
 * Rules read while ONE call's arguments are being written.
 *
 * Keyed by CAPABILITY rather than by connector, so the note survives a
 * different binding: a rule about writing a pull-request comment is the same
 * rule whether the tenant connected GitHub or GitLab.
 *
 * Distinct from a flow, which is read before deciding what to do at all. This
 * is the material a model needs at the moment it fills in arguments, and it is
 * why the destination is eventually a per-tool description override rather than
 * more system prompt.
 */
export type ToolNotes = Record<string, string>;

/**
 * What the agent can actually do with a capability, as three states rather than
 * two.
 *
 * `live` — bound and usable. `unwired` — the platform supports it and this
 * tenant has not connected it, so prose may promise it conditionally. `absent`
 * — the platform cannot do it at all, and prose that describes it as available
 * is a promise nothing can keep. The two-state version could not tell those
 * apart, so an agent said "I will file the ticket" for a capability that does
 * not exist.
 */
export type CapabilityState = 'live' | 'unwired' | 'absent';
export type CapabilityStates = Record<string, CapabilityState>;

/** Domain vocabulary, rendered as a flow's first line ("Below, 'listing'
 *  means …"). Glossed once where it is read rather than in a preamble the
 *  model has long since scrolled past. */
export type DomainAliases = Record<string, string>;

/**
 * What a case ASSERTS. Only the keys the case is about are present — an eval
 * that pins everything pins the route as well as the answer, and then any
 * correct-but-different route fails it.
 */
export interface TemplateEvalExpectation {
  calls_tool?: string[];
  /** Text that must appear in the ARGUMENTS of some tool call.
   *
   *  A role whose output is a posted artifact says nothing about it in its
   *  reply, so a case asserting on the reply reads the wrong thing. */
  writes_include?: string[];
  /** Any ONE of these must appear in the ARGUMENTS of some tool call — for a
   *  message the role is told to convey, not a string it is told to write. */
  writes_include_any?: string[];
  /** Text that must appear in NO tool call's arguments. */
  writes_omit?: string[];
  /**
   * Satisfied by any ONE of these tools, where `calls_tool` demands every one.
   *
   * For a behaviour with several honest routes. Posting a pull request review
   * is the case in point: a reviewer can open a pending review and add comments
   * to it, or leave its summary as an issue comment, and both did the job. A
   * case naming one route fails the agent that took the other, which is the
   * re-pinning the harness exists to avoid.
   */
  calls_any_of?: string[];
  never_calls?: string[];
  first_tool?: string;
  // `max_tool_calls` was here and is deliberately gone.
  //
  // It measured model variance, not behaviour. Two identical runs of one case
  // produced 11 then 15 calls; another produced 28 then 22. A threshold against
  // a number that moves by that much either fails correct runs or passes wrong
  // ones depending on the day.
  //
  // Worse, the count is not the agent's. The SDK issues `ToolSearch` calls to
  // discover its own tools — several per turn, not chosen by the agent and not
  // visible to whoever writes the case — so a budget written against observed
  // behaviour is partly a budget against the harness.
  //
  // What it was reaching for is expressible exactly: "it did not redo the work"
  // is `never_calls`, and that assertion is precise, stable, and already there.
  reply_includes?: string[];
  reply_omits?: string[];
  /** The agent must answer without loading a skill — the check that catches an
   *  agent paying retrieval cost for something it already knows. */
  no_skill_load?: boolean;
  /** Graded by a judge rather than matched. Costs a model call, so it is the
   *  last resort and not the default. */
  rubric?: string;
}

/**
 * One eval case on a template.
 *
 * Two authoring rules, both learned the hard way and both enforced by the
 * validator rather than by convention:
 *
 * EVERY POSITIVE HAS A NEGATIVE. A case asserting that an agent escalates a
 * risky change passes trivially for an agent that escalates everything. The
 * negative counterpart — the safe change it must NOT escalate — is what makes
 * the pair mean anything.
 *
 * WHEN A LIVE RUN TAKES AN UNEXPECTED ROUTE AND THE ANSWER WAS RIGHT, WIDEN THE
 * ACCEPTABLE SET. Never re-pin to the observed route. Re-pinning turns an eval
 * into a record of what the model happened to do on the day it was written, and
 * every later improvement reads as a regression.
 */
export interface TemplateEval {
  id: string;
  /** Fixture state the case runs against — a diff, an inbox, a row. */
  state?: Record<string, unknown>;
  turns: string[];
  expected: TemplateEvalExpectation;
  /** The id of the case this one is the counterpart to. A refusal case names
   *  the served case, and the validator checks the pair exists. */
  counterpartOf?: string;
}

/**
 * Everything the input contract adds to a template, all optional.
 *
 * Separate from `AgentTemplate` so the contract can be produced by a
 * conversation or inferred from a document without a template existing at all —
 * which is exactly what Custom Hire does.
 */
export interface TemplateInputContract {
  /** The authored prose, split by heading. The composed `responsibilities` and
   *  `additionalContext` stay derivable via `composeProseSections`, and stay
   *  authoritative: `sections` is a parsed VIEW until a later phase inverts
   *  that, so the two can never disagree about what the template says. */
  sections?: ProseSections;
  flows?: TemplateFlow[];
  toolNotes?: ToolNotes;
  capabilities?: CapabilityStates;
  domainAliases?: DomainAliases;
  evals?: TemplateEval[];
  /** The agent may only write to a record this run has actually seen.
   *
   *  An obligation rather than prose, because prose promising it is not
   *  enforcement — Phase 3's gate in the tenant runtime is. A validator net
   *  ties the two together the way the three existing obligation nets do, so a
   *  template promising the behaviour in prose without setting the flag fails
   *  rather than shipping a promise nothing keeps. */
  writesRequireProvenance?: boolean;
}
