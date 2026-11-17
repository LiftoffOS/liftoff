import { renderArgsHint, summarizeArgs } from '../args-hint';

describe('summarizeArgs', () => {
  it('reads name, type and required from a schema, required first, capped', () => {
    const args = summarizeArgs({
      type: 'object',
      properties: {
        a: { type: 'integer' },
        b: { type: 'string' },
        c: { type: ['string', 'null'] },
        d: { type: 'array', items: { type: 'string' } },
        e: {},
      },
      required: ['b', 'd'],
    }, 4);
    expect(args).toEqual([
      { name: 'b', type: 'string', required: true },
      { name: 'd', type: 'array of string', required: true },
      { name: 'a', type: 'integer', required: false },
      { name: 'c', type: 'string', required: false },
    ]);
  });

  it('is empty for anything that is not a schema with properties', () => {
    expect(summarizeArgs(undefined)).toEqual([]);
    expect(summarizeArgs('x')).toEqual([]);
    expect(summarizeArgs({ type: 'object' })).toEqual([]);
  });
});

describe('renderArgsHint', () => {
  it('renders each argument with its qualifiers, and nothing for none', () => {
    expect(renderArgsHint([])).toBe('');
    expect(renderArgsHint([
      { name: 'fields', type: 'string', required: true },
      { name: 'page', type: 'integer', required: false },
      { name: 'opaque', type: null, required: false },
    ])).toBe('; args: fields (string, required), page (integer), opaque');
  });
});
