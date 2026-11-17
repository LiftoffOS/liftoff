// Gate on what the agent was approved to do, not on what the tool is called.
//
// We distil an agent's responsibilities into a workflow graph, a human approves
// that graph, and then at the moment we decide whether an action needs a person
// we throw that knowledge away and reconstruct it from tool-name tokens,
// argument shapes and vendor payload spellings. Every mechanism that tries to
// behave sensibly is doing that reconstruction — `isInPlaceReply`,
// REPLY_OPERATIONS per host, MAIL_IN_PLACE_OPERATIONS, DRAFT_OPERATIONS,
// ARGUMENT_GUARDS — and the reconstruction is where the bugs live. Fixing them
// one at a time does not stop the gate firing, because the policy is not what
// is wrong: the graph says this step is declared and nothing asks it.
//
// THE RULE. A `tool_call` step that exists in the agent's approved workflow
// graph, dispatching the tool that step declares, against the entity that
// triggered the run, is already authorised — it was authorised when a human
// approved the agent. Escalate on DEVIATION.
//
// This is not a fourth carve-out. The graph is not a proxy for the operator's
// decision; it IS the artifact the operator approved. Reading it removes the
// reconstruction rather than adding another attempt at it, and it ends the
// allowlist treadmill: REPLY_OPERATIONS needs an entry per host per operation
// forever, and a missing entry fails CLOSED into noise. That is exactly what
// happened — the three-op review flow shipped in the morning and its allowlist
// entry was forgotten, and the agent could not work for a day.
//
// WHAT THIS DELIBERATELY CANNOT DO
//
// It cannot exempt anything on the conversational / adapter path. There is no
// declared step there: the model chose the tool itself, which is the definition
// of a deviation. The exemption needs a step to point at, so the architecture
// withholds it rather than a rule having to.
//
// It cannot exempt a hard-invariant effect. Those are checked before this and
// ignore the graph entirely — see `hardInvariantEffectOf` in
// @liftoffos/governance-types. The first draft of `isInPlaceReply` allowed "any
// non-destructive write to the entity that woke me", and `merge_pull_request`
// classifies as ['dataChanges'] — not destructive — so that rule would have let
// an agent MERGE the pull request that woke it, with no approval. Any
// declared-scope rule has to keep that case gated, and this one does not decide
// it at all.

import { targetsTriggerEntity, type TriggerTarget, type CallUnderTest } from './in-place-reply';

/** The graph step dispatching this call, when one is.
 *
 *  `toolName` is the RESOLVED name — after `resolveTriggerBoundTool` has turned
 *  `trigger__pr_review_begin` into the connector that fired the run. Comparing
 *  against the authored name would compare against a pseudo-alias no connector
 *  is ever called by. */
export interface DeclaredStep {
  stepId: string;
  toolName: string;
  /** The step's arguments are AUTHORED — fixed by the approved graph rather than
   *  interpolated from what the run was handed.
   *
   *  This is the leg that makes declared scope work for a step that acts
   *  somewhere other than the trigger. `targetsTriggerEntity` answers "is this
   *  the thing that woke me", which is right for replying on a pull request and
   *  simply false for notifying Slack about it — so a declared notification step
   *  was reported as a DEVIATION from the workflow that declares it.
   *
   *  For example, a step (`slack_resolve_channel_by_name`, template
   *  `{"name": "code-reviewer"}`) would raise a card reading "Outside the
   *  approved workflow", against a step whose own description is "Resolve the
   *  #code-reviewer Slack channel so the notification can be posted to the
   *  correct channel id."
   *
   *  Authored means NO interpolation at all: no `{{…}}` in the template or the
   *  resolved input. That is deliberately stricter than "no untrusted root".
   *  What the external-content invariant defends against is injected content
   *  STEERING the agent, and on the workflow path the graph already fixes the
   *  tool; fixing the arguments too leaves nothing for injected text to move. A
   *  step interpolating `{{steps.s5.summary}}` carries run-derived content and
   *  keeps its gate, because that summary was written after reading the
   *  untrusted diff.
   *
   *  Trigger-bound identity arguments (owner/repo/pullNumber, merged by
   *  `resolveTriggerBoundTool`) are concrete rather than interpolated, so they
   *  read as authored. That is not a widening: they only ever name the entity
   *  that triggered the run, which the other leg permits anyway. */
  argumentsAuthored?: boolean;
  /** The step's own description, carried for the approval card so a person can
   *  see WHICH declared step this is rather than a bare tool name. */
  description?: string;
  /** The step's toolInputTemplate, carried only when the arguments are
   *  authored: the contract check judges the call against it. */
  template?: string;
}

/** Bare action from `<alias>__<action>`, or the name itself. */
function bareAction(name: string): string {
  const i = name.lastIndexOf('__');
  return i < 0 ? name : name.slice(i + 2);
}

/**
 * Is this call the approved graph doing what it declared?
 *
 * All three legs must hold, and each answers false rather than guessing:
 *
 *   1. A step is dispatching it. No step, no exemption.
 *   2. The dispatched tool is the one that step declares.
 *   3. The call names the entity that triggered the run.
 *
 * Leg 2 compares BARE ACTIONS. The catalog registers `<alias>__<fn>` while the
 * SDK calls `mcp__liftoff-tool-gateway__<alias>__<fn>`, and a raw name match
 * across that boundary is the prefix defect already fixed at four separate
 * lookups in `checkHitlGate`. Comparing the action alone also survives an alias
 * that moved mid-run, which the stale-alias remap rewrites for exactly that
 * reason.
 *
 * Leg 3 is `targetsTriggerEntity`, the same identity proof `isInPlaceReply`
 * uses. A step declared in the graph is authorised against the entity that woke
 * this run and nothing else: the same agent, the same step, aimed at a
 * different repository, is a deviation and gates.
 */
export function inDeclaredScope(
  call: CallUnderTest,
  step: DeclaredStep | undefined,
  target: TriggerTarget | undefined,
): boolean {
  // 1. Nothing declared this. The adapter path lands here, always.
  if (!step || !step.toolName) return false;

  // 2. The step must be dispatching ITS tool. A step that declares a read and
  //    dispatches a write is not doing what was approved, whatever the graph
  //    says it intended.
  if (bareAction(call.name) !== bareAction(step.toolName)) return false;

  // 3. …either against the entity that woke the run, or with arguments the
  //    approved graph fixed itself.
  //
  // Two legs, not one. The first is "reply on the thing that woke me". The
  // second is "do the declared thing you were built to do", which is how a
  // notification step is in scope despite naming a Slack channel rather than a
  // pull request. Requiring the first alone marked every fan-out step in every
  // workflow as a deviation.
  return targetsTriggerEntity(call, target) || step.argumentsAuthored === true;
}

/**
 * Are this step's arguments fixed by the graph rather than by the run?
 *
 * Computed at the dispatch site, where the step is still in hand. `{{…}}`
 * anywhere — template or resolved input — means something the run supplied
 * reached the arguments, and the step keeps its gate.
 */
export function stepArgumentsAreAuthored(step: {
  toolInput?: Record<string, unknown>;
  toolInputTemplate?: string;
}): boolean {
  if (step.toolInputTemplate && step.toolInputTemplate.includes('{{')) return false;
  if (step.toolInput) {
    try {
      if (JSON.stringify(step.toolInput).includes('{{')) return false;
    } catch {
      // Unserialisable input is not something we can vouch for.
      return false;
    }
  }
  return true;
}
