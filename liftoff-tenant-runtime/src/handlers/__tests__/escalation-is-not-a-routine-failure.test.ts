// Escalating to a human is not a routine fault.
//
// The Cloud Tasks receiver recorded a routine's outcome as
//
//   success: result.success === true && result.escalated !== true
//
// so a run that escalated counted as a FAILURE toward the consecutive-failure
// breaker. For a support agent that is backwards: escalating is a designed
// outcome with its own branch in the graph — the Customer Support workflow
// routes s9 (post to Slack) → s9b (acknowledge the customer) → s10 (mark read)
// for precisely this — and a routine that correctly hands three awkward emails
// to a human in a row would stop its own agent.
//
// Three escalating sweeps in a row trip the breaker. And because a paused
// agent is DEREGISTERED from its event trigger, inbound customer mail stops
// being answered as well — the breaker meant to protect the agent takes it off
// the air, and only a human pressing Resume brings it back.
//
// The fix is not `success: true`. The comment being replaced was right that an
// escalating routine must not RESET its streak, or a routine failing every
// other run would never trip. Withholding the record satisfies both: it neither
// adds nor clears — the same treatment `countsTowardRoutinePause` already gives
// a failure that says nothing about the routine's configuration.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'cloud-tasks-handler.ts'), 'utf8');
const STATE = readFileSync(join(__dirname, '..', '..', 'scheduling', 'routine-failure-state.ts'), 'utf8');

const block = SRC.slice(
  SRC.indexOf("const hitItsLimit = result.terminalState === 'limit_reached';"),
  SRC.indexOf("logger.info('Agent scheduled task completed'"),
);

describe('a clean escalation is not recorded', () => {
  it('has a block to assert against', () => {
    expect(block.length).toBeGreaterThan(400);
  });

  it('recognises the case', () => {
    expect(block).toContain('const escalatedCleanly = result.success === true && result.escalated === true;');
  });

  it('skips recording entirely, rather than recording a success', () => {
    // Recording a success would clear the streak, which is what the original
    // comment correctly warned against.
    expect(block).toContain('if (!hitItsLimit && !escalatedCleanly) {');
  });

  it('no longer folds `escalated` into the success flag', () => {
    // Comments stripped first: the prose above deliberately quotes the old
    // expression, and asserting over it would pass or fail on the explanation
    // rather than on the code.
    const code = block.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/success:\s*result\.success === true && result\.escalated !== true/);
    expect(code).toContain('success: result.success === true,');
  });

  it('says so in the log, so a quiet streak is still explicable', () => {
    expect(block).toMatch(/not counted for or against the routine/);
  });
});

describe('what must still count', () => {
  it('a failed run is recorded even if it also escalated', () => {
    // `escalatedCleanly` requires success === true. A genuine failure that
    // happened to escalate is still evidence about the routine.
    expect(block).toContain('result.success === true && result.escalated === true');
    expect(block).not.toContain('result.escalated === true;\n      if (!hitItsLimit) {');
  });

  it('a run that hit its ceiling is still excluded', () => {
    // Pre-existing and unchanged: a budget ceiling says the job is too big, not
    // that the routine is broken.
    expect(block).toContain('hitItsLimit');
  });

  it('the failure-class carve-out still exists upstream', () => {
    expect(STATE).toContain('countsTowardRoutinePause(params.failureClass)');
    expect(STATE).toMatch(/neither adds to the streak nor clears it/);
  });
});

describe('the reasoning is recorded where it was lost', () => {
  it('names the branch that makes escalation a designed outcome', () => {
    expect(block).toMatch(/designed outcome/);
    expect(block).toMatch(/s9/);
  });

  it('records the second-order damage, which is the part that surprised us', () => {
    // Pausing does not merely stop the cron: it deregisters the event trigger,
    // so the agent stops answering mail it would otherwise have handled.
    expect(block).toMatch(/deregistered/i);
  });
});
