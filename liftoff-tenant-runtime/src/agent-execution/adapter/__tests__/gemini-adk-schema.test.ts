// Unit tests for JSON-Schema → Vertex/genai Schema conversion.
import { Type } from '@google/genai';
import { toGenaiSchema, toGenaiParameters } from '../gemini-adk/schema';

describe('toGenaiSchema', () => {
  it('uppercases types and recurses into properties/items/required (memory_save shape)', () => {
    const out = toGenaiSchema({
      type: 'object',
      properties: {
        content: { type: 'string', description: 'text' },
        layer: { type: 'string', enum: ['global', 'individual'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['content', 'layer'],
    });
    expect(out.type).toBe(Type.OBJECT);
    expect(out.properties?.content.type).toBe(Type.STRING);
    expect(out.properties?.layer.type).toBe(Type.STRING);
    expect(out.properties?.layer.enum).toEqual(['global', 'individual']);
    expect(out.properties?.layer.format).toBe('enum');
    expect(out.properties?.tags.type).toBe(Type.ARRAY);
    expect(out.properties?.tags.items?.type).toBe(Type.STRING);
    expect(out.required).toEqual(['content', 'layer']);
  });

  it('drops unsupported keywords (additionalProperties, $schema)', () => {
    const out = toGenaiSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'integer' } },
    }) as Record<string, unknown>;
    expect(out.additionalProperties).toBeUndefined();
    expect(out.$schema).toBeUndefined();
    expect((out.properties as Record<string, { type: Type }>).a.type).toBe(Type.INTEGER);
  });

  it('handles nullable union types and integer bounds as strings', () => {
    const out = toGenaiSchema({ type: ['string', 'null'], minLength: 1, maxLength: 5 });
    expect(out.type).toBe(Type.STRING);
    expect(out.nullable).toBe(true);
    expect(out.minLength).toBe('1');
    expect(out.maxLength).toBe('5');
  });
});

describe('toGenaiParameters', () => {
  it('coerces a non-object / empty schema into an OBJECT parameters schema', () => {
    expect(toGenaiParameters(undefined).type).toBe(Type.OBJECT);
    expect(toGenaiParameters({}).type).toBe(Type.OBJECT);
    expect(toGenaiParameters({ type: 'string' }).type).toBe(Type.OBJECT);
    expect(toGenaiParameters({ type: 'object', properties: { a: { type: 'string' } } }).properties?.a.type).toBe(Type.STRING);
  });
});
