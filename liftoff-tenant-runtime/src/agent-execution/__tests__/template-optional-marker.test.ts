// A message with one conditional clause was inexpressible.
//
// A code-review notification is the typical case. Its template says to name
// the risky surface WHEN the change touches one, and the distiller
// can only flatten that into an unconditional {{steps.s7.escalation_reason}}.
// On the ordinary path — a pull request touching nothing sensitive — s7 reports
// null, the null guard fires (correctly), and the entire notification dies. The
// clean review is the one nobody hears about.
//
// `condition` does not solve it: it guards a WHOLE step, and the notification
// must always send. The missing unit is a clause inside one message.

import { substitute, templateRefs } from '../template';
import { TemplateResolutionError } from '../types';

const ctx = {
  input: { id: 'abc' },
  steps: {
    s7: { escalation_reason: null, note: 'touches authentication' },
    s1: { pr: 81 },
  },
};

describe('an optional reference renders nothing when there is nothing to say', () => {
  it('drops the clause on the common path instead of killing the message', () => {
    // THE case. Without the marker this throws and no notification is sent at
    // all, so a clean review is silent while a risky one is announced.
    const out = substitute(
      '{"text": "Review ready for #{{steps.s1.pr}}. {{steps.s7.escalation_reason?}}"}',
      ctx,
    );
    expect(JSON.parse(out).text).toBe('Review ready for #81. ');
  });

  it('says the clause when there IS one', () => {
    const out = substitute('{"text": "Ready. {{steps.s7.note?}}"}', ctx);
    expect(JSON.parse(out).text).toBe('Ready. touches authentication');
  });

  it('covers absent, null and an empty root alike', () => {
    // All three are "nothing to say" at runtime, and an author cannot tell them
    // apart when writing the template. A marker that covered only one of them
    // would fail on the run where a different one happened.
    const t = '{"text": "a{{steps.s7.missing?}}b{{steps.s7.escalation_reason?}}c{{input.gone?}}d"}';
    expect(JSON.parse(substitute(t, ctx)).text).toBe('abcd');
    // `input` is empty on every cron fire — the root itself is undefined.
    expect(JSON.parse(substitute('{"t": "x{{input.anything?}}y"}', { steps: {} })).t).toBe('xy');
  });

  it('renders the JSON null token in a bare value position, never an empty hole', () => {
    // `{"count": }` is not JSON. A nullable field already accepts null there
    // today, so this is the same value, not a new one.
    const out = substitute('{"count": {{steps.s7.escalation_reason?}}}', ctx);
    expect(JSON.parse(out)).toEqual({ count: null });
    expect(() => JSON.parse(substitute('{"a": {{steps.s7.missing?}}}', ctx))).not.toThrow();
  });

  it('renders nothing in non-JSON mode', () => {
    expect(substitute('a{{steps.s7.missing?}}b', ctx, { jsonContext: false })).toBe('ab');
  });
});

describe('the marker changes absence, and nothing else', () => {
  it('leaves an UNMARKED reference failing exactly as before', () => {
    // The null guard is what keeps "null#null: null" messages out of a
    // channel. Marking one reference optional must not soften it for the
    // rest.
    expect(() => substitute('{"t": "x {{steps.s7.escalation_reason}}"}', ctx))
      .toThrow(TemplateResolutionError);
    expect(() => substitute('{"t": "x {{steps.s7.missing}}"}', ctx))
      .toThrow(TemplateResolutionError);
  });

  it('does not change a present value, including its escaping', () => {
    // The injection defence lives in this same path.
    const hostile = { steps: { s1: { v: 'general"}, "evil": "x' } } };
    const marked = substitute('{"t": "{{steps.s1.v?}}"}', hostile);
    const plain = substitute('{"t": "{{steps.s1.v}}"}', hostile);
    expect(marked).toBe(plain);
    expect(JSON.parse(marked)).toEqual({ t: 'general"}, "evil": "x' });
  });

  it('keeps a present value its own type in a bare position', () => {
    expect(JSON.parse(substitute('{"n": {{steps.s1.pr?}}}', ctx))).toEqual({ n: 81 });
  });

  it('does not read `?` as part of the path', () => {
    // If it did, every marked reference would resolve to undefined and the
    // marker would look like it worked while reporting nothing, forever.
    const refs = templateRefs('{{steps.s7.note?}}');
    expect(refs.resolvable).toEqual([{ root: 'steps', path: 's7.note', optional: true }]);
    expect(JSON.parse(substitute('{"t": "{{steps.s7.note?}}"}', ctx)).t)
      .toBe('touches authentication');
  });
});

describe('what it deliberately does not excuse', () => {
  it('reports an unresolvable ROOT as unresolvable even when marked', () => {
    // `{{now.iso?}}` can never resolve on any run. Absent-at-runtime is not what
    // that is, and letting `?` silence it would turn an authoring defect into
    // permanent silence — a template carrying `{{now.iso}}` would pass every
    // check as clean.
    const refs = templateRefs('{"t": "{{now.iso?}}"}');
    expect(refs.unresolvable).toEqual(['{{now.iso?}}']);
    expect(refs.resolvable).toEqual([]);
  });

  it('still reports the root and path so the graph validator can check them', () => {
    // The validator rejects an unknown step id and an input field the trigger
    // cannot supply. Both must keep firing on a marked reference: the marker
    // says "may be empty on this run", never "may not exist".
    const refs = templateRefs('{"a": "{{steps.nope.x?}}", "b": "{{input.thread_id?}}"}');
    expect(refs.resolvable).toEqual([
      { root: 'steps', path: 'nope.x', optional: true },
      { root: 'input', path: 'thread_id', optional: true },
    ]);
  });

  it('reports optional:false for every unmarked reference', () => {
    const refs = templateRefs('{{input.a}} {{output.b}} {{item.c}}');
    expect(refs.resolvable.every((r) => r.optional === false)).toBe(true);
  });
});

describe('the offset argument', () => {
  it('still knows a string literal from a bare token', () => {
    // The marker added a capture group, which moves `offset` from the fourth
    // callback argument to the fifth. Reading the old position is silent: it
    // yields the string "?" or undefined, both of which read as "not inside a
    // string", switching off the null guard AND the escaped-content encoding
    // for every placeholder in the codebase. This is the assertion that fails
    // if that ever regresses.
    const c = { steps: { s1: { s: 'a"b', n: 7 } } };
    // In-string: escaped content, no surrounding quotes added.
    expect(substitute('{"t": "x{{steps.s1.s}}"}', c)).toBe('{"t": "xa\\"b"}');
    // Bare: a full JSON token, type preserved.
    expect(substitute('{"n": {{steps.s1.n}}}', c)).toBe('{"n": 7}');
    // And the in-string null guard still fires, which depends on the same index.
    expect(() => substitute('{"t": "x{{steps.s1.z}}"}', { steps: { s1: { z: null } } }))
      .toThrow(/resolved to null/);
  });
});
