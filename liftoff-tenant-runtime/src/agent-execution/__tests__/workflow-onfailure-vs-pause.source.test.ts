// A step's onFailure route must not swallow a pause.
//
// The hybrid workflow loop's catch handled `step.onFailure` FIRST and
// `continue`d, so every error routed to the failure handler — including the two
// that mean "stop and wait for a person":
//
//   HitlGateError               a governance gate fired
//   AdapterPauseRequestedError  an approval, or an ask_user question
//
// On a step with onFailure configured the effect was that a gate fired, an
// approval row was created, a human was notified over Slack, and then the run
// carried on to the failure handler and COMPLETED. The operator's approval
// requirement never held the work, and the approval sat pending forever against
// a finished run, so deciding it could change nothing.
//
// Concretely: a gated tool call logs "HITL gate triggered, execution paused",
// the loop routes to the step's failure handler, and the invocation completes
// 'success' seconds later with the approval still pending. onFailure routes are
// common in authored workflows, so this is widely reachable.
//
// Asserted on source because the alternative is booting the whole hybrid loop
// with a workflow definition, a gating tool call and an approval store — the
// ordering is a property of the catch block itself, and this pins it directly.
// The behavioural counterpart lives in conv-hitl-pause.test.ts for the
// conversational path, which never had this bug.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** The hybrid workflow loop's step catch, from the onFailure guard to the end
 *  of the HitlGateError branch. */
function catchBlock(): string {
  const start = SRC.indexOf("// A step's onFailure route takes precedence over the recovery LLM");
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf('AdapterPauseRequestedError → adapter-driven step paused itself', start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe('a workflow step onFailure route does not swallow a pause', () => {
  it('guards the onFailure route against pause signals', () => {
    const block = catchBlock();
    // The route must be conditional on the error NOT being a pause. It now also
    // excludes a contract defect — a step whose INPUTS could not be built was
    // never attempted, so the author's business-failure branch is the wrong
    // route for it — but the pause guard is what this test exists to protect.
    expect(block).toMatch(/if \(step\.onFailure && !isPauseSignal(?: && !isContractDefect)?\)/);
  });

  it('treats both pause types as pauses, not failures', () => {
    const block = catchBlock();
    expect(block).toMatch(/isPauseSignal[\s\S]{0,160}HitlGateError/);
    expect(block).toMatch(/isPauseSignal[\s\S]{0,160}AdapterPauseRequestedError/);
  });

  it('still routes ordinary failures to the failure handler', () => {
    // The fix must not disable onFailure — a genuine step failure still routes.
    const block = catchBlock();
    expect(block).toMatch(/currentStepId = step\.onFailure;/);
    expect(block).toMatch(/continue;/);
  });

  it('decides the pause BEFORE taking the route', () => {
    // Ordering is the whole defect: computing isPauseSignal after the route
    // would be dead code, exactly as the HitlGateError branch was.
    const block = catchBlock();
    expect(block.indexOf('const isPauseSignal'))
      .toBeLessThan(block.indexOf('if (step.onFailure'));
  });
});
