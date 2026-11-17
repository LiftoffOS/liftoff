// What a "yes" covers — computed, never authored.
//
// A person has already expressed their governance twice: in the hire (what it
// may do on its own) and on /dashboard/oversight (when it must ask). So the
// reasons a call can ask for approval are a CLOSED set the code already has —
// the oversight-driven gate reasons — and an approval is a grant over the set
// of those reasons in force for the calls that will run. Nobody authors a
// scope; this derives it.
//
// The evaluator is PURE and VERSIONED. Pure so the same calls under the same
// settings always yield the same set — the approval persists the set it
// granted, and consumption recomputes against the settings AS THEY ARE NOW and
// compares. A reason in force now that the grant did not cover is a control
// somebody tightened in between, and the person is asked once, about that
// reason only. Versioned so that a later change to what a reason MEANS cannot
// misread an old grant: a grant recorded under one version is never compared
// against a set computed under another.
//
// It computes the SET, where `checkHitlGate` answers with the FIRST reason by
// precedence; the gate short-circuits because one ask is what a person sees,
// and this must not, because a grant that covers only the first reason would
// re-ask for the second on resume — forever. The two read the same shared
// helpers, and `approval-obligations.test.ts` holds them to the same answer on
// the first reason so they cannot drift apart. The gate is not the only place
// a run pauses: the Communication pre-check (`maybeConvertToDraft`) runs ahead
// of it on every call, and it is mirrored here too, because a workspace moved
// from Auto to Review between the yes and the resume is a control tightened
// like any other.
//
// Standing policies are one INPUT here, read by the caller: this function does
// no I/O. A standing approval clears the reason it names, subject to the same
// rules the gate applies — never super_destructive, and external_content_write
// only when the policy's action classes cover every call.

import type { GateReason } from '@liftoffos/governance-types';
import { hardInvariantEffectOf, type ModelTool, type OversightSettings, type ToolCallRequest } from './types';
import { isInProcessBookkeepingTool, isOwnWorkspaceChatTool, isSelfWakeTool, resolveGateTool, bareToolActionName } from './tool-name-resolution';
import { classifyVendorToolEffect, toolIsReadOnly } from '../tool-gateway/tool-effect';
import { isInternalCollaborationTool, isOutboundTool, sensitiveWorkMatch } from '../tool-gateway/oversight-decision';
import { isInPlaceReply, type TriggerTarget } from './in-place-reply';
import { inDeclaredScope, type DeclaredStep } from './declared-scope';
import { surfacingPolicyOf } from './surfacing';
import {
  quantifyPlan,
  DEFAULT_QUANTIFIER_THRESHOLDS,
  type QuantifierThresholds,
  type RunningTotals,
} from '../tool-gateway/plan-quantifier';
import { stagedApplyReasons } from '../tool-gateway/staged-batches';

/** Bumped when the meaning of any reason below changes — a threshold, a
 *  category rule, an exemption, a new rule that can put a reason into the set.
 *  A grant recorded under an older version is not comparable and must be
 *  re-asked rather than misread.
 *
 *  History, so a bump is never guessed at: 1 mirrored `checkHitlGate` as it
 *  stood; 2 added the staged-batch rule, under which an apply-role tool is a
 *  `blast_radius` reason whatever the size thresholds say; 3 added the
 *  Communication rule, mirroring the pre-check that runs ahead of the gate. */
export const OBLIGATION_EVALUATOR_VERSION = 3;

/** A standing decision the governance engine holds for one reason. */
export interface StandingPolicy {
  decision: 'approved' | 'rejected';
  /** For external_content_write: the bare action names the grant covers. A
   *  reason-wide policy (undefined) does not clear that invariant. */
  actionClasses?: readonly string[];
}

export interface ObligationConfig {
  hitlLevel: number;
  oversight: OversightSettings | undefined;
  /** The tools as the gate sees them: description (the DESTRUCTIVE marker),
   *  effect and categories. Resolved per call through `resolveGateTool`, the
   *  same lookup the gate uses, so a wrapped or aliased name is judged as the
   *  catalog entry it names. */
  tools: ModelTool[];
  trustLevel?: 'trusted' | 'untrusted_inbound';
  externalContentGateDisabled?: boolean;
  triggerTarget?: TriggerTarget;
  declaredStep?: DeclaredStep;
  standingPolicies?: Partial<Record<GateReason, StandingPolicy>>;
  /** Blast radius is cumulative: what this run has already touched. */
  runningTotals?: RunningTotals;
  thresholds?: QuantifierThresholds;
}

export interface ObligationSet {
  version: number;
  /** Sorted, deduplicated. Empty means nothing about these calls asks. */
  reasons: GateReason[];
  /** Why size gated, when it did. */
  measuredReasons?: string[];
}

/** The rank of every reason in the order `checkHitlGate` answers: the first
 *  of these present in a set is the reason the gate would have named.
 *
 *  A `Record` over the shared union rather than a list, so it is EXHAUSTIVE
 *  by compilation: a reason added to `@liftoffos/governance-types` without a
 *  rank here is a type error, and so is a rank for a reason the union no
 *  longer has. That is the runtime half of the vocabulary fence — the set
 *  this evaluator can emit is exactly the union, and the review queue's label
 *  map is held to that same union by the web app's own fence
 *  (`oversight.vocabulary.test.ts`), so every code this can return is one the
 *  queue can show without either side keeping a hand-copied list. */
const REASON_RANK: Readonly<Record<GateReason, number>> = {
  super_destructive_gate: 0,
  merge_to_main: 1,
  external_content_write: 2,
  level_1_gate: 3,
  destructive_gate: 4,
  sensitive_work: 5,
  blast_radius: 6,
  rate_limit_exceeded: 7,
  // Raised only on an allow, after every other reason in the gate declined to
  // fire, and before the communication review that runs at execute time. Not
  // recomputed by the evaluator: the verdict is a vendor call at gate time,
  // not a rule over the calls and the configuration.
  contract_deviation: 8,
  communication_review: 9,
};

/** The precedence `checkHitlGate` answers in, derived from the ranks. */
export const REASON_PRECEDENCE: readonly GateReason[] = (Object.keys(REASON_RANK) as GateReason[])
  .sort((a, b) => REASON_RANK[a] - REASON_RANK[b]);

const BLAST_RADIUS: GateReason = 'blast_radius';

/**
 * The reasons in force for these calls under this configuration.
 *
 * Every rule here mirrors a branch of `checkHitlGate`, on the same helpers,
 * minus the I/O and minus the short-circuit. Where the gate returns early, this
 * records the reason and keeps going.
 */
export function evaluateApprovalObligations(
  finalCalls: readonly ToolCallRequest[],
  config: ObligationConfig,
): ObligationSet {
  const reasons = new Set<GateReason>();
  let measuredReasons: string[] | undefined;
  if (finalCalls.length === 0) return { version: OBLIGATION_EVALUATOR_VERSION, reasons: [] };

  const policies = config.standingPolicies ?? {};
  const cleared = (reason: GateReason): boolean => {
    const p = policies[reason];
    if (!p || p.decision !== 'approved') return false;
    // The gate's own rules for what a standing approval may clear.
    if (reason === 'super_destructive_gate') return false;
    if (reason === 'external_content_write') {
      if (!Array.isArray(p.actionClasses)) return false;
      const covered = new Set(p.actionClasses);
      return finalCalls.every((c) => covered.has(bareToolActionName(c.name)));
    }
    return true;
  };
  const add = (reason: GateReason) => { if (!cleared(reason)) reasons.add(reason); };

  // 1. Hard invariants, by effect.
  for (const call of finalCalls) {
    const effect = hardInvariantEffectOf(call.name);
    if (effect === undefined) continue;
    if (effect === 'merge_to_protected_branch') add('merge_to_main');
    else add('super_destructive_gate');
  }

  // 1b. The external-content write invariant.
  if (config.trustLevel === 'untrusted_inbound' && !config.externalContentGateDisabled) {
    const effectful = finalCalls.some((call) => {
      if (isInProcessBookkeepingTool(call.name)) return false;
      if (isSelfWakeTool(call.name)) return false;
      if (isOwnWorkspaceChatTool(call.name)) return false;
      const tool = resolveGateTool(call, config.tools);
      if (toolIsReadOnly(tool as { effect?: 'read' | 'write' | 'spawn'; categories?: string[] } | undefined)) return false;
      const unclassified = !!tool
        && (tool as { effect?: unknown }).effect === undefined
        && (((tool as { categories?: string[] }).categories?.length ?? 0) === 0);
      if (unclassified && classifyVendorToolEffect(bareToolActionName(call.name)) === 'read') return false;
      if (isOutboundTool(tool as { categories?: string[] } | undefined)) return false;
      if (isInternalCollaborationTool(tool as { categories?: string[] } | undefined)) return false;
      return true;
    });
    const allInPlace = finalCalls.every((call) => {
      const tool = resolveGateTool(call, config.tools);
      return isInPlaceReply(
        {
          name: call.name,
          input: call.input as Record<string, unknown> | undefined,
          categories: (tool as { categories?: string[] } | undefined)?.categories,
          effect: tool?.effect,
        },
        config.triggerTarget,
      );
    });
    const allDeclaredAndAuthored = config.declaredStep?.argumentsAuthored === true
      && finalCalls.every((call) => inDeclaredScope(
        { name: call.name, input: call.input as Record<string, unknown> | undefined },
        config.declaredStep,
        config.triggerTarget,
      ));
    if (effectful && !allInPlace && !allDeclaredAndAuthored) add('external_content_write');
  }

  // 2/3. Level 4 and 5 gate nothing by kind (rate limits are counted, not
  // configured, so they are not an obligation a grant can cover).
  if (config.hitlLevel === 1) add('level_1_gate');
  if (config.hitlLevel === 2) {
    const destructive = finalCalls.some((call) =>
      resolveGateTool(call, config.tools)?.description?.includes('⚠️ DESTRUCTIVE'));
    if (destructive) add('destructive_gate');
  }

  // 5. Sensitive work, minus declared scope. The Escalation setting is read
  // through the same surfacing policy the gate reads it through
  // (surfacing.ts), so the reasons this computes are the ones the gate names.
  if (config.hitlLevel <= 3 || config.hitlLevel === 4) {
    const oversight = config.oversight;
    const surfacing = surfacingPolicyOf(oversight);
    const sensitiveWorkGates = surfacing
      ? surfacing.sensitiveWorkGates
      : !!oversight && (oversight.escalation === 'sensitive' || oversight.escalation === 'important');
    if (oversight && sensitiveWorkGates) {
      const enabled = Object.entries(oversight.sensitiveWork ?? {})
        .filter(([, on]) => on)
        .map(([category]) => category);
      const matched = finalCalls.some((call) => {
        const tool = resolveGateTool(call, config.tools);
        return (tool?.categories ?? []).some((c) => enabled.includes(c));
      });
      const allDeclared = !!config.declaredStep && finalCalls.every((call) => inDeclaredScope(
        { name: call.name, input: call.input as Record<string, unknown> | undefined },
        config.declaredStep,
        config.triggerTarget,
      ));
      if (matched && !allDeclared) add('sensitive_work');
    }
  }

  // 5b. Communication, as the pre-check ahead of the gate applies it to every
  // outbound call. Under Review an outbound call falling under an enabled
  // sensitive-work toggle — by the same match the pre-check uses, which reads
  // a native send's generic `outbound` as external publishing — asks as
  // sensitive work. Under Draft-first every outbound call is one the
  // pre-check would have drafted instead of sent, or paused where no draft
  // form exists; the consumption point can do neither, so an approved send
  // under a workspace that has since gone Draft-first is asked about once.
  const communication = config.oversight?.communication;
  if (communication === 'review' || communication === 'draft') {
    for (const call of finalCalls) {
      const tool = resolveGateTool(call, config.tools);
      if (!isOutboundTool(tool as { categories?: string[] } | undefined)) continue;
      if (communication === 'draft') add('communication_review');
      else if (sensitiveWorkMatch(tool as { categories?: string[] } | undefined, config.oversight?.sensitiveWork)) add('sensitive_work');
    }
  }

  // Size, after kind. A staged batch's apply is a size ask by definition —
  // the one ask covering N staged writes — and asks whatever the thresholds
  // say, so the grant records it and the gate's answer agrees.
  const staged = stagedApplyReasons(
    finalCalls.map((c) => ({ name: c.name, input: c.input })),
    (name) => resolveGateTool({ id: '', name, input: {} }, config.tools) as { name: string; writeRole?: string } | undefined,
  );
  if (staged.length > 0) {
    add(BLAST_RADIUS);
    if (!cleared(BLAST_RADIUS)) measuredReasons = staged;
  }
  const size = quantifyPlan(
    finalCalls.map((c) => ({ name: c.name, input: (c.input ?? {}) as Record<string, unknown> })),
    config.runningTotals ?? { entitiesTouched: 0, destructiveOps: 0, clearedFields: 0 },
    config.thresholds ?? DEFAULT_QUANTIFIER_THRESHOLDS,
  );
  if (size.decision === 'confirm_required') {
    add(BLAST_RADIUS);
    if (!cleared(BLAST_RADIUS)) measuredReasons = [...(measuredReasons ?? []), ...size.reasons];
  }

  const ordered = REASON_PRECEDENCE.filter((r) => reasons.has(r));
  return {
    version: OBLIGATION_EVALUATOR_VERSION,
    reasons: ordered,
    ...(measuredReasons ? { measuredReasons } : {}),
  };
}

/** The reasons in force now that the grant did not cover — a control
 *  tightened between approval and resume. Empty when the grant covers the
 *  current set. A grant recorded under another evaluator version covers
 *  nothing: it was computed by rules this version may no longer share. */
export function uncoveredObligations(
  granted: { version: number; reasons: readonly GateReason[] } | null | undefined,
  current: ObligationSet,
): GateReason[] {
  if (!granted || granted.version !== current.version) return [...current.reasons];
  const have = new Set(granted.reasons);
  return current.reasons.filter((r) => !have.has(r));
}
