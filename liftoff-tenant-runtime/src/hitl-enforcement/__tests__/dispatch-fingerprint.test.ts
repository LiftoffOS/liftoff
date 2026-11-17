// An approval has to be FOR the calls that get dispatched.
//
// The tamper hash is verified when a person approves, against the approval's
// own copy of the pending calls. What actually runs is a DIFFERENT persisted
// record — the pause's `hitlContext.pendingToolCalls`, carried on the scheduled
// invocation — and nothing compared the two.
//
// The window matters: the approved dispatch runs with the HITL gate bypassed,
// deliberately, because re-gating a just-approved call would never make
// progress. So it is the one moment where nothing else would object to the
// wrong call going out.
import { hitlEnforcementService } from '../service';

// The GOVERNANCE shape, `{id, name, input}`. Two interfaces in this codebase
// are called `ToolCallRequest`, and the other one — agent-execution's
// `{id, connector, entityType, actionType, payload}` — hashes to the same
// constant for any input, because none of the fields this reads exist on it.
const CALLS = [
  { id: 'c1', name: 'gmail__send_email', input: { to: 'a@b.test' } },
];

describe('the tool-calls fingerprint', () => {
  it('is stable for the same calls', () => {
    expect(hitlEnforcementService.hashToolCalls(CALLS))
      .toBe(hitlEnforcementService.hashToolCalls([...CALLS]));
  });

  it('changes when the arguments change', () => {
    const edited = [{ ...CALLS[0], input: { to: 'someone-else@b.test' } }];
    expect(hitlEnforcementService.hashToolCalls(edited))
      .not.toBe(hitlEnforcementService.hashToolCalls(CALLS));
  });

  it('changes when the TOOL changes', () => {
    // The case the dispatch check exists for: an approval for one action must
    // not authorise a different one.
    const swapped = [{ ...CALLS[0], name: 'gmail__delete_email' }];
    expect(hitlEnforcementService.hashToolCalls(swapped))
      .not.toBe(hitlEnforcementService.hashToolCalls(CALLS));
  });

  it('refuses the wrong ToolCallRequest shape instead of hashing nothing', () => {
    // Both shapes are named `ToolCallRequest`. Handed the agent-execution one,
    // this used to return the same digest for every input — tamper detection
    // reporting "unchanged" for a changed tool, a changed argument and an added
    // call alike. Tests are not typechecked, so nothing would catch it.
    const wrongShape = [
      { id: 'c1', connector: 'gmail', entityType: '', actionType: 'send_email', payload: {} },
    ] as never;
    expect(() => hitlEnforcementService.hashToolCalls(wrongShape)).toThrow(/no `name`/);
  });

  it('changes when a call is added', () => {
    const extra = [...CALLS, { ...CALLS[0], id: 'c2' }];
    expect(hitlEnforcementService.hashToolCalls(extra))
      .not.toBe(hitlEnforcementService.hashToolCalls(CALLS));
  });
});
