// Terminal-state resolution (migration 332).
//
// A run's ending was encoded as independent booleans — `success`, `escalated`,
// plus `state.governanceStopped` on the side — and six of the seven escalation
// paths set `success:true` AND `escalated:true` together. Consumers each picked
// their own precedence, so the SAME run was reported differently depending on
// who asked:
//
//   invocations.outcome   success first  -> 'success'   (escalated ran as clean)
//   thread status         success first  -> 'completed' (never surfaced to a human)
//   agent runtime status  escalated first-> WAITING_FOR_HUMAN  (correct)
//   agent run state       escalated first-> 'interrupted'      (correct)
//
// So a run could record outcome='success' with error_message 'permanent tool
// error x2 ... not retryable' while creating an escalation: the platform
// raising escalations that its own run record and thread both called
// successes.
//
// This module is the single precedence rule plus the total maps every consumer
// reads. Pure — no DB, no LLM, no clock — mirroring failure-classification.ts.

import type { FailureClass, InvocationOutcome, ThreadStatus } from '../invocations/types';
import type { TaskExecutionResult, TerminalState } from './types';
import type { AgentRunState } from './run-state/types';

/** The one precedence rule.
 *
 *  An explicit `terminalState` always wins — new producers set it directly.
 *  Otherwise it is derived, and `escalated` is checked BEFORE `success`: that
 *  ordering is the whole fix for the legacy sites that set both. Anything that
 *  reaches here neither succeeded, escalated nor was gated is an engine failure. */
export function resolveTerminalState(
  result: Pick<TaskExecutionResult, 'terminalState' | 'escalated' | 'success' | 'paused' | 'pauseKind'>,
  governanceStopped: boolean,
): TerminalState {
  if (result.terminalState) return result.terminalState;
  // BEFORE the success check, and that order is the whole point. A pause is
  // returned as `{ success: true, paused: true }` with no terminalState, so
  // asking about `success` first answered 'success' for every run that had
  // stopped to wait for a person — the agent went IDLE, the invocation
  // recorded success, and the thread read 'completed' while an approval sat
  // pending against it. Checked here rather than at each of the consumers so
  // there is one place to be right instead of a dozen places to remember.
  // A pause that resumes ITSELF is not a pause that needs a person, and the
  // difference is visible right here in `pauseKind`. Everything downstream reads
  // 'paused' as "someone owes this run a decision", so a wall-clock park was
  // reporting the agent WAITING_FOR_HUMAN with nothing asked of anyone.
  if (result.paused) return result.pauseKind === 'continuation' ? 'parked' : 'paused';
  if (governanceStopped) return 'gated';
  if (result.escalated) return 'escalated';
  if (result.success) return 'success';
  return 'engine_error';
}

/** invocations.outcome — CHECK is ('success','error','escalated','gated') per migration 329. */
export const OUTCOME_BY_TERMINAL: Record<TerminalState, InvocationOutcome> = {
  success: 'success',
  escalated: 'escalated',
  gated: 'gated',
  task_failed: 'error',
  engine_error: 'error',
  // Not a success: the objective was never reported met. 'error' is the only
  // non-success member the CHECK admits, so the distinction lives in
  // failure_class = 'limit_reached' rather than in the outcome column.
  limit_reached: 'error',
  // invocations.outcome has no 'stopped' member (its CHECK is migration 329);
  // a user stop is not a failure, and the audit detail 'user_stopped' carries
  // the distinction for ops queries.
  stopped: 'success',
  // Nor a 'paused' member. 'gated' is the honest existing choice: the run
  // stopped and is waiting on a person, which is precisely what 'gated' means
  // to every consumer of this column. Emphatically NOT 'success' — that is the
  // value it used to fall through to, which is how a run holding a pending
  // approval was recorded as having finished its work.
  paused: 'gated',
  // Its own member rather than borrowing one. 'gated' would repeat the mistake
  // above one layer along: the run is not waiting on a person and reporting it
  // that way sends someone looking for a decision to make. 'success' is worse —
  // the objective is not met yet. Added to the CHECK by migration 390, the same
  // move 329 made for 'gated' and for the same stated reason.
  parked: 'parked',
};

/** threads.status. A run waiting on a human must never read as 'completed'. */
export const THREAD_STATUS_BY_TERMINAL: Record<TerminalState, ThreadStatus> = {
  success: 'completed',
  escalated: 'waiting_on_human',
  gated: 'waiting_on_human',
  task_failed: 'failed',
  engine_error: 'failed',
  limit_reached: 'failed',
  stopped: 'completed',
  // The invariant in this map's own header, finally held. A paused run used to
  // resolve to 'success' and land here as 'completed' — a thread reading as
  // finished while a person still owed it a decision.
  paused: 'waiting_on_human',
  // 'open', because the thread IS still being worked and no one is being asked
  // for anything. The person sees a run in progress, which is what is happening.
  parked: 'open',
};

/** AgentRunState.status (run-state/types.ts).
 *
 *  The third total map, and the last consumer that was still deriving its own
 *  precedence inline. The site in executeTaskInner read
 *
 *    terminalState === 'escalated' ? 'interrupted'
 *      : (terminalState === 'success' ? 'complete' : 'failed')
 *
 *  so `paused`, `gated`, `stopped` and `limit_reached` ALL fell to 'failed' —
 *  while THREAD_STATUS_BY_TERMINAL, three lines away, resolved the same paused
 *  and gated runs to 'waiting_on_human'. That is precisely the situation this
 *  module's header says it exists to end: the same run reported differently
 *  depending on who asked. The invariant auditors read
 *  `RawEngineEvidence.runState` and the stalled-run reconciler branches on these
 *  values, so a run waiting on a person looked to both of them like one that had
 *  crashed.
 *
 *  'interrupted' is the value for a run that stopped and is WAITING: escalated
 *  (handed to a person) and the two pauses (paused, gated). agent-status derives
 *  `isTerminal` from this column — `complete || failed` — so 'interrupted' is
 *  also the statement that the run is not over, which is exactly true of all
 *  three.
 *
 *  `stopped` is 'complete', NOT 'interrupted', and the difference matters: a user
 *  stop is over, nothing resumes it, and 'interrupted' would report it as still
 *  running to `/agent-status`. It also keeps this map consistent with its two
 *  siblings, which both already treat a user stop as a completion
 *  (OUTCOME_BY_TERMINAL -> 'success', THREAD_STATUS_BY_TERMINAL -> 'completed').
 *
 *  `limit_reached` stays 'failed': the run was cut off with the objective unmet
 *  and nothing is coming back for it. */
export const RUN_STATE_BY_TERMINAL: Record<TerminalState, AgentRunState['status']> = {
  success: 'complete',
  escalated: 'interrupted',
  gated: 'interrupted',
  paused: 'interrupted',
  // 'interrupted' for the same reason the two pauses are: agent-status derives
  // isTerminal from complete||failed, and a parked run is emphatically not over.
  parked: 'interrupted',
  stopped: 'complete',
  task_failed: 'failed',
  engine_error: 'failed',
  limit_reached: 'failed',
};

/** audit_logs.outcome has its OWN, narrower CHECK — ('success','error','gated'),
 *  migration 016 — with no 'escalated' member. Mapping escalated -> 'gated'
 *  there is CORRECT, not the copy-paste bug it resembles. */
/** The `error_code` an escalated run stamps on its terminal audit row.
 *
 *  Audit outcome 'gated' is not one thing: escalated, gated and paused all map
 *  to it below, because audit_logs.outcome has no wider vocabulary. Only
 *  `escalated` is a run that has ENDED — the other two are still live and
 *  waiting on a person. Anything deciding whether a run can be re-run has to
 *  separate them, and this marker is where that distinction lives. Mirrors the
 *  existing 'user_stopped' marker, which exists for the same reason on the
 *  'success' side. */
export const ESCALATED_AUDIT_MARKER = 'escalated';

/** audit_logs.error_code for a run that PARKED. Distinguishes it from a real
 *  gate under the shared 'gated' outcome, so the Activity page can say "still
 *  working" rather than offering a decision nobody was asked for. */
export const PARKED_AUDIT_MARKER = 'parked';

export const AUDIT_OUTCOME_BY_TERMINAL: Record<TerminalState, 'success' | 'error' | 'gated'> = {
  success: 'success',
  escalated: 'gated',
  gated: 'gated',
  task_failed: 'error',
  engine_error: 'error',
  limit_reached: 'error',
  stopped: 'success',
  // Same reasoning as the invocation outcome: audit_logs.outcome has no
  // 'paused' member, and 'gated' is what a run stopped awaiting a human is.
  paused: 'gated',
  // audit_logs.outcome lives in platform-backend with the narrowest CHECK of
  // the three ('success','error','gated'), so this one DOES borrow — and the
  // Activity page tells it apart by PARKED_AUDIT_MARKER in error_code, the way
  // it already tells an escalation from a gate. Widening a constraint in
  // another repo to improve one label is not worth a cross-repo landing.
  parked: 'gated',
};

/** The states that persist outcome='error' and therefore owe a failure_class. */
const FAILURE_STATES: readonly TerminalState[] = ['task_failed', 'engine_error', 'limit_reached'];

export function isFailureState(state: TerminalState): boolean {
  return FAILURE_STATES.includes(state);
}

/** Classification is TOTAL: a failing run is never written with a NULL class.
 *
 *  classifyFailure only ever ran on the thrown path, so every failure that
 *  RETURNED instead of throwing — exactly the deliberate, reasoned ones — was
 *  stored NULL and became indistinguishable from a crash. Defaulting to
 *  'unknown' turns any site we have not classified into a queryable to-do list
 *  (`WHERE failure_class = 'unknown'`) instead of an invisible gap. */
export function resolveFailureClass(
  state: TerminalState,
  explicit?: FailureClass,
): FailureClass | undefined {
  if (!isFailureState(state)) return undefined;
  return explicit ?? 'unknown';
}

/** Trigger-level terminality for the run-idempotency ledger.
 *
 *  Only a genuine ENGINE failure re-opens the trigger row for redelivery. A
 *  deliberate task failure was processed to a determined answer, so replaying
 *  the cached result is right and re-running would burn another full run to
 *  reach the same conclusion. Mirrors the existing treatment of paused and
 *  escalated ("it WAS processed — it suspended"). */
export function isTerminalForTrigger(state: TerminalState): boolean {
  return state !== 'engine_error';
}

/** Polarity for the learning loops (memory usefulness, skills flywheel).
 *
 *  'none' matters: an escalated or gated run is NOT evidence that the injected
 *  memories were unhelpful — a human was asked to act, which says nothing about
 *  retrieval quality. Scoring it negative would penalise memories for the
 *  platform's own governance decisions. */
export function learningSignal(state: TerminalState): 'positive' | 'negative' | 'none' {
  if (state === 'success') return 'positive';
  // Running out of budget is not evidence the injected memories were unhelpful —
  // the run was cut off, not misled. Same reasoning as escalated/gated above.
  if (state === 'limit_reached') return 'none';
  return isFailureState(state) ? 'negative' : 'none';
}

/** Who can clear a blocker the agent reported.
 *
 *  'customer' — someone in the workspace: grant access, unpause a team, choose
 *  between options, supply a value. 'platform' — only we can: a misconfigured
 *  or broken connector, an unreachable provider, an internal error. */
export type UnblockableBy = 'customer' | 'platform';

/** The agent's own verdict, as reported through the report_task_outcome tool. */
export interface ReportedTaskOutcome {
  status: 'complete' | 'fail' | 'escalate';
  summary: string;
  /** status='escalate' only. Absent when the model did not say, which routes to
   *  the operator record: an unattributed blocker is not the customer's. */
  whoCanUnblock?: UnblockableBy;
  /** status='escalate' only: the one thing that person should do. */
  requestedAction?: string;
}

/** Recognise a report_task_outcome call off the adapter event stream.
 *
 *  Anthropic namespaces MCP tools (`mcp__liftoff-tool-gateway__<name>`) while
 *  the bridge engines dispatch on the bare catalog name (mcp-bridge matches
 *  catalog.tools by exact name), so both shapes must be accepted. Shared by the
 *  conversational and workflow-step loops so they cannot drift.
 *
 *  Returns null for anything that is not a well-formed report, so a malformed
 *  call is ignored rather than silently recorded as some default verdict. */
export function readTaskOutcomeReport(toolName: string, args: unknown): ReportedTaskOutcome | null {
  if (toolName !== 'report_task_outcome' && !toolName.endsWith('__report_task_outcome')) {
    return null;
  }
  const a = args as {
    status?: unknown; summary?: unknown; whoCanUnblock?: unknown; requestedAction?: unknown;
  } | null | undefined;
  const status = a?.status;
  if (status !== 'complete' && status !== 'fail' && status !== 'escalate') return null;
  // Anything other than the two known values reads as absent, and absent routes
  // to the operator record. A typo must not put a platform fault in front of a
  // customer.
  const whoCanUnblock = a?.whoCanUnblock === 'customer' || a?.whoCanUnblock === 'platform'
    ? a.whoCanUnblock
    : undefined;
  return {
    status,
    summary: typeof a?.summary === 'string' ? a.summary : '',
    whoCanUnblock,
    requestedAction: typeof a?.requestedAction === 'string' && a.requestedAction.trim()
      ? a.requestedAction
      : undefined,
  };
}

/** The name of the tool a workflow step calls to hand back its declared output.
 *
 *  A step that declares `outputField` has a CONTRACT with the next step. The
 *  adapter returns joined assistant text, and `getByPath` rejects a non-object
 *  on its first hop, so free text could never satisfy that contract — every
 *  such step threw `OutputShapeMismatchError`, on every run. This tool is the
 *  channel that makes it satisfiable, and it is deliberately the same mechanism
 *  `report_task_outcome` already uses: the value is the captured INPUT, read off
 *  the adapter event stream, never the tool's return. */
export const STEP_OUTPUT_TOOL = 'record_step_output';

/** Recognise a record_step_output call off the adapter event stream.
 *
 *  Same namespacing rule as `readTaskOutcomeReport`: Anthropic prefixes MCP
 *  tools (`mcp__liftoff-tool-gateway__<name>`) while the bridge engines dispatch
 *  on the bare catalog name, so both shapes must be accepted.
 *
 *  `expectedField` is the step's declared `outputField`. Its FIRST segment is
 *  what the tool schema requires, because `outputField` is a dot-path and the
 *  step is asked for the root object the path is read from — a step declaring
 *  `customer.email` records `{customer: {...}}` and the caller walks the rest.
 *
 *  Returns null for a call that does not carry that key, so a malformed report
 *  falls through to the same OutputShapeMismatchError a missing call gets,
 *  rather than registering an object of a shape nobody declared. */
export function readStepOutputReport(
  toolName: string,
  args: unknown,
  expectedField: string,
): Record<string, unknown> | null {
  if (toolName !== STEP_OUTPUT_TOOL && !toolName.endsWith(`__${STEP_OUTPUT_TOOL}`)) {
    return null;
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  const root = expectedField.split('.')[0];
  if (!root) return null;
  const a = args as Record<string, unknown>;
  if (!Object.hasOwn(a, root)) return null;
  return { ...a, [root]: asRecordedValue(a[root], root) };
}

/** The value a step recorded, read past two ways the model writes it that
 *  mean the same thing.
 *
 *  A value written as JSON text is the value: `reddit: "{\"posts\": [...]}"`
 *  carries the object a downstream `{{steps.s3.posts}}` reads, and a string
 *  has no `posts`. And a value wrapped once more under its own key —
 *  `digest: { digest: { digest_text } }` — is the object told to go "inside
 *  digest", put inside a second digest. Both left every downstream read
 *  resolving to nothing while the record itself succeeded. The contract is
 *  the keys later steps read; the depth and the encoding are not part of it.
 *  Anything else is returned as written. */
function asRecordedValue(value: unknown, root: string): unknown {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        return JSON.parse(text);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>);
    const inner = (value as Record<string, unknown>)[root];
    if (keys.length === 1 && keys[0] === root && inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return inner;
    }
  }
  return value;
}

/** Terminal markers kept working for instructions distilled against the older
 *  `[COMPLETE]` / `[FAIL]` / `[ESCALATE]` response contract. This is a
 *  COMPATIBILITY SHIM, not the contract — report_task_outcome is. Returns null
 *  when no marker is present so the caller keeps its existing behaviour. */
export function parseTerminalMarker(
  text: string | undefined,
): { state: 'task_failed' | 'escalated'; reason: string; whoCanUnblock?: UnblockableBy } | null {
  const t = text ?? '';
  if (t.includes('[FAIL]')) {
    return { state: 'task_failed', reason: afterMarker(t, '[FAIL]') };
  }
  // `[ESCALATE:customer]` / `[ESCALATE:platform]` say who can clear it, the same
  // question report_task_outcome asks. The bare `[ESCALATE]` predates that and
  // stays valid; it simply cannot answer, and an unattributed blocker is ours.
  //
  // An unrecognised qualifier is still an escalation. Reading it as "no marker"
  // would drop the agent's last word entirely and record the run as though it
  // had ended cleanly — a far worse failure than an unattributed blocker.
  const escalate = t.match(/\[ESCALATE(?::([A-Za-z_]+))?\]/);
  if (escalate) {
    const qualifier = escalate[1]?.toLowerCase();
    return {
      state: 'escalated',
      reason: afterMarker(t, escalate[0]),
      whoCanUnblock: qualifier === 'customer' || qualifier === 'platform' ? qualifier : undefined,
    };
  }
  return null;
}

function afterMarker(text: string, marker: string): string {
  return text.slice(text.indexOf(marker) + marker.length).trim();
}
