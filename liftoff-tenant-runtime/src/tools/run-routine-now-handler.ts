// run_routine_now — the explicit bridge from conversation into the step graph.
//
// The properties that carry it: outside interactive chat (no cell) it refuses
// truthfully rather than pretending anything started; a graph the engine would
// refuse is refused HERE, before anything is armed; a run is armed only when the
// person actually asked for one; a second call in the same turn refuses rather
// than double-starting; and the only thing a successful call DOES is flip the
// shared cell — the engine's dispatch, not this handler, runs the graph, in the
// same invocation the person is watching.
//
// `started: true` used to be returned for a graph the engine refused one second
// later, and the result told the model to announce the start. The chat system
// prompt's rule — never claim a run happened without this tool returning
// `started` — was doing its job; what it was given was false. So the fix is to
// make `started` truthful, by asking the engine's OWN preflight (hash check,
// trigger-bound rewrite, alias remap, validation, fatal/degradable split)
// before arming anything. The result is memoized on the cell, so the engine
// consumes this same answer when it reaches the graph rather than running the
// rewriting passes a second time.

import type { StandardToolContext, StandardToolResult } from './standard-tool-handler';
import { readRunNowIntentAsync } from './run-now-intent';

export async function handleRunRoutineNow(ctx: StandardToolContext): Promise<StandardToolResult> {
  if (!ctx.workflowRunRef) {
    return {
      success: false,
      error:
        'run_routine_now is only available in an interactive conversation on a team '
        + 'member with a configured workflow. Nothing was started.',
    };
  }
  // Checked BEFORE `requested` is read or set. A refusal must leave the cell
  // exactly as it found it: nothing armed, and no second call blocked by a
  // first that never started anything.
  //
  // Absent on a caller that is not the interactive chat path, which keeps the
  // existing behaviour for every such caller.
  const preflight = await ctx.workflowRunRef.preflight?.();
  if (preflight?.ok === false) {
    return {
      success: false,
      error:
        'This routine cannot run as it is currently configured, so nothing was started. '
        + 'Tell the person the routine could not be started and that it needs to be '
        + 'looked at before it can run; do not say it is starting.',
    };
  }
  // DID THE PERSON ASK FOR A RUN?
  //
  // Checked before `requested`, for the same reason the preflight is: a refusal
  // must arm nothing. Otherwise "so where is my report" can arm a second sweep
  // and answer with the fresh-start note below, while the same turn holds the
  // link to the document the person was asking about. See run-now-intent.ts.
  //
  // A cell with no message at all is a caller that predates this field, and it
  // keeps the previous behaviour rather than losing the tool.
  if (ctx.workflowRunRef.personMessage !== undefined) {
    // The model first, the patterns behind it. See run-now-intent.ts: a list
    // of verbs for running a process could not read "i want my report now",
    // and refused it twice.
    const intent = await readRunNowIntentAsync(ctx.workflowRunRef.personMessage, {
      tenantId: ctx.tenantId,
      ...(ctx.invocationId ? { invocationId: ctx.invocationId } : {}),
      ...(ctx.agentId ? { runtimeAgentId: ctx.agentId } : {}),
    });
    if (intent === 'asks_about_work') {
      return {
        success: false,
        error:
          'Nothing was started: this message asks about work, not for a new run. '
          + 'Answer it from the record of what you have already done for this person and '
          + 'from what your searches returned in this turn, naming each document or '
          + 'message and where it is. Do not start a run, and do not say one is starting. '
          + 'If they turn out to want the work done again, they will say so and you can '
          + 'call this then.',
      };
    }
    if (intent === 'unclear') {
      return {
        success: false,
        error:
          'Nothing was started: this message does not ask for the routine to run now. '
          + 'Answer what was actually asked. If you believe the work needs doing again, '
          + 'ask the person to confirm and call this only once they have.',
      };
    }
  }
  if (ctx.workflowRunRef.requested) {
    return {
      success: false,
      error:
        'The routine run is already starting for this turn. Do not call run_routine_now '
        + 'again; tell the person the run is underway.',
    };
  }
  ctx.workflowRunRef.requested = true;
  return {
    success: true,
    result: {
      started: true,
      note:
        'The routine run begins when you finish this reply, and has done nothing yet. '
        + 'Tell the person the work is about to begin and that progress will post in '
        + 'this conversation, then end your turn. Do not describe any work as done.',
    },
  };
}
