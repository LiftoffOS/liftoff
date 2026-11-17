// Terminal-state resolution (migration 332).
//
// The bug these pin down: `success` and `escalated` were independent booleans
// that six of the seven escalation paths set BOTH of, and each consumer picked
// its own precedence. The symptom: an invocation recording outcome='success'
// with error_message 'permanent tool error x2 ... not retryable' while creating
// an escalation.

import {
  resolveTerminalState,
  resolveFailureClass,
  isFailureState,
  isTerminalForTrigger,
  learningSignal,
  parseTerminalMarker,
  readTaskOutcomeReport,
  OUTCOME_BY_TERMINAL,
  THREAD_STATUS_BY_TERMINAL,
  AUDIT_OUTCOME_BY_TERMINAL,
} from '../terminal-state';
import type { TerminalState } from '../types';

const ALL_STATES: TerminalState[] = ['success', 'task_failed', 'escalated', 'gated', 'engine_error'];

const base = { toolCallsExecuted: 0, reasoningSteps: 0 };

describe('resolveTerminalState', () => {
  it('prefers an explicit terminalState over the legacy booleans', () => {
    expect(resolveTerminalState(
      { terminalState: 'task_failed', success: true, escalated: true }, true,
    )).toBe('task_failed');
  });

  it('resolves escalated BEFORE success — the legacy sites set both', () => {
    // This is the regression. Every one of the six escalation producers returns
    // success:true alongside escalated:true; reading success first is what
    // recorded them as clean runs.
    expect(resolveTerminalState({ success: true, escalated: true }, false)).toBe('escalated');
  });

  it('treats a governance stop as gated even when the run looks successful', () => {
    expect(resolveTerminalState({ success: true, escalated: false }, true)).toBe('gated');
  });

  it('maps a plain success and a plain failure', () => {
    expect(resolveTerminalState({ success: true }, false)).toBe('success');
    expect(resolveTerminalState({ success: false }, false)).toBe('engine_error');
  });
});

describe('outcome / thread / audit maps', () => {
  it('are total over TerminalState', () => {
    for (const state of ALL_STATES) {
      expect(OUTCOME_BY_TERMINAL[state]).toBeDefined();
      expect(THREAD_STATUS_BY_TERMINAL[state]).toBeDefined();
      expect(AUDIT_OUTCOME_BY_TERMINAL[state]).toBeDefined();
    }
  });

  it('never records an escalated run as a success or a completed thread', () => {
    expect(OUTCOME_BY_TERMINAL.escalated).toBe('escalated');
    expect(THREAD_STATUS_BY_TERMINAL.escalated).toBe('waiting_on_human');
  });

  it('keeps a gated run out of both the success and the plain-error buckets', () => {
    expect(OUTCOME_BY_TERMINAL.gated).toBe('gated');
    expect(THREAD_STATUS_BY_TERMINAL.gated).toBe('waiting_on_human');
  });

  it('collapses both failure states onto outcome=error', () => {
    expect(OUTCOME_BY_TERMINAL.task_failed).toBe('error');
    expect(OUTCOME_BY_TERMINAL.engine_error).toBe('error');
  });

  it('maps escalated to gated for audit_logs, whose CHECK has no escalated', () => {
    // migration 016: audit_logs.outcome IN ('success','error','gated').
    expect(AUDIT_OUTCOME_BY_TERMINAL.escalated).toBe('gated');
  });
});

describe('resolveFailureClass', () => {
  it('never leaves a failing run without a class', () => {
    expect(resolveFailureClass('engine_error')).toBe('unknown');
    expect(resolveFailureClass('task_failed')).toBe('unknown');
  });

  it('keeps an explicit class', () => {
    expect(resolveFailureClass('task_failed', 'task_failed')).toBe('task_failed');
    expect(resolveFailureClass('engine_error', 'validation')).toBe('validation');
  });

  it('returns undefined for non-failure states so success rows stay NULL', () => {
    expect(resolveFailureClass('success', 'validation')).toBeUndefined();
    expect(resolveFailureClass('escalated')).toBeUndefined();
    expect(resolveFailureClass('gated')).toBeUndefined();
  });

  it('agrees with isFailureState', () => {
    for (const state of ALL_STATES) {
      expect(resolveFailureClass(state) !== undefined).toBe(isFailureState(state));
    }
  });
});

describe('isTerminalForTrigger', () => {
  it('re-opens the trigger row only for an engine failure', () => {
    expect(isTerminalForTrigger('engine_error')).toBe(false);
    for (const state of ALL_STATES.filter(s => s !== 'engine_error')) {
      expect(isTerminalForTrigger(state)).toBe(true);
    }
  });
});

describe('learningSignal', () => {
  it('gives escalated and gated NO signal', () => {
    // A human being asked to act says nothing about whether the injected
    // memories were useful; scoring it negative penalises them for the
    // platform's own governance decision.
    expect(learningSignal('escalated')).toBe('none');
    expect(learningSignal('gated')).toBe('none');
  });

  it('rewards success and penalises real failures', () => {
    expect(learningSignal('success')).toBe('positive');
    expect(learningSignal('task_failed')).toBe('negative');
    expect(learningSignal('engine_error')).toBe('negative');
  });
});

describe('parseTerminalMarker (compatibility shim)', () => {
  it('reads [FAIL] and [ESCALATE] with their reasons', () => {
    expect(parseTerminalMarker('[FAIL] connector disconnected'))
      .toEqual({ state: 'task_failed', reason: 'connector disconnected' });
    expect(parseTerminalMarker('[ESCALATE] needs a human'))
      .toEqual({ state: 'escalated', reason: 'needs a human' });
  });

  it('returns null when no marker is present, so callers keep prior behaviour', () => {
    expect(parseTerminalMarker('all done')).toBeNull();
    expect(parseTerminalMarker(undefined)).toBeNull();
    expect(parseTerminalMarker('[COMPLETE] done')).toBeNull();
  });

  // The marker predates the audience question report_task_outcome now asks, so
  // it grew the same answer: [ESCALATE:customer] is a blocker someone in the
  // workspace can clear. A bare [ESCALATE] cannot say, and unattributed is ours.
  it('reads the audience from a qualified marker', () => {
    expect(parseTerminalMarker('[ESCALATE:customer] Share the sheet with the service account'))
      .toEqual({
        state: 'escalated',
        reason: 'Share the sheet with the service account',
        whoCanUnblock: 'customer',
      });
    expect(parseTerminalMarker('[ESCALATE:platform] connector id mismatch'))
      .toEqual({ state: 'escalated', reason: 'connector id mismatch', whoCanUnblock: 'platform' });
  });

  it('leaves a bare marker unattributed, which routes it to us', () => {
    expect(parseTerminalMarker('[ESCALATE] needs a human')?.whoCanUnblock).toBeUndefined();
  });

  it('does not mistake an unknown qualifier for an audience', () => {
    const marker = parseTerminalMarker('[ESCALATE:everyone] who knows');
    // Falls through to the bare form: the text is kept, the audience is not
    // invented.
    expect(marker?.state).toBe('escalated');
    expect(marker?.whoCanUnblock).toBeUndefined();
  });
});

describe('readTaskOutcomeReport', () => {
  it('accepts the bare name used by bridge engines', () => {
    expect(readTaskOutcomeReport('report_task_outcome', { status: 'fail', summary: 'no sheet' }))
      .toEqual({ status: 'fail', summary: 'no sheet' });
  });

  it('accepts the SDK-prefixed name used by Anthropic', () => {
    expect(readTaskOutcomeReport(
      'mcp__liftoff-tool-gateway__report_task_outcome',
      { status: 'complete', summary: 'row appended' },
    )).toEqual({ status: 'complete', summary: 'row appended' });
  });

  it('ignores other tools and malformed reports rather than defaulting a verdict', () => {
    expect(readTaskOutcomeReport('task_ledger_write', { status: 'fail' })).toBeNull();
    expect(readTaskOutcomeReport('report_task_outcome', { status: 'bogus' })).toBeNull();
    expect(readTaskOutcomeReport('report_task_outcome', null)).toBeNull();
  });

  it('tolerates a missing summary', () => {
    expect(readTaskOutcomeReport('report_task_outcome', { status: 'escalate' }))
      .toEqual({ status: 'escalate', summary: '', whoCanUnblock: undefined, requestedAction: undefined });
  });

  // "escalate = a human must act" was one audience covering two: a customer
  // cannot fix a connector-id mismatch or an unreachable provider. The report
  // now says who can, and what they should do.
  it('carries who can unblock it and what they should do', () => {
    expect(readTaskOutcomeReport('report_task_outcome', {
      status: 'escalate',
      summary: 'Cannot write to the sheet',
      whoCanUnblock: 'customer',
      requestedAction: 'Share the sheet with the service account',
    })).toEqual({
      status: 'escalate',
      summary: 'Cannot write to the sheet',
      whoCanUnblock: 'customer',
      requestedAction: 'Share the sheet with the service account',
    });
  });

  it('reads an unrecognised audience as unsaid, which routes it to us', () => {
    // A typo must not put a platform fault in front of a customer.
    const report = readTaskOutcomeReport('report_task_outcome', {
      status: 'escalate', summary: 'x', whoCanUnblock: 'the_customer',
    });
    expect(report?.whoCanUnblock).toBeUndefined();
  });

  it('reads a blank requested action as unsaid', () => {
    const report = readTaskOutcomeReport('report_task_outcome', {
      status: 'escalate', summary: 'x', requestedAction: '   ',
    });
    expect(report?.requestedAction).toBeUndefined();
  });
});

describe('end-to-end mapping for the escalation regression', () => {
  it('a legacy escalation result lands as escalated / waiting_on_human / no class', () => {
    // Shape of the cap-exhausted producer before it set terminalState.
    const legacy = { ...base, success: true, escalated: true };
    const state = resolveTerminalState(legacy, false);
    expect(OUTCOME_BY_TERMINAL[state]).toBe('escalated');
    expect(THREAD_STATUS_BY_TERMINAL[state]).toBe('waiting_on_human');
    expect(resolveFailureClass(state)).toBeUndefined();
  });

  it('a deliberate task failure is terminal, error-outcome and classified', () => {
    const reported = { ...base, success: false, terminalState: 'task_failed' as const };
    const state = resolveTerminalState(reported, false);
    expect(OUTCOME_BY_TERMINAL[state]).toBe('error');
    expect(THREAD_STATUS_BY_TERMINAL[state]).toBe('failed');
    expect(resolveFailureClass(state, 'task_failed')).toBe('task_failed');
    expect(isTerminalForTrigger(state)).toBe(true);
  });
});

// ── A pause is not a success ─────────────────────────────────────────────────
//
// The defect these pin was not any one call site: it was that TerminalState had
// no 'paused' member at all. A pause was carried out-of-band as
// `{ success: true, paused: true }` with terminalState undefined, so the
// resolver fell through to 'success' and every consumer treated a run waiting
// on a person as a finished one. The same defect surfaced four separate times
// in different places before the missing member was found, because correctness
// depended on each author remembering a boolean the type never mentioned.

describe('resolveTerminalState — a paused run', () => {
  it('resolves to paused, not success', () => {
    // This is the exact shape every pause producer returns.
    expect(resolveTerminalState({ success: true, paused: true }, false)).toBe('paused');
  });

  it('checks paused BEFORE success, which is the whole defect', () => {
    // Asking about success first answered 'success' for every paused run.
    // Order, not presence, is what makes the check work.
    expect(resolveTerminalState({ success: true, paused: true }, false)).not.toBe('success');
  });

  it('lets an explicit terminalState still win', () => {
    // Producers that name their own state keep precedence.
    expect(resolveTerminalState({ success: true, paused: true, terminalState: 'gated' }, false))
      .toBe('gated');
  });

  it('leaves an ordinary success alone', () => {
    expect(resolveTerminalState({ success: true }, false)).toBe('success');
  });
});

describe('a paused run through every mapping', () => {
  it('never reads as completed to a thread', () => {
    // The invariant written on THREAD_STATUS_BY_TERMINAL's own header, which
    // the code violated: "A run waiting on a human must never read as
    // 'completed'."
    expect(THREAD_STATUS_BY_TERMINAL.paused).toBe('waiting_on_human');
  });

  it('never records success on the invocation', () => {
    // 'success' is what it used to fall through to — a run holding a pending
    // approval recorded as having finished its work.
    expect(OUTCOME_BY_TERMINAL.paused).not.toBe('success');
    expect(OUTCOME_BY_TERMINAL.paused).toBe('gated');
  });

  it('never records success in the audit log', () => {
    expect(AUDIT_OUTCOME_BY_TERMINAL.paused).not.toBe('success');
  });

  it('is not a failure either', () => {
    // A pause owes no failure_class: nothing failed, and classifying it as a
    // failure would be the same error in the opposite direction.
    expect(isFailureState('paused')).toBe(false);
  });
});
