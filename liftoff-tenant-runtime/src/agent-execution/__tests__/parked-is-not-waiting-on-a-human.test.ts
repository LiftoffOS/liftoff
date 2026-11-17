// A run that parks resumes itself. Nobody owes it anything.
//
// Every consumer of 'paused' reasonably reads it as "a person owes this run a
// decision" — that is what the three total maps say. A wall-clock
// continuation breaks that reading: read that way, a parked run reports the
// agent WAITING_FOR_HUMAN, its thread 'waiting_on_human', and the invocation
// 'gated'.
//
// Consecutive parked runs would each record 'gated', each with a fired
// `continuation:` row at the same second and no approval request anywhere.
// Reading the counts, the agent looks blocked on a person. It is
// mid-sentence.

import {
  resolveTerminalState,
  OUTCOME_BY_TERMINAL,
  THREAD_STATUS_BY_TERMINAL,
  RUN_STATE_BY_TERMINAL,
  AUDIT_OUTCOME_BY_TERMINAL,
} from '../terminal-state';

/** What the wall-clock park actually returns (service.ts, scheduleRunContinuation). */
const parkResult = { success: true, paused: true, pauseKind: 'continuation' as const };
/** What a HITL gate or ask_user returns: a pause a PERSON must clear. */
const humanPause = { success: true, paused: true, pauseKind: 'hitl_approval' as const };

describe('telling a self-resuming pause from one that needs a person', () => {
  it('reads a wall-clock park as parked', () => {
    expect(resolveTerminalState(parkResult, false)).toBe('parked');
  });

  it('still reads a human pause as paused', () => {
    expect(resolveTerminalState(humanPause, false)).toBe('paused');
    // A pause with no kind at all predates pauseKind and must not become parked:
    // guessing 'parked' there would report a run awaiting a person as working.
    expect(resolveTerminalState({ success: true, paused: true }, false)).toBe('paused');
  });

  it('keeps the pause ahead of governance, which was already the rule', () => {
    // A run that gated AND parked is still parked for reporting purposes — but
    // the pause check runs first either way, so this pins the existing order.
    expect(resolveTerminalState(parkResult, true)).toBe('parked');
  });
});

describe('what a parked run reports to each surface', () => {
  it('does not tell the thread a person is needed', () => {
    expect(THREAD_STATUS_BY_TERMINAL.paused).toBe('waiting_on_human');
    // The user-visible half: the thread stays open and being worked.
    expect(THREAD_STATUS_BY_TERMINAL.parked).toBe('open');
  });

  it('records its own invocation outcome rather than borrowing gated', () => {
    expect(OUTCOME_BY_TERMINAL.paused).toBe('gated');
    expect(OUTCOME_BY_TERMINAL.parked).toBe('parked');
  });

  it('is not over, so it is not complete and not failed', () => {
    // agent-status derives isTerminal from complete||failed.
    expect(RUN_STATE_BY_TERMINAL.parked).toBe('interrupted');
  });

  it('borrows gated ONLY in the audit, where the CHECK is narrowest', () => {
    // audit_logs.outcome lives in platform-backend and admits three values.
    // The Activity page separates them by the error_code marker, the way it
    // already separates an escalation from a gate.
    expect(AUDIT_OUTCOME_BY_TERMINAL.parked).toBe('gated');
  });
});
