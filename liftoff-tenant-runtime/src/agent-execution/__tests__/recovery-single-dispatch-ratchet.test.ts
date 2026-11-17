// One place decides what happens when recovery fails.
//
// The hybrid loop recovers in three situations — a step threw, a clarification
// was answered, a user interrupted mid-run — and each used to invoke the
// recovery LLM and dispatch its decision with its own copy of the sequence.
// They drifted where it mattered most: only the step-loop catch kept the
// recovery-cap accounting, so only it could safely retry a failed corrective
// action, and the other two had to escalate on a case it recovered from. Same
// anomaly, different outcome, decided by which code path happened to notice.
//
// This is a source-level ratchet rather than a behavioural test because the
// property is structural: it is about there being ONE implementation, which no
// amount of exercising one path can demonstrate. A future site that calls
// `dispatchRecoveryDecision` directly gets its own semantics for free, silently,
// which is what this refuses.

import { readFileSync } from 'fs';
import { join } from 'path';

const SERVICE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** Strip the declaration line so only invocations are counted. */
function callSitesOf(name: string): number {
  const lines = SERVICE.split('\n');
  return lines.filter((l) => {
    if (!l.includes(`${name}(`)) return false;
    if (l.includes(`private async ${name}(`)) return false;
    // The return-type reference inside runRecoveryCycle's own signature.
    if (l.includes(`ReturnType<AgentExecutionService['${name}']>`)) return false;
    return true;
  }).length;
}

describe('recovery has exactly one dispatch path', () => {
  it('dispatchRecoveryDecision is invoked from exactly one place', () => {
    // That one place is runRecoveryCycle. If this number rises, a caller has
    // gained its own recovery semantics — most importantly its own answer to
    // "the corrective action failed", which is the question that, answered
    // wrongly, produces a fabricated success.
    expect(callSitesOf('dispatchRecoveryDecision')).toBe(1);
  });

  it('every recovery site goes through runRecoveryCycle', () => {
    // Three sites: the step-loop catch, the ask_user resume prologue, and the
    // mid-run message interrupt.
    expect(callSitesOf('runRecoveryCycle')).toBe(3);
  });

  it('the workflow loop invokes the recovery LLM only inside the shared cycle', () => {
    // Two call sites, and the second is deliberately NOT part of this cycle:
    // the CONVERSATIONAL branch recovers too, but it has no workflow steps, no
    // step registry and no cursor to advance — its recovery returns a message
    // injected into the next turn rather than a step dispatch, and it keeps its
    // own `recoveryCounters`. Folding it into runRecoveryCycle would force a
    // step-shaped decision onto a loop that has no steps.
    //
    // The number is pinned rather than the shape so that a THIRD site — which
    // would be a workflow-side recovery path outside the cycle — fails here.
    expect(callSitesOf('invokeRecoveryLLMOrSynthesize')).toBe(2);
  });

  it('the retry budget is charged in one place', () => {
    // Two occurrences: the step-loop catch's pre-recovery charge, and the
    // cycle's per-retry charge. A third would mean a path that can retry
    // without paying, which is an unbounded loop against a live model.
    const charges = SERVICE.split('\n')
      .filter((l) => l.includes('perStepRecoveries[step.stepId] = (perStepRecoveries[step.stepId] ?? 0) + 1'));
    expect(charges).toHaveLength(2);
  });
});
