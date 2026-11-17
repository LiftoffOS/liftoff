// "null" is not something anyone meant to say.
//
// The resolver already refuses to substitute `undefined`, and its comment gives
// the reason: "Substituting a placeholder value here would send it onward as
// though it were real." A check on `value === undefined` alone lets a real,
// present `null` go straight through String(value) and become the four
// characters n-u-l-l.
//
// A step that declares "selected=false with all other fields null if not" has
// every field null on a tick with no open pull request, so a following Slack
// step renders
//
//     Code review ready — null#null: null
//     Author: @null
//     Risk: null
//     This is an automated first-pass review, not an approval.
//
// and posts it. Nothing is wrong with the tool, the connector, or the template
// — the step had no pull request and said so in nulls, and the formatter
// dresses that up as a review.
//
// The guard is scoped to interpolation INTO A STRING. A bare {{x}} occupying a
// whole JSON field is different: null is a legal, meaningful value for a
// nullable field, and refusing it there would break templates that pass it on
// purpose.
import { substitute } from '../template';
import { TemplateResolutionError } from '../types';

const ctx = (steps: Record<string, unknown>) => ({ steps } as never);

describe('null interpolated into text', () => {
  it('throws instead of writing "null" into a sentence', () => {
    expect(() =>
      substitute('Review ready — {{steps.s1.repo}}', ctx({ s1: { repo: null } }), { jsonContext: false }),
    ).toThrow(TemplateResolutionError);
  });

  it('throws on a JSON tool input whose text interpolates null step fields', () => {
    // A JSON tool input whose `text` field interpolates the producing step's
    // fields.
    const tmpl = '{"channel":"#x","text":"Code review ready — {{steps.s1.repoFullName}}#{{steps.s1.number}}"}';
    expect(() =>
      substitute(tmpl, ctx({ s1: { repoFullName: null, number: null } })),
    ).toThrow(/resolved to null/);
  });

  it('says which step produced nothing, so the fix is obvious', () => {
    let msg = '';
    try {
      substitute('{{steps.s1.title}}', ctx({ s1: { title: null } }), { jsonContext: false });
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('steps.s1.title');
    expect(msg).toContain('had nothing to report');
  });

  it('still allows null as a whole JSON field', () => {
    // Not interpolation — the author is passing a nullable field through, and
    // null is the right JSON token for it.
    const out = substitute('{"cursor": {{steps.s1.cursor}}}', ctx({ s1: { cursor: null } }));
    expect(JSON.parse(out)).toEqual({ cursor: null });
  });

  it('leaves real values alone', () => {
    expect(substitute('repo {{steps.s1.repo}}', ctx({ s1: { repo: 'acme/api' } }), { jsonContext: false }))
      .toBe('repo acme/api');
  });

  it('does not fire on falsy values that are not null', () => {
    // 0, "" and false are answers. Only null and undefined are absences, and
    // widening this to "falsy" would reject a legitimate zero count.
    expect(substitute('n={{steps.s1.n}}', ctx({ s1: { n: 0 } }), { jsonContext: false })).toBe('n=0');
    expect(substitute('b={{steps.s1.b}}', ctx({ s1: { b: false } }), { jsonContext: false })).toBe('b=false');
    expect(substitute('s={{steps.s1.s}}', ctx({ s1: { s: '' } }), { jsonContext: false })).toBe('s=');
  });

  it('still refuses undefined, which is what it always did', () => {
    expect(() => substitute('{{steps.s1.missing}}', ctx({ s1: {} }), { jsonContext: false }))
      .toThrow(TemplateResolutionError);
  });
});

// ── A structure interpolated into prose is the value, not "[object Object]" ──
//
// `String(value)` is right for a scalar and silently wrong for everything
// else. A description saying "Summarise {{steps.s1.products}}" reached the
// model asking it to summarise the literal words "[object Object]" — the same
// class as the nulls above, and the same defect the resolution exists to
// prevent: an instruction naming material the model was never given.
//
// It was invisible for as long as nobody looked at a non-scalar reference. It
// surfaced when a web result was framed on its way into the objective and the
// frame came back wrapped around nothing.

describe('a structure interpolated into prose', () => {
  const structureCtx = (steps: Record<string, unknown>) => ({ input: {}, output: {}, steps });

  it('renders the value, not [object Object]', () => {
    const products = [{ name: 'Standard', price: 49 }];
    const out = substitute('Summarise {{steps.s1.products}}', structureCtx({ s1: { products } }), { jsonContext: false });
    expect(out).toBe(`Summarise ${JSON.stringify(products)}`);
    expect(out).not.toContain('[object Object]');
  });

  it('renders an object reference the same way', () => {
    const row = { id: 4412, status: 'confirmed' };
    expect(substitute('Order {{steps.s1.row}}', structureCtx({ s1: { row } }), { jsonContext: false }))
      .toBe(`Order ${JSON.stringify(row)}`);
  });

  it('an array of scalars gains its brackets, so one element containing a comma is still one element', () => {
    expect(substitute('Tags: {{steps.s1.tags}}', structureCtx({ s1: { tags: ['a,b', 'c'] } }), { jsonContext: false }))
      .toBe('Tags: ["a,b","c"]');
  });

  it('every scalar renders byte for byte as it did', () => {
    expect(substitute('{{steps.s1.v}}', structureCtx({ s1: { v: 'plain text' } }), { jsonContext: false })).toBe('plain text');
    expect(substitute('{{steps.s1.v}}', structureCtx({ s1: { v: 0 } }), { jsonContext: false })).toBe('0');
    expect(substitute('{{steps.s1.v}}', structureCtx({ s1: { v: false } }), { jsonContext: false })).toBe('false');
  });

  it('JSON context is untouched: a structure there is still a JSON token', () => {
    const row = { id: 4412 };
    expect(substitute('{"row": {{steps.s1.row}}}', structureCtx({ s1: { row } }), { jsonContext: true }))
      .toBe(`{"row": ${JSON.stringify(row)}}`);
  });
});
