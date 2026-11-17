// A destination the person named in a picker has to reach the team, and the
// only path that already works is the prose.
//
// For example, a code reviewer posts to #code-reviewer because somebody typed
// that string into its responsibilities, and distill-service tells the model
// to carry identifiers through verbatim.
// Nothing else carries a destination — `config.destinations` on the binding is
// written by the connectors step and read by no one, and the tool-gateway
// injects binding config for Gmail and Outlook alone. So a pick becomes prose,
// exactly as a typed channel name already is.
//
// Every failure mode here is silent, which is why each is pinned directly:
//
//   1. Both routers validate with `z.object()`, which STRIPS undeclared keys.
//      Undeclared, every pick vanishes between the browser and the distiller
//      and the prose reads as though nobody chose anything.
//
//   2. An unanswered pick that substitutes to an empty string leaves "Post the
//      summary to ." in a system prompt. The fallback phrase is what makes the
//      sentence survive its own absence.
//
//   3. The cache is keyed by fingerprint. One workspace hiring one template
//      into two different channels differs ONLY in the picks, so without them
//      in the key the second team silently gets the first one's instructions
//      and posts where its owner never chose.

import { __testOnlyDistillInputSchema as streamSchema } from '../distill-stream-router';
import { __testOnlyDistillInputSchema as postSchema } from '../distill-router';
import { computeFingerprint } from '../distill-cache';
import { applyTemplatePicks, applyTemplateInputs, type DistillInput } from '../distill-service';

const BASE = {
  role: 'Code Reviewer',
  responsibilities: '## Workflows\n1. Notify {{pick:engineering-channel}} that the review is ready',
  integrations: [],
};

const PICKS = {
  'engineering-channel': { id: 'C01234', title: '#eng-alerts' },
};

const FALLBACKS = {
  'engineering-channel': 'your engineering channel',
  'working-folder': 'the folder they work in',
};

describe('picks survive the routers', () => {
  it.each([
    ['stream', streamSchema],
    ['post', postSchema],
  ])('%s router keeps them rather than stripping them', (_label, schema) => {
    const parsed = schema.parse({ ...BASE, templatePicks: PICKS });
    expect(parsed.templatePicks).toEqual(PICKS);
  });

  it.each([
    ['stream', streamSchema],
    ['post', postSchema],
  ])('%s router still accepts a body with no picks at all', (_label, schema) => {
    // TeamBuilder distillations have no template, so no picks either.
    expect(schema.parse(BASE).templatePicks).toBeUndefined();
  });
});

describe('applyTemplatePicks', () => {
  it('writes the name and the id, because different readers need different halves', () => {
    // slack__send_message takes a channel ID; the sentence around it needs the
    // name. Dropping either one costs something real.
    expect(applyTemplatePicks('Notify {{pick:engineering-channel}} today', PICKS, FALLBACKS))
      .toBe('Notify "#eng-alerts" (id C01234) today');
  });

  it('falls back to the phrase when nobody picked', () => {
    expect(applyTemplatePicks('Notify {{pick:engineering-channel}}', {}, FALLBACKS))
      .toBe('Notify your engineering channel');
  });

  it('falls back when the pick arrived empty', () => {
    expect(applyTemplatePicks(
      'Notify {{pick:engineering-channel}}',
      { 'engineering-channel': { id: '  ', title: '  ' } },
      FALLBACKS,
    )).toBe('Notify your engineering channel');
  });

  it('never leaves the sentence with a hole in it', () => {
    // The regression this prevents: "Post the summary to ." reaching a prompt.
    const out = applyTemplatePicks('Post to {{pick:unknown-thing}}.', {}, {});
    expect(out).not.toMatch(/\{\{/);
    expect(out).toBe('Post to the connected workspace.');
  });

  it('substitutes every occurrence', () => {
    expect(applyTemplatePicks(
      '{{pick:engineering-channel}} and {{pick:engineering-channel}}', PICKS, FALLBACKS,
    )).toBe('"#eng-alerts" (id C01234) and "#eng-alerts" (id C01234)');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(applyTemplatePicks('Notify {{ pick:engineering-channel }}', PICKS, FALLBACKS))
      .toBe('Notify "#eng-alerts" (id C01234)');
  });

  it('leaves unrelated braces alone', () => {
    expect(applyTemplatePicks('{filename}_v1.xlsx', PICKS, FALLBACKS)).toBe('{filename}_v1.xlsx');
  });
});

describe('picks and inputs cannot eat each other', () => {
  // They run over the same text, one after the other, and both are `{{...}}`.
  // The namespaces are disjoint by construction — an input id cannot contain a
  // colon or a hyphen — and this is where that stays true.
  it('leaves a pick placeholder untouched when substituting inputs', () => {
    expect(applyTemplateInputs('Notify {{pick:engineering-channel}} about {{company_name}}', {
      company_name: 'Acme Corp',
    })).toBe('Notify {{pick:engineering-channel}} about Acme Corp');
  });

  it('leaves an input placeholder untouched when substituting picks', () => {
    expect(applyTemplatePicks('Notify {{pick:engineering-channel}} about {{company_name}}', PICKS, FALLBACKS))
      .toBe('Notify "#eng-alerts" (id C01234) about {{company_name}}');
  });

  it('resolves both when run in order, leaving nothing behind', () => {
    const out = applyTemplatePicks(
      applyTemplateInputs('Notify {{pick:engineering-channel}} about {{company_name}}', { company_name: 'Acme Corp' }),
      PICKS,
      FALLBACKS,
    );
    expect(out).toBe('Notify "#eng-alerts" (id C01234) about Acme Corp');
    expect(out).not.toMatch(/\{\{/);
  });
});

describe('picks are part of the cache key', () => {
  const input = (templatePicks?: DistillInput['templatePicks']): DistillInput => ({
    role: BASE.role,
    responsibilities: BASE.responsibilities,
    integrations: [],
    tenantId: '11111111-1111-1111-1111-111111111111',
    templatePicks,
  });

  it('gives two teams hired into different channels different keys', () => {
    expect(computeFingerprint(input({ 'engineering-channel': { id: 'C1', title: '#a' } }), 'h', ''))
      .not.toBe(computeFingerprint(input({ 'engineering-channel': { id: 'C2', title: '#b' } }), 'h', ''));
  });

  it('notices a channel renamed to the same id', () => {
    expect(computeFingerprint(input({ 'engineering-channel': { id: 'C1', title: '#old' } }), 'h', ''))
      .not.toBe(computeFingerprint(input({ 'engineering-channel': { id: 'C1', title: '#new' } }), 'h', ''));
  });

  it('still hits for the same picks hired twice', () => {
    expect(computeFingerprint(input(PICKS), 'h', '')).toBe(computeFingerprint(input(PICKS), 'h', ''));
  });

  it('does not depend on the order the picks were made', () => {
    const a = computeFingerprint(input({ a: { id: '1', title: 'x' }, b: { id: '2', title: 'y' } }), 'h', '');
    const b = computeFingerprint(input({ b: { id: '2', title: 'y' }, a: { id: '1', title: 'x' } }), 'h', '');
    expect(a).toBe(b);
  });

  it('separates picking from not picking', () => {
    expect(computeFingerprint(input(PICKS), 'h')).not.toBe(computeFingerprint(input(undefined), 'h', ''));
  });
});
