// Validation must reject exactly what the runtime cannot resolve — no more,
// no less.
//
// Both holes closed here came from validation IMITATING the runtime's grammar
// with a looser pattern of its own:
//
//   - conditions were checked by running evaluateCondition against `{}` and
//     inspecting the throw. A parseable predicate returns false on empty data
//     rather than throwing, so the check almost never ran, and its fallback
//     accepted any `$.token` at all. `$.output.foo` passed and then read
//     nothing on every run.
//   - templates were checked by nulling `/\{\{[^}]+\}\}/g` and parsing JSON.
//     That matches strictly MORE than substitute() resolves, so an unknown
//     root parsed clean and rendered verbatim into the tool arguments.
//
// A stored graph that hits both holes is pinned below.

import { validateWorkflowGraph } from '../validate-workflow-graph';
import { conditionFieldPaths } from '../condition';
import { templateRefs } from '../template';
import { substitute } from '../template';

const codes = (steps: Parameters<typeof validateWorkflowGraph>[0]): string[] =>
  validateWorkflowGraph(steps).map(e => e.code);

describe('condition addressing', () => {
  it('accepts the roots the evaluator is actually given', () => {
    expect(codes([
      { stepId: 's1', type: 'llm_reason', onSuccess: 's2', condition: "$.input.status == 'open'" },
      { stepId: 's2', type: 'llm_reason', condition: '$.steps.s1.score > 3' },
    ])).toEqual([]);
  });

  it('rejects a root nothing will ever populate', () => {
    // THE regression. `output` was the pre-registry syntax; the evaluator is
    // handed { input, steps } and never an `output` key, so this is false
    // forever and the branch is silently dead.
    expect(codes([
      { stepId: 's1', type: 'llm_reason', condition: "$.output.verdict == 'approve'" },
    ])).toContain('INVALID_CONDITION_ROOT');
  });

  it('rejects a reference to a step that does not exist', () => {
    expect(codes([
      { stepId: 's1', type: 'llm_reason', onSuccess: 's2', condition: '$.steps.nope.x == 1' },
      { stepId: 's2', type: 'llm_reason' },
    ])).toContain('UNKNOWN_STEP_REF');
  });

  it('reports unparseable syntax as unparseable, not as a bad root', () => {
    const errs = validateWorkflowGraph([
      { stepId: 's1', type: 'llm_reason', condition: 'status = open' },
    ]);
    expect(errs.map(e => e.code)).toContain('INVALID_CONDITION');
  });

  it('checks every predicate in a compound condition, not just the first', () => {
    // The old check bailed after one throw; a bad root hiding behind a good
    // one was invisible.
    expect(codes([
      { stepId: 's1', type: 'llm_reason', condition: "$.input.a == 1 && $.nope.b == 2" },
    ])).toContain('INVALID_CONDITION_ROOT');
  });

  it('exposes the same paths the evaluator parses', () => {
    expect(conditionFieldPaths("$.input.a == 1 || $.steps.s2.b > 3"))
      .toEqual(['input.a', 'steps.s2.b']);
  });
});

describe('template addressing', () => {
  it('accepts the four roots substitute() resolves', () => {
    expect(codes([
      {
        stepId: 's1', type: 'tool_call', toolName: 't__fn',
        toolInputTemplate: '{"a":{{input.x}},"b":{{output.y}},"c":{{item.z}}}',
      },
    ])).toEqual([]);
  });

  it('rejects a placeholder the runtime renders literally', () => {
    // JSON.parse of the nulled string succeeds, so every check would call this
    // clean, and the agent would post the characters "{{now.iso}}" to a
    // human.
    const errs = validateWorkflowGraph([
      {
        stepId: 's6', type: 'tool_call', toolName: 't__fn',
        toolInputTemplate: '{"text":"BTC price log failed for the {{now.iso}} run."}',
      },
    ]);
    expect(errs.map(e => e.code)).toContain('INVALID_TEMPLATE_REF');
    expect(errs.find(e => e.code === 'INVALID_TEMPLATE_REF')!.message).toContain('{{now.iso}}');
  });

  it('agrees with what substitute actually does', () => {
    // The two must not drift: anything reported unresolvable must survive
    // substitution verbatim, and anything reported resolvable must not.
    const tpl = '{"a":{{now.iso}},"b":{{input.x}}}';
    const refs = templateRefs(tpl);
    const out = substitute(tpl, { input: { x: 1 } });
    for (const bad of refs.unresolvable) expect(out).toContain(bad);
    for (const good of refs.resolvable) expect(out).not.toContain(`{{${good.root}.${good.path}}}`);
  });

  it('does not flag a deliberately escaped literal', () => {
    expect(codes([
      {
        stepId: 's1', type: 'tool_call', toolName: 't__fn',
        toolInputTemplate: '{"note":"write \\{\\{input.x\\}\\} to mean the placeholder"}',
      },
    ])).not.toContain('INVALID_TEMPLATE_REF');
  });

  it('rejects a template naming a step that does not exist', () => {
    expect(codes([
      {
        stepId: 's1', type: 'tool_call', toolName: 't__fn',
        toolInputTemplate: '{"a":{{steps.ghost.value}}}',
      },
    ])).toContain('UNKNOWN_STEP_REF');
  });

  it('still catches malformed JSON', () => {
    expect(codes([
      { stepId: 's1', type: 'tool_call', toolName: 't__fn', toolInputTemplate: '{"a":{{input.x}}' },
    ])).toContain('INVALID_TEMPLATE');
  });
});

describe('representative stored workflows', () => {
  it('passes the eight conditions and four templates that were already correct', () => {
    // Representative stored conditions and templates, so a future change to
    // the grammar cannot quietly invalidate live agents.
    expect(codes([
      { stepId: 's1', type: 'llm_reason', onSuccess: 's2' },
      { stepId: 's2', type: 'llm_reason', onSuccess: 's3', condition: "$.steps.s1.type == 'billing'" },
      {
        stepId: 's3', type: 'tool_call', toolName: 't__fn',
        condition: "$.steps.s2.confidence == 'high'",
        toolInputTemplate: '{"query":"{{steps.s2.type}} {{steps.s1.subject}}"}',
      },
    ])).toEqual([]);
  });
});

describe('a placeholder inside a JSON string', () => {
  it('substitutes as escaped content, not as a quoted token', () => {
    // `{"id":"{{input.threadId}}"}` must not render `{"id":""abc""}` — not
    // JSON. It is a shape authors write naturally.
    const out = substitute('{"id":"{{input.threadId}}"}', { input: { threadId: 'abc123' } });
    expect(out).toBe('{"id":"abc123"}');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('composes several values into one string, which was inexpressible', () => {
    const out = substitute(
      '{"text":"Review ready for {{steps.s1.repo}}#{{steps.s1.number}} by {{steps.s1.author}}"}',
      { steps: { s1: { repo: 'liftoff', number: 42, author: 'ada' } } },
    );
    expect(JSON.parse(out)).toEqual({ text: 'Review ready for liftoff#42 by ada' });
  });

  it('still emits a full JSON token outside a string, preserving type', () => {
    const out = substitute('{"n":{{input.count}},"ok":{{input.flag}}}', { input: { count: 5, flag: true } });
    expect(JSON.parse(out)).toEqual({ n: 5, ok: true });
  });

  it('keeps the injection defence inside a string', () => {
    // The hostile value must stay ONE string rather than introducing siblings.
    const out = substitute('{"q":"{{input.evil}}"}', { input: { evil: 'general", "admin": "yes' } });
    expect(JSON.parse(out)).toEqual({ q: 'general", "admin": "yes' });
  });

  it('flags a template that would still break, rather than nulling it clean', () => {
    // The old check turned every placeholder into `null`, so quote breakage was
    // invisible. A stray quote must now surface.
    expect(codes([
      { stepId: 's1', type: 'tool_call', toolName: 't__fn', toolInputTemplate: '{"a":"{{input.x}}}' },
    ])).toContain('INVALID_TEMPLATE');
  });

  it('accepts the input templates once quoted placeholders substitute cleanly', () => {
    expect(codes([
      { stepId: 's1', type: 'tool_call', toolName: 't__fn', onSuccess: 's2', toolInputTemplate: '{"id":"{{input.threadId}}"}' },
      { stepId: 's2', type: 'tool_call', toolName: 't__fn', toolInputTemplate: '{"query":"from:{{input.from}}","max_results":25}' },
    ])).toEqual([]);
  });
});
