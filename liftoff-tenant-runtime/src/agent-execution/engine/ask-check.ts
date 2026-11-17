// The ask check: does a recovery decision that is about to become an item
// for a person need one?
//
// Asks and escalations reach people on the model's say-so. Nothing checked
// whether the run already held the value it was asking for (the distiller's
// own worked failure: "which repository?" with four named and one defaulted),
// or whether a workspace could act on what was being escalated
// (`whoCanUnblock` is the model's guess, and the prompt tells it to say
// `platform` when unsure). This asks both, add-only against noise:
//
//   a question the run can answer itself  → an in-run continuation, not a
//                                            park (the advisor is invoked once
//                                            more with a hint in its facts)
//   an escalation nobody here can act on  → posted as system_internal
//   everything else                        → the ask posts exactly as today
//
// Never on a system_internal escalation, never on a blocker origin (a person
// must act outside the product), never on Anchor's intervention
// clarifications. It never suppresses a blocker, never downgrades an
// approval, and never touches the sensitive-work gate.

import { logger } from '../../infrastructure/logging';
import { LruCache } from '../../infrastructure/lru-cache';
import { ask } from '../../typesafe/client';
import {
  ASK_CHECK_SET,
  ASK_INPUTS_MAX_CHARS,
  ASK_RECENT_RESULTS_MAX_CHARS,
  ASK_STEP_OUTPUTS_MAX_CHARS,
  asEntry,
} from '../../typesafe/questions';
import { isAskCheckEnabled } from '../../typesafe/flags';
import { redactSecrets } from '../../security/log-redactor';
import { boundedContract, type HitlContract } from '../../hitl-enforcement/contract-check';

export type AskKind = 'question' | 'escalation';
export type AnswerSource = 'inputs' | 'step_output' | 'instructions';

export interface AskCheckInput {
  ask: {
    kind: AskKind;
    text: string;
    requestedAction?: string;
    whoCanUnblock?: string;
  };
  /** Phase 5's contract for this run: the current step, or instructions + role. */
  contract?: HitlContract;
  known: {
    inputs?: unknown;
    recentToolResults?: unknown;
    stepOutputs?: unknown;
  };
  setting: 'exceptions' | 'important' | 'sensitive';
  /** For a question that would park: the clarification row's origin. A
   *  blocker never enters (a person must act outside the product). Absent on
   *  an escalation that posts as a row of its own. */
  origin?: 'question' | 'blocker';
  /** For an escalation: where it would post. system_internal never enters. */
  escalationKind?: 'escalation' | 'system_internal';
  /** The clarification's source. anchor_intervention never enters. */
  source?: 'recovery_llm' | 'anchor_intervention';
  /** One continuation per ask fingerprint, per invocation. */
  fingerprint: string;
  tenantId: string;
  /** The RUNTIME agent id. */
  agentId?: string;
  invocationId?: string;
}

export type AskCheckVerdict =
  | { kind: 'unchanged' }
  | { kind: 'self_answer'; source: AnswerSource; hint: string; p: number }
  | { kind: 'not_actionable'; p: number };

/** The whole call's budget. */
export const ASK_CHECK_DEADLINE_MS = 30_000;

/** The fixed sentence the advisor is handed, per source. Never a value: the
 *  hint says where the answer is, not what it is. */
export const SELF_ANSWER_HINTS: Readonly<Record<AnswerSource, string>> = {
  inputs: "The value you asked for is in the run's inputs. Use it and continue.",
  step_output: "The value you asked for is in the previous step's output. Use it and continue.",
  instructions: 'The value you asked for is in your instructions. Use it and continue.',
};

/** Asks already continued once, keyed by invocation and fingerprint: the
 *  `markNudged` discipline (verify-on-stop.ts). A second ask on the same
 *  fingerprint parks as today. Bounded and expiring, like the nudge record. */
const CONTINUATIONS = { max: 5_000, ttlMs: 6 * 60 * 60 * 1000 };
let continued = new LruCache<string, true>(CONTINUATIONS);
function continuationKey(invocationId: string | undefined, fingerprint: string): string {
  return `${invocationId ?? 'none'}|${fingerprint}`;
}
export function wasContinued(invocationId: string | undefined, fingerprint: string): boolean {
  return continued.get(continuationKey(invocationId, fingerprint)) === true;
}
export function markContinued(invocationId: string | undefined, fingerprint: string): void {
  continued.set(continuationKey(invocationId, fingerprint), true);
}
export function _resetContinuationsForTesting(): void {
  continued = new LruCache<string, true>(CONTINUATIONS);
}

function bounded(value: unknown, max: number): string {
  if (value === undefined || value === null) return '';
  let text: string;
  try {
    text = typeof value === 'string' ? redactSecrets(value) as string : JSON.stringify(redactSecrets(value));
  } catch {
    text = '';
  }
  return text.length > max ? text.slice(0, max) : text;
}

/** The state the vendor sees, bounded and sanitised. Exported for the test. */
export function askCheckState(input: AskCheckInput): unknown {
  return {
    ask: {
      kind: input.ask.kind,
      text: bounded(input.ask.text, ASK_INPUTS_MAX_CHARS),
      ...(input.ask.requestedAction ? { requestedAction: bounded(input.ask.requestedAction, ASK_INPUTS_MAX_CHARS) } : {}),
      ...(input.ask.whoCanUnblock ? { whoCanUnblock: input.ask.whoCanUnblock } : {}),
    },
    contract: input.contract ? boundedContract(input.contract) : null,
    known: {
      inputs: bounded(input.known.inputs, ASK_INPUTS_MAX_CHARS),
      recentToolResults: bounded(input.known.recentToolResults, ASK_RECENT_RESULTS_MAX_CHARS),
      stepOutputs: bounded(input.known.stepOutputs, ASK_STEP_OUTPUTS_MAX_CHARS),
    },
    setting: input.setting,
  };
}

type Head = { choice?: string; probabilities?: Record<string, number> } | undefined;

export async function checkAsk(input: AskCheckInput): Promise<AskCheckVerdict> {
  const unchanged: AskCheckVerdict = { kind: 'unchanged' };
  if (!isAskCheckEnabled()) return unchanged;
  if (input.origin === 'blocker') return unchanged;
  if (input.escalationKind === 'system_internal') return unchanged;
  if (input.source === 'anchor_intervention') return unchanged;
  if (input.ask.kind === 'question' && wasContinued(input.invocationId, input.fingerprint)) return unchanged;

  const answer = await ask(ASK_CHECK_SET, asEntry(askCheckState(input)), {
    deadlineMs: ASK_CHECK_DEADLINE_MS,
    tenantId: input.tenantId,
    ...(input.agentId ? { runtimeAgentId: input.agentId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
  });
  if (!answer) return unchanged;
  const answers = answer.answers as Record<string, Head>;
  const log = {
    tenant_id: input.tenantId,
    agent_id: input.agentId,
    invocation_id: input.invocationId,
    kind: input.ask.kind,
    call_id: answer.callId,
  };

  if (input.ask.kind === 'question') {
    const answerable = answers.answerable_from_context;
    const p = answerable?.probabilities?.yes ?? 0;
    if (answerable?.choice !== 'yes' || p < (ASK_CHECK_SET.thresholds.SELF_ANSWER_T as number)) return unchanged;
    const source = answers.answer_source?.choice;
    if (source !== 'inputs' && source !== 'step_output' && source !== 'instructions') {
      // A `none` source is treated as not answerable.
      logger.info({ ...log, metric: 'ask_check.self_answer_no_source', probability: p }, 'ask check: answerable but no source; the ask posts as today');
      return unchanged;
    }
    logger.info({ ...log, metric: 'ask_check.self_answer', probability: p, source }, 'ask check: the run holds the value it asked for; continuing without a park');
    return { kind: 'self_answer', source, hint: SELF_ANSWER_HINTS[source], p };
  }

  const canAct = answers.person_can_act;
  const p = canAct?.probabilities?.no ?? 0;
  if (canAct?.choice !== 'no' || p < (ASK_CHECK_SET.thresholds.NOT_ACTIONABLE_T as number)) return unchanged;
  logger.info({ ...log, metric: 'ask_check.not_actionable', probability: p }, 'ask check: nobody in the workspace can act on this escalation; posting as an operator record');
  return { kind: 'not_actionable', p };
}
