// Running out of room is its own ending — on every engine.
//
// A run that hits its ceiling must not be reported as `outcome: 'error'`,
// identical to a crash. A run can write its results — the spreadsheet updated —
// and only then hit the turn cap; filed as a crash, it counts toward the
// consecutive-failure limit and can stop the team.
//
// The mistake is not the ceiling, it is having nowhere to say "cut off while
// working". Each vendor names it differently — Anthropic `error_max_turns`,
// Gemini a MAX_TOKENS finish reason, the OpenAI Agents SDK a thrown
// MaxTurnsExceeded — so the translation belongs at each adapter edge, exactly
// like vendor tool errors already translate into the shared error contract.

import {
  OUTCOME_BY_TERMINAL,
  THREAD_STATUS_BY_TERMINAL,
  AUDIT_OUTCOME_BY_TERMINAL,
  isFailureState,
  isTerminalForTrigger,
  learningSignal,
  resolveTerminalState,
} from '../terminal-state';

describe('limit_reached is a terminal state of its own', () => {
  it('is not a success — the objective was never reported met', () => {
    expect(OUTCOME_BY_TERMINAL.limit_reached).toBe('error');
    expect(AUDIT_OUTCOME_BY_TERMINAL.limit_reached).toBe('error');
    expect(THREAD_STATUS_BY_TERMINAL.limit_reached).toBe('failed');
  });

  it('owes a failure class, so it stays queryable', () => {
    expect(isFailureState('limit_reached')).toBe(true);
  });

  it('does not re-open the trigger for redelivery', () => {
    // Re-running would hit the same ceiling and bill for it again.
    expect(isTerminalForTrigger('limit_reached')).toBe(true);
  });

  it('teaches the learning loops nothing', () => {
    // The run was cut off, not misled. Scoring the injected memories negative
    // would blame retrieval for a budget that was too small — the same reason
    // escalated and gated are neutral.
    expect(learningSignal('limit_reached')).toBe('none');
    expect(learningSignal('engine_error')).toBe('negative');
  });

  it('is distinguishable from a crash', () => {
    expect(resolveTerminalState({ terminalState: 'limit_reached' }, false)).toBe('limit_reached');
    expect(OUTCOME_BY_TERMINAL.limit_reached).toBe(OUTCOME_BY_TERMINAL.engine_error);
    // Same invocations.outcome (the CHECK admits no better member), but never
    // the same terminal state — which is what every consumer actually reads.
    expect('limit_reached').not.toBe('engine_error');
  });
});

describe('the shared adapter contract carries it', () => {
  it('every engine has one word for the same ending', () => {
    const SRC = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'adapter', 'types.ts'), 'utf8',
    );
    expect(SRC).toMatch(/'success' \| 'error' \| 'escalated' \| 'limit_reached'/);
  });
});
