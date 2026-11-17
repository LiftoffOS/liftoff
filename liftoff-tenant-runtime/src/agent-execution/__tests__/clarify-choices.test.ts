// Offering options on a question the agent already knows how to ask.
//
// Without this, an agent that needs to know which of three environments you
// meant writes a paragraph listing them, gets "the second one" back, and has to
// ask again. The value is entirely in the normalization and the resolution:
// models emit choice lists in a dozen shapes, and people answer with numbers.

import {
  MAX_CHOICES,
  OTHER_CHOICE_LABEL,
  buildClarifyRequest,
  normalizeChoices,
  renderChoicesAsText,
  resolveChoiceReply,
} from '../clarify-choices';

describe('normalizing what the model emitted', () => {
  it('accepts bare strings', () => {
    expect(normalizeChoices(['staging', 'production'])).toEqual([
      { label: 'staging', value: 'staging' },
      { label: 'production', value: 'production' },
    ]);
  });

  it.each([
    ['label', [{ label: 'Staging' }]],
    ['title', [{ title: 'Staging' }]],
    ['name', [{ name: 'Staging' }]],
    ['text', [{ text: 'Staging' }]],
  ])('accepts objects keyed on %s', (_k, raw) => {
    expect(normalizeChoices(raw)?.[0].label).toBe('Staging');
  });

  it('keeps an explicit value distinct from the label', () => {
    expect(normalizeChoices([{ label: 'Production', value: 'prod-us-west' }])).toEqual([
      { label: 'Production', value: 'prod-us-west' },
    ]);
  });

  it('carries a description when there is one', () => {
    expect(normalizeChoices([{ label: 'Staging', description: 'Safe to break' }])?.[0])
      .toEqual({ label: 'Staging', value: 'Staging', description: 'Safe to break' });
  });

  it('drops duplicates, which would make any answer ambiguous', () => {
    expect(normalizeChoices(['Staging', 'staging', 'Production'])).toHaveLength(2);
  });

  it('caps the list', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(normalizeChoices(many)).toHaveLength(MAX_CHOICES);
  });

  it('returns null rather than an empty picker', () => {
    // An ask_user with no choices is a perfectly good free-text question and
    // should stay one.
    expect(normalizeChoices([])).toBeNull();
    expect(normalizeChoices(undefined)).toBeNull();
    expect(normalizeChoices('not an array')).toBeNull();
    expect(normalizeChoices([{ nothing: 'useful' }])).toBeNull();
    expect(normalizeChoices(['', '   '])).toBeNull();
  });
});

describe('buildClarifyRequest', () => {
  it('returns null for an open question, leaving it free-text', () => {
    expect(buildClarifyRequest('What should I do?', undefined)).toBeNull();
  });

  it('defaults to single-select', () => {
    expect(buildClarifyRequest('Which?', ['a', 'b'])?.multiSelect).toBe(false);
  });

  it('honours multi-select when asked for', () => {
    expect(buildClarifyRequest('Which?', ['a', 'b'], true)?.multiSelect).toBe(true);
  });
});

describe('rendering for a surface with no buttons', () => {
  const req = buildClarifyRequest('Which environment?', [
    { label: 'Staging', description: 'Safe to break' },
    'Production',
  ])!;

  it('numbers the options, so "the second one" is unambiguous', () => {
    const text = renderChoicesAsText(req);
    expect(text).toContain('1. Staging');
    expect(text).toContain('2. Production');
  });

  it('shows the description where there is one', () => {
    expect(renderChoicesAsText(req)).toContain('Safe to break');
  });

  it('always offers a way out of the list', () => {
    // A closed list that does not admit "none of these" forces a wrong answer.
    expect(renderChoicesAsText(req)).toContain(OTHER_CHOICE_LABEL);
  });

  it('tells the person how to answer', () => {
    expect(renderChoicesAsText(req)).toMatch(/Reply with the number/);
  });

  it('asks for numbers, plural, when several may apply', () => {
    const multi = buildClarifyRequest('Which?', ['a', 'b'], true)!;
    expect(renderChoicesAsText(multi)).toMatch(/Reply with the numbers/);
  });
});

describe('resolving the reply', () => {
  const req = buildClarifyRequest('Which environment?', ['Staging', 'Production', 'Local'])!;

  it('resolves a bare number', () => {
    expect(resolveChoiceReply(req, '2')?.[0].label).toBe('Production');
  });

  it('resolves a label', () => {
    expect(resolveChoiceReply(req, 'production')?.[0].label).toBe('Production');
  });

  it('resolves a label inside a sentence', () => {
    expect(resolveChoiceReply(req, 'lets do staging please')?.[0].label).toBe('Staging');
  });

  it('resolves a prefix', () => {
    expect(resolveChoiceReply(req, 'prod')?.[0].label).toBe('Production');
  });

  it('takes only one for a single-select question', () => {
    expect(resolveChoiceReply(req, '1 and 2')).toHaveLength(1);
  });

  it('takes several for a multi-select question', () => {
    const multi = buildClarifyRequest('Which?', ['Staging', 'Production', 'Local'], true)!;
    expect(resolveChoiceReply(multi, '1 and 3')).toHaveLength(2);
  });

  it('returns null when they answered in their own words', () => {
    // Not a failure: that is a real answer and must be passed through as it is,
    // not forced into a bucket.
    expect(resolveChoiceReply(req, 'whichever is cheapest')).toBeNull();
  });

  it('treats the trailing "something else" index as no match', () => {
    // Index 4 here is the appended escape hatch, which means none of these.
    expect(resolveChoiceReply(req, '4')).toBeNull();
  });

  it('returns null for an empty reply', () => {
    expect(resolveChoiceReply(req, '   ')).toBeNull();
  });
});
