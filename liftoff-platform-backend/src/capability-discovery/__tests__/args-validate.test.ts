// Arguments fit a schema as they are, or they do not: no coercion, no
// defaults, every supplied name declared, and a schema this validator does not
// understand authorises nothing.

import { validateArgsAgainstSchema } from '../args-validate';

const SCHEMA = {
  type: 'object',
  properties: {
    q: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    sort: { type: 'string', enum: ['top', 'new'] },
    tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
    filters: { type: 'object', properties: { since: { type: 'string' }, region: { type: 'string' } }, required: ['since'], additionalProperties: false },
    ratio: { type: 'number' },
    nullable: { type: ['string', 'null'] },
  },
  required: ['q'],
};

const valid = (args: Record<string, unknown>, schema: unknown = SCHEMA) => validateArgsAgainstSchema(args, schema).valid;
const reason = (args: Record<string, unknown>, schema: unknown = SCHEMA) => {
  const v = validateArgsAgainstSchema(args, schema);
  return v.valid ? null : v.reason;
};

describe('validateArgsAgainstSchema', () => {
  it('accepts arguments that fit', () => {
    expect(valid({ q: 'shopify' })).toBe(true);
    expect(valid({ q: 'shopify', limit: 10, sort: 'top', tags: ['a'], filters: { since: '2026-01-01' }, ratio: 0.5, nullable: null })).toBe(true);
    expect(valid({ q: 'shopify', limit: undefined })).toBe(true); // an undefined value is an absent one
  });

  it('requires every required argument, and inserts no default', () => {
    expect(reason({ limit: 5 })).toMatch(/required argument "q" is missing/);
    expect(reason({ q: 'x', filters: {} })).toMatch(/filters\.since" is required/);
  });

  it('declines an undeclared top-level name', () => {
    expect(reason({ q: 'x', keyword: 'x' })).toMatch(/"keyword" is not declared/);
  });

  it('coerces nothing: a numeric string is not an integer, a float is not an integer, a string is not a list', () => {
    expect(reason({ q: 'x', limit: '5' })).toMatch(/"limit" is string, not integer/);
    expect(reason({ q: 'x', limit: 5.5 })).toMatch(/"limit" is number, not integer/);
    expect(reason({ q: 'x', tags: 'a' })).toMatch(/"tags" is string, not array/);
    expect(valid({ q: 'x', ratio: 2 })).toBe(true); // an integer IS a number
  });

  it('checks bounds, enums, patterns and nested requirements', () => {
    expect(reason({ q: '' })).toMatch(/"q" is too short/);
    expect(reason({ q: 'x', limit: 0 })).toMatch(/below its minimum/);
    expect(reason({ q: 'x', limit: 101 })).toMatch(/above its maximum/);
    expect(reason({ q: 'x', sort: 'hot' })).toMatch(/not one of its allowed values/);
    expect(reason({ q: 'x', tags: [] })).toMatch(/too few items/);
    expect(reason({ q: 'x', tags: ['a', 2] })).toMatch(/"tags\[1\]" is integer, not string/);
    expect(reason({ q: 'x', filters: { since: '2026', extra: 1 } })).toMatch(/"filters\.extra" is not declared/);
    expect(reason({ q: 'x', nullable: 1 })).toMatch(/"nullable" is integer, not string or null/);
    expect(valid({ q: 'ab' }, { type: 'object', properties: { q: { type: 'string', pattern: '^a' } } })).toBe(true);
    expect(valid({ q: 'ba' }, { type: 'object', properties: { q: { type: 'string', pattern: '^a' } } })).toBe(false);
  });

  it('validates alternatives', () => {
    const alt = { type: 'object', properties: { id: { anyOf: [{ type: 'string' }, { type: 'integer' }] } } };
    expect(valid({ id: 'a' }, alt)).toBe(true);
    expect(valid({ id: 1 }, alt)).toBe(true);
    expect(valid({ id: true }, alt)).toBe(false);
  });

  it('an unusable or unsupported schema authorises nothing', () => {
    expect(reason({ q: 'x' }, null)).toBe('no schema');
    expect(reason({ q: 'x' }, {})).toMatch(/declares no properties/);
    expect(reason({ q: 'x' }, { type: 'array', properties: {} })).toMatch(/not an object schema/);
    expect(reason({ q: 'x' }, { type: 'object', properties: { q: { $ref: '#/defs/q' } } })).toMatch(/uses \$ref/);
    expect(reason({ q: 'x' }, { type: 'object', properties: { q: {} }, if: {} })).toMatch(/uses if/);
    expect(reason({ q: 'x' }, { type: 'object', properties: { q: { type: 'string', not: {} } } })).toMatch(/uses not/);
  });

  it('a property with an open schema admits any value', () => {
    expect(valid({ q: { anything: [1] } }, { type: 'object', properties: { q: {} } })).toBe(true);
    expect(valid({ q: 1 }, { type: 'object', properties: { q: true } })).toBe(true);
  });
});
