// Agent execution constants — shared between custom loop and SDK engine (GAP 19 FIX)

// Phase 3 (D-3.3): Default per-step timeout for workflow agents.
// Used by Phase 4's runWorkflowLoop when step.timeoutMs is not set and
// execConfig.timeoutMs is also absent.
export const DEFAULT_STEP_TIMEOUT_MS = 60_000; // 60 seconds

/** Per-tool step timeouts where the tool's own work is known to outlast the
 *  default. A browser task is a job of several page actions, each a model
 *  call and an action, bounded inside the tool at three minutes; a step that
 *  gives it one minute marks the step failed while the task goes on to
 *  finish, and the run reads a timeout where there was a result. */
export const STEP_TIMEOUT_MS_BY_TOOL: Readonly<Record<string, number>> = {
  run_browser_task: 210_000,
};

/** The timeout a tool_call step runs under when it declares none. */
export function defaultStepTimeoutMs(toolName: string | undefined): number {
  return (toolName && STEP_TIMEOUT_MS_BY_TOOL[toolName]) || DEFAULT_STEP_TIMEOUT_MS;
}

// Phase 4: Default max tool calls per workflow run (DoS ceiling).
export const DEFAULT_MAX_TOOL_CALLS = 1_000;

/** Wall clock for ONE invocation of a run.
 *
 *  Sized to the infrastructure ceiling rather than chosen: agent-service runs
 *  with Cloud Run `timeoutSeconds: 900`, and `enqueueAgentExecution` sets a
 *  Cloud Tasks `dispatchDeadline` of 870s deliberately below it so a real
 *  timeout is reported by the service that ran the work rather than by the
 *  queue that stopped listening. This sits under THAT, leaving room for the
 *  park itself — writing the continuation row and enqueuing the next
 *  invocation, which must complete after the ceiling is reached.
 *
 *  It was 10 minutes, which tracked nothing: 270 seconds below the dispatch
 *  deadline and 300 below Cloud Run's, so every invocation stopped four and a
 *  half minutes early and a long run paid for the difference in PARKS. A park
 *  is the risky moment in a run — state has to cross an invocation boundary —
 *  so unused ceiling is not free caution, it is extra parks.
 *
 *  This is not the limit on how long a run may take. A run that reaches the
 *  ceiling at a resumable point continues in a fresh invocation; total runtime
 *  is bounded by MAX_RUN_CONTINUATIONS and MAX_CONTINUATION_TOOL_CALLS, which
 *  are about stopping a RUNAWAY rather than about duration.
 *
 *  `wall-clock-fits-the-infrastructure.test.ts` holds the three numbers to each
 *  other, because they are one decision expressed in three places and the two
 *  that already existed had drifted. */
/** Cloud Run's own request timeout for agent-service, as deployed. The outer
 *  bound every ceiling below has to sit inside. */
export const AGENT_SERVICE_REQUEST_TIMEOUT_SECONDS = 900;

/** Room the park needs after the ceiling is reached: a row write and a task
 *  enqueue, both of which happen when the clock has already run out. */
export const PARK_RESERVE_MS = 30_000;

/** The Cloud Tasks dispatch deadline the wall clock has to fit under, mirrored
 *  from `infrastructure/cloud-tasks.ts` so this module can derive against it
 *  without importing the task layer.
 *
 *  Clamped under Cloud Run's timeout rather than trusted: an override that
 *  exceeded the request timeout would make the queue outlive the request it is
 *  waiting on, which is the wrong side of the trade that comment names. */
export const AGENT_TASK_DISPATCH_DEADLINE_SECONDS = Math.min(
  Number(process.env.AGENT_TASK_DISPATCH_DEADLINE_SECONDS ?? 870),
  AGENT_SERVICE_REQUEST_TIMEOUT_SECONDS - PARK_RESERVE_MS / 1_000,
);

/** The `reason` a chat turn's hard-deadline abort carries.
 *
 *  One constant for the writer and the reader: the row means "this TURN ended",
 *  not "someone asked for an end", and a step loop that cannot tell them apart
 *  stops a run its own deadline handed off. Matched on this exact string, so a
 *  reworded reason fails the test rather than silently stopping runs again. */
export const CHAT_TURN_DEADLINE_ABORT_REASON = 'chat_turn_hard_timeout';

/** The chat turn's own hard deadline, mirrored from `chat-turn-handler`.
 *
 *  A turn that hits it writes an `abort` signal row for the invocation, and
 *  that row is what cancels the engine. So the run's ceiling has to sit BELOW
 *  it: a run that parks after the turn has already aborted hands its
 *  continuation an abort to read at the first step boundary.
 *
 *  Learned the hard way. Setting the run ceiling to 840_000 — the same value as
 *  this — made the two fire together: the turn's abort landed at 06:45:26, the
 *  run parked at 06:47:00, and the continuation consumed the abort and stopped
 *  with zero tool calls after 525ms. Eleven minutes of work, parked correctly,
 *  and then stopped by its own turn's deadline. */
export const CHAT_TURN_HARD_TIMEOUT_MS = Number(
  process.env.CHAT_TURN_HARD_TIMEOUT_MS ?? 14 * 60 * 1_000,
);

/** How long a STEP may still be running when the ceiling is reached.
 *
 *  The ceiling is checked between steps, so reaching it does not park the run —
 *  the step in flight has to finish first. A reserve that covers only the park
 *  therefore guarantees nothing.
 *
 *  Measured: the ceiling was exceeded at 810s and the park landed at 856s, a
 *  46-second overshoot, while the turn's deadline fired at 840s in between. The
 *  response was finished before the park could be delivered, so the control
 *  plane saw a stream with no terminal frame and told the person "This run
 *  stopped on an error" — for a run that parked cleanly and went on to write
 *  its report. The work was fine; only the account of it was wrong.
 *
 *  240s covers a step at the longest per-tool timeout the loop sets
 *  (`STEP_TIMEOUT_MS_BY_TOOL`, 210s for a browser task) with margin. A loop
 *  step checks the ceiling per ITERATION and parks with its position, so it
 *  does not need this; an ordinary long step does. */
export const STEP_OVERSHOOT_RESERVE_MS = 240_000;

/** DERIVED, not chosen: the tightest bound above, less the room the park needs
 *  AND the time a step in flight may still take.
 *
 *  This went UP to use room that looked unused, and that was only half right.
 *  Unused ceiling does buy extra parks — but a park that lands after the turn's
 *  deadline is not delivered at all, and an undelivered park reads to the person
 *  as a failed run. A lower ceiling whose park arrives beats a higher one whose
 *  park has nowhere to go, and now that a continuation actually continues, more
 *  parks are cheap. */
export const DEFAULT_MAX_WALL_CLOCK_MS = Number(
  process.env.DEFAULT_MAX_WALL_CLOCK_MS
    ?? Math.min(
      AGENT_TASK_DISPATCH_DEADLINE_SECONDS * 1_000,
      CHAT_TURN_HARD_TIMEOUT_MS,
    ) - PARK_RESERVE_MS - STEP_OVERSHOOT_RESERVE_MS,
);

/** Wall clock for a BLOCKING delegated child (`collect: true`), when the caller
 *  names no timeout of its own.
 *
 *  Matches the detached child path, which finalizes inside the 270s Cloud Task
 *  delivery deadline. A blocking child does the same work as a detached one and
 *  needs the same room: the previous 30s did not cover catalog assembly, memory
 *  retrieval and a first model turn, so a blocking delegation could not finish
 *  even in principle, and the parent read the timeout as the child's answer. */
export const BLOCKING_CHILD_WALL_CLOCK_MS = 240_000; // 4 minutes

// Phase 4: Default max LLM tokens per workflow run.
// Some tools trigger internal LLM calls; this ceiling prevents runaway token spend.
export const DEFAULT_MAX_LLM_TOKENS = 100_000;

/** What stops a chain of continuations.
 *
 *  NOT duration. A run that needs two hours and is doing the work it was asked
 *  to do is behaving correctly, and stopping it at an hour threw away
 *  everything it had gathered and told the person their report could not be
 *  produced. The spend is the cap: a workspace with Operating Units to drain
 *  gets the work it asked for, and a workspace without them is stopped by the
 *  one money authority rather than by a number in this file.
 *
 *  That signal is READ, never computed here (INV-PB-010): `assessContinuation`
 *  asks `admissionService`, which resolves operational status, billing
 *  suspension, agent lifecycle and the kill switches off the entitlement
 *  snapshot. The runtime must not form its own opinion about a balance.
 *
 *  What remains is a STUCK detector, which is a different question from
 *  duration: a chain that continues without advancing — same cursor, no new
 *  step output, no loop item consumed — is a defect burning a balance, and the
 *  person is better served by stopping it than by draining the account. Three
 *  consecutive non-advancing continuations is the bound; one or two can happen
 *  legitimately when a single step is slower than a whole invocation.
 *
 *  Both numbers below remain as OPERATOR backstops and are no longer the
 *  product's answer to "how long may a run take". Unset, they do not bound a
 *  progressing run at all. */
export const MAX_NON_ADVANCING_CONTINUATIONS = Number(
  process.env.MAX_NON_ADVANCING_CONTINUATIONS ?? 3,
);

/** An operator ceiling on chain length. Unset there is none: a progressing run
 *  continues while the workspace can pay for it. Set it to impose a hard stop
 *  in an environment that wants one. */
export const MAX_RUN_CONTINUATIONS = Number(
  process.env.MAX_RUN_CONTINUATIONS ?? Number.POSITIVE_INFINITY,
);

/** An operator ceiling on total tool calls across a chain. Unset there is
 *  none, for the same reason. */
export const MAX_CONTINUATION_TOOL_CALLS = Number(
  process.env.MAX_CONTINUATION_TOOL_CALLS ?? Number.POSITIVE_INFINITY,
);
