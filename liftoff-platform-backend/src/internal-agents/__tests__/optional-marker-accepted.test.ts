// The distiller is now told to emit `{{steps.s7.reason?}}` for a clause a
// message says only sometimes. This is the check that nothing on THIS side
// rejects what that side is told to write.
//
// The shape it guards against is the one this repo pays for repeatedly: a
// construct wired at one end. The prompt asks for the marker, the runtime
// understands it, and a validator here reports it as an unaddressable
// reference — at which point the retry loop "fixes" the step by deleting the
// very thing that made the message work, and every check stays green.

import { findWorkflowStepProblems } from '../workflow-steps-executable';

const base = { stepId: 's1', type: 'tool_call', toolName: 'x__y' };

describe('a marked placeholder is the same reference as an unmarked one', () => {
  it('accepts an optional input field the trigger DOES supply', () => {
    // The trap: `inner.split('.').slice(1)` keeps the marker on the final
    // segment, so the path becomes "message.threadId?" and resolves against
    // nothing. `{{input.message.threadId}}` is the single most common reference
    // an event-triggered agent writes.
    const problems = findWorkflowStepProblems(
      [{ ...base, toolInputTemplate: '{"t":"reply to {{input.message.threadId?}}"}' }],
      ['gmail'],
    );
    expect(problems.filter((p) => p.code === 'UNADDRESSABLE_REF')).toEqual([]);
  });

  it('accepts an optional read of a step that exists', () => {
    const problems = findWorkflowStepProblems([
      { ...base, stepId: 's1' },
      { stepId: 's2', type: 'tool_call', toolName: 'x__y',
        toolInputTemplate: '{"t":"ready. {{steps.s1.reason?}}"}' },
    ]);
    expect(problems.filter((p) => p.code === 'UNADDRESSABLE_REF')).toEqual([]);
  });
});

describe('the marker does not excuse a reference that can never resolve', () => {
  it('still rejects an unknown ROOT', () => {
    const problems = findWorkflowStepProblems(
      [{ ...base, toolInputTemplate: '{"t":"at {{now.iso?}}"}' }],
    );
    expect(problems.map((p) => p.code)).toContain('UNADDRESSABLE_REF');
  });

  it('still rejects an unknown STEP id', () => {
    const problems = findWorkflowStepProblems(
      [{ ...base, toolInputTemplate: '{"t":"{{steps.s99.x?}}"}' }],
    );
    expect(problems.some((p) => p.message.includes('s99'))).toBe(true);
  });

  it('reports exactly what the unmarked reference reports, whatever that is', () => {
    // The general property, and the one that survives this validator changing
    // its mind about any particular path: the marker says a resolvable
    // reference may be EMPTY on a given run. It never says which reference it
    // is. So for every template, marked and unmarked must agree.
    //
    // Written as parity after asserting a specific rejection and getting it
    // wrong: `{{input.thread_id}}` is not flagged here today. Pinning the
    // behaviour I assumed would have tested this file's premise rather than the
    // marker.
    const templates = [
      '{"t":"{{input.thread_id?}}"}',
      '{"t":"{{input.message.threadId?}}"}',
      '{"t":"{{now.iso?}}"}',
      '{"t":"{{steps.s99.x?}}"}',
      '{"t":"{{output.total?}}"}',
      '{"t":"{{item.path?}}"}',
    ];
    const codes = (t: string) => findWorkflowStepProblems(
      [{ ...base, toolInputTemplate: t }], ['gmail'],
    ).map((p) => `${p.code}:${p.stepId}`);

    for (const marked of templates) {
      expect(codes(marked)).toEqual(codes(marked.replace(/\?}}/g, '}}')));
    }
  });

  it('quotes the marker back when it does reject one', () => {
    // Compared on codes above, not messages, because the message SHOULD differ:
    // it echoes what the author actually wrote. An error quoting
    // `{{now.iso}}` at someone who wrote `{{now.iso?}}` sends them looking for
    // a placeholder that is not in their file.
    const [problem] = findWorkflowStepProblems(
      [{ ...base, toolInputTemplate: '{"t":"{{now.iso?}}"}' }],
    );
    expect(problem.message).toContain('{{now.iso?}}');
  });
});
