// The wiring a continuation depends on, asserted at the source.
//
// These properties span the step loop, the Cloud Tasks receiver, the chat
// handler and the delivery seam. Exercising them for real means booting the
// execution service against a database and a queue; leaving them unasserted
// means the feature can be half-wired, which is the defect shape this codebase
// produces most often -- a thing built at one end that never runs.

import { readFileSync } from 'fs';
import { join } from 'path';

const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const service = read('service.ts');
// The MAIN step loop's ceiling, not the per-iteration one inside a loop step.
// Only the main loop stops between steps, which is what makes continuing safe:
// a loop step is cut mid-iteration and its items would be redone.
const wallClockSite = service.slice(
  service.indexOf('    while (currentStepId) {'),
).slice(0, 3200);
const chatHandler = readFileSync(
  join(__dirname, '..', '..', 'interactive-chat', 'chat-turn-handler.ts'), 'utf8',
);
const taskHandler = readFileSync(
  join(__dirname, '..', '..', 'handlers', 'cloud-tasks-handler.ts'), 'utf8',
);

describe('the wall clock tries to continue before it fails', () => {
  it('reaches for a continuation at the ceiling, and keeps the old failure behind it', () => {
    const site = wallClockSite;
    expect(site).toContain('continueAfterWallClock');
    // The fallback is not removed: a run that cannot be continued fails exactly
    // as it always has.
    expect(site).toContain('exceeded maximum wall-clock time');
    expect(site.indexOf('continueAfterWallClock'))
      .toBeLessThan(site.indexOf('exceeded maximum wall-clock time'));
  });

  it('continues from the step that had not started', () => {
    expect(wallClockSite).toMatch(/resumeAtStepId: currentStepId/);
  });

  it('never reports a continuation it did not schedule', () => {
    // The one lie that would be worse than the failure it replaces: telling
    // someone their work is still running when nothing is running.
    const fn = service.slice(service.indexOf('private async continueAfterWallClock('));
    const body = fn.slice(0, fn.indexOf('\n  }\n'));
    expect(body).toMatch(/if \(!scheduledInvocationId\) return null;/);
    // And the paused result is built after that guard, not before it.
    expect(body.indexOf('if (!scheduledInvocationId) return null;'))
      .toBeLessThan(body.indexOf("pauseKind: 'continuation'"));
  });

  it('carries the chain lineage forward the way the wake chain does', () => {
    const fn = service.slice(service.indexOf('private async continueAfterWallClock('));
    const body = fn.slice(0, fn.indexOf('\n  }\n'));
    expect(body).toContain('_continuationDepth');
    expect(body).toContain('_continuationToolCalls');
  });
});

describe('the resumed half is the same run, not a fresh one', () => {
  it('carries objective, input and recovery counters', () => {
    // A delay resume legitimately starts clean. A continuation is the same run
    // mid-flight: dropping these would give the second half a different task
    // from the first and hand a run that had exhausted its recovery budget a
    // fresh one.
    const fn = service.slice(service.indexOf('async resumeWorkflow(input: {'));
    const body = fn.slice(0, fn.indexOf('\n  // Per implementation plan'));
    expect(body).toMatch(/inputData: cont\?\.inputData/);
    expect(body).toMatch(/objective: cont\?\.objective/);
    expect(body).toMatch(/perStepRecoveries: cont\?\.perStepRecoveries \?\? \{\}/);
    expect(body).toMatch(/totalRecoveries: cont\?\.totalRecoveries \?\? 0/);
  });

  it('delivers the outcome to the thread that asked', () => {
    const fn = service.slice(service.indexOf('async resumeWorkflow(input: {'));
    const body = fn.slice(0, fn.indexOf('\n  // Per implementation plan'));
    expect(body).toContain('deliverContinuationOutcome');
  });

  it('says nothing while the chain is still going, and something when it stops', () => {
    // Only the last link speaks. But a chain that STOPPED must say so: silence
    // there is indistinguishable from still working, which is the failure the
    // whole path exists to end. (The precedence this reads is asserted below.)
    const fn = service.slice(service.indexOf('private async deliverContinuationOutcome('));
    const body = fn.slice(0, fn.indexOf('\n  }\n'));
    // 'parked' as well as 'paused'. A continuation that runs out of wall clock
    // and parks AGAIN is mid-chain, so splitting the two states would otherwise
    // have made every re-park post an outcome for a run still working.
    expect(body).toMatch(/terminal === 'paused' \|\| terminal === 'parked'\) return;/);
    expect(body).toContain('deliverWakeToChat');
    expect(body).toContain('settleWakeViaCallback');
  });
});

describe('a redelivered continuation does not run the work twice', () => {
  it('claims the row atomically before resuming', () => {
    // Cloud Tasks is at-least-once and a continuation runs REAL STEPS, so a
    // duplicate would re-send whatever the next step sends.
    const branch = taskHandler.slice(
      taskHandler.indexOf("if (kind === 'run-continuation') {"),
    ).slice(0, 3000);
    expect(branch).toContain('markFiredByInvocationId');
    expect(branch).toMatch(/if \(claimed === 0\)/);
    expect(branch.indexOf('markFiredByInvocationId'))
      .toBeLessThan(branch.indexOf('resumeWorkflow'));
  });

  it('does not retry a task whose state is gone', () => {
    const branch = taskHandler.slice(
      taskHandler.indexOf("if (kind === 'run-continuation') {"),
    ).slice(0, 3000);
    expect(branch).toContain('no_continuation_payload');
    expect(branch).toMatch(/status\(200\)[\s\S]{0,120}no_continuation_payload/);
  });
});

describe('what the thread is told when a run outgrows its turn', () => {
  it('is narration, not the team speaking', () => {
    const branch = chatHandler.slice(chatHandler.indexOf('const isContinuation ='));
    expect(branch.slice(0, 4000)).toMatch(/messageType: 'run_progress'/);
  });

  it('does not present a half-finished thought as the answer', () => {
    // The prose a run had produced when the clock ran out is mid-workflow, and
    // the real answer arrives later from the continuation.
    const branch = chatHandler.slice(chatHandler.indexOf('const isContinuation ='));
    expect(branch.slice(0, 2000)).toMatch(/!isContinuation && outputText/);
  });

  it('emits a parked frame the control plane actually handles', () => {
    expect(chatHandler).toContain("writeSSE(res, 'run_parked'");
    // The frame it replaces was emitted here and consumed by nothing, so a
    // self-parked run ended its stream with no terminal frame at all.
    expect(chatHandler).not.toContain("'awaiting_wake'");
  });

  it('uses the SAME frame for a self-parked run, so one consumer covers both', () => {
    const frames = chatHandler.split("writeSSE(res, 'run_parked'").length - 1;
    expect(frames).toBe(2);
  });
});

describe('the outcome a continuation delivers is the RESOLVED one', () => {
  // Read off the raw booleans, an escalation is a success: ten of the thirteen
  // escalation sites return `success: true` AND `escalated: true`. Read that
  // way at this seam, a continuation that escalated is taken as a success, has
  // no output to send, and tells the thread nothing at all.
  const fn = service.slice(service.indexOf('private async deliverContinuationOutcome('));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));

  it('goes through the shared resolver', () => {
    expect(body).toContain('resolveTerminalState(');
    // And the raw-boolean read it replaces is gone.
    expect(body).not.toMatch(/if \(result\.success\)/);
  });

  it('stays quiet only while the chain is still going', () => {
    // 'parked' as well as 'paused'. A continuation that runs out of wall clock
    // and parks AGAIN is mid-chain, so splitting the two states would otherwise
    // have made every re-park post an outcome for a run still working.
    expect(body).toMatch(/terminal === 'paused' \|\| terminal === 'parked'\) return;/);
  });

  it('says something for every other ending, including an empty success', () => {
    // A wake that finds nothing worth reporting is right to stay quiet: nobody
    // is waiting on it. A continuation is the second half of a request somebody
    // made minutes ago.
    expect(body).toContain('continuationOutcomeNote(');
    const note = service.slice(service.indexOf('function continuationOutcomeNote('));
    const noteBody = note.slice(0, note.indexOf('\n}\n'));
    for (const ending of ['escalated', 'gated', 'limit_reached', 'stopped', 'success']) {
      expect(noteBody).toContain(`case '${ending}':`);
    }
    expect(noteBody).toContain('default:');
  });

  it('tells a reader an escalation is a handoff, not a result', () => {
    const note = service.slice(service.indexOf('function continuationOutcomeNote('));
    const noteBody = note.slice(0, note.indexOf('\n}\n'));
    expect(noteBody).toMatch(/handed to a person/);
    // And carries the reason, so "why" does not require reading a log.
    expect(noteBody).toMatch(/result\.error/);
  });
});

describe('a workflow run reports its position', () => {
  it('emits a step event from the loop head, where the cursor is known', () => {
    const loop = service.slice(
      service.indexOf("enteredSteps.add(currentStepId);"),
    ).slice(0, 1200);
    expect(loop).toContain("type: 'workflow_step_started'");
    expect(loop).toContain('state.context.streamSink');
  });

  it('skips it for a run with no listener', () => {
    // Autonomous runs have no sink; the guard is what keeps this free for them.
    const loop = service.slice(
      service.indexOf("enteredSteps.add(currentStepId);"),
    ).slice(0, 1200);
    expect(loop).toMatch(/if \(state\.context\.streamSink\)/);
  });
});

describe('a continuation carries the registry, not just the counters', () => {
  it('snapshots the whole loop state into the payload', () => {
    // Carrying only the counters is what sent a continued run into its digest
    // steps with the competitor data it had already gathered nowhere in scope.
    const fn = service.slice(service.indexOf('private async continueAfterWallClock('));
    const body = fn.slice(0, fn.indexOf('\n  }\n'));
    expect(body).toContain('...carriedLoopState(args)');
    expect(body).not.toMatch(/perStepRecoveries: args\.perStepRecoveries/);
  });

  it('passes it on through the resume', () => {
    // Asserted as the WHOLE slice rather than field by field. The field-by-field
    // version of this test passed while `stepReplay` was being dropped: it named
    // two of the carried fields and the handler named five of ten, so both lists
    // agreed with each other and neither agreed with the writer.
    const branch = taskHandler.slice(
      taskHandler.indexOf("if (kind === 'run-continuation') {"),
    ).slice(0, 3500);
    expect(branch).toContain('...readCarriedResumeState(');
  });

  it('separates carrying state from speaking to a person', () => {
    // Fused, every delayed follow-up would start posting into a chat thread the
    // moment the registry began being carried.
    const branch = taskHandler.slice(
      taskHandler.indexOf("if (kind === 'run-continuation') {"),
    ).slice(0, 3500);
    expect(branch).toContain('carryOver:');
    expect(branch).toContain('deliverTo:');
  });
});

describe('the resumed half completes the invocation it continues', () => {
  // A run that resumed through resumeWorkflow — a delay, or a wall-clock
  // continuation — wrote none of its own evidence: the invocation row kept
  // the pause it left behind after the work had finished, and the resumed
  // half's spend reached no cost event.
  const resume = service.slice(service.indexOf('  async resumeWorkflow(input: {'));
  const body = resume.slice(0, resume.indexOf('\n  }\n'));

  it('finalizes under the pause row it fired from', () => {
    expect(body).toContain('if (input.resumedFrom) {');
    expect(body).toContain('await this.finalizeResumedInvocation({');
    expect(body).toContain('resumeKind: input.resumedFrom.kind,');
    expect(body).toContain('resumeRowId: input.resumedFrom.scheduledInvocationId,');
  });

  it('completes the row before anyone is told about it', () => {
    expect(body.indexOf('await this.finalizeResumedInvocation('))
      .toBeLessThan(body.indexOf('await this.deliverContinuationOutcome('));
  });

  it('is handed the row by both resume paths', () => {
    const continuation = taskHandler.slice(
      taskHandler.indexOf("if (kind === 'run-continuation') {"),
    ).slice(0, 3600);
    expect(continuation).toContain("resumedFrom: { kind: 'continuation', scheduledInvocationId: row.id }");
    const delay = taskHandler.slice(taskHandler.indexOf("// Default ('delay'): existing workflow-delay resume contract."));
    expect(delay).toContain("resumedFrom: { kind: 'delay' as const, scheduledInvocationId: workflowResume.scheduledInvocationId }");
  });
});

describe('a delivery says what the RUN did, never what the world contains', () => {
  // The first real continuation delivery told a person "there is no finished
  // result to show yet". The run had written NINE documents, one of them the
  // competitive digest they had asked for. The sentence was composed from the
  // terminal state alone and asserted something about their Google Drive that
  // nothing in this process can see.
  //
  // A run that ends with no text to relay knows exactly that much. Claiming
  // absence is a different statement, and it is the one that was wrong.
  const note = service.slice(service.indexOf('function continuationOutcomeNote('));
  const body = note.slice(0, note.indexOf('\n}\n'));

  it('never claims there is nothing to show', () => {
    expect(body).not.toMatch(/no finished result/i);
    expect(body).not.toMatch(/produced nothing/i);
    expect(body).not.toMatch(/did not get that far/i);
  });

  it('still distinguishes every ending', () => {
    for (const ending of ['escalated', 'gated', 'limit_reached', 'stopped', 'success']) {
      expect(body).toContain(`case '${ending}':`);
    }
  });

  it('still carries the reason, so "why" needs no log', () => {
    expect(body).toMatch(/result\.error/);
  });
});
