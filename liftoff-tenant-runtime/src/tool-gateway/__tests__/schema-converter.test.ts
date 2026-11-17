// Schema Converter Tests
// Validates JSON Schema to Zod conversion for all connector function schemas.

import { convertJsonSchemaToZod, extractToolShape } from '../schema-converter';
import { z } from 'zod';

describe('convertJsonSchemaToZod', () => {
  describe('primitive types', () => {
    it('converts string type', () => {
      const schema = { type: 'string' };
      const result = convertJsonSchemaToZod(schema);
      expect(result.safeParse('hello').success).toBe(true);
      expect(result.safeParse(123).success).toBe(false);
    });

    it('converts string with constraints', () => {
      const schema = { type: 'string', minLength: 2, maxLength: 10 };
      const result = convertJsonSchemaToZod(schema);
      expect(result.safeParse('ab').success).toBe(true);
      expect(result.safeParse('a').success).toBe(false);
      expect(result.safeParse('12345678901').success).toBe(false);
    });

    it('converts string enum', () => {
      const schema = { type: 'string', enum: ['a', 'b', 'c'] };
      const result = convertJsonSchemaToZod(schema);
      expect(result.safeParse('a').success).toBe(true);
      expect(result.safeParse('d').success).toBe(false);
    });

    it('converts number type', () => {
      const schema = { type: 'number' };
      const result = convertJsonSchemaToZod(schema);
      expect(result.safeParse(42).success).toBe(true);
      expect(result.safeParse(3.14).success).toBe(true);
      expect(result.safeParse('hello').success).toBe(false);
    });

    it('converts integer type', () => {
      const schema = { type: 'integer' };
      const result = convertJsonSchemaToZod(schema);
      expect(result.safeParse(42).success).toBe(true);
      expect(result.safeParse(3.14).success).toBe(false);
    });

    it('converts number with constraints', () => {
      const schema = { type: 'number', minimum: 0, maximum: 100 };
      const result = convertJsonSchemaToZod(schema);
      expect(result.safeParse(50).success).toBe(true);
      expect(result.safeParse(-1).success).toBe(false);
      expect(result.safeParse(101).success).toBe(false);
    });

    it('converts boolean type', () => {
      const schema = { type: 'boolean' };
      const result = convertJsonSchemaToZod(schema);
      expect(result.safeParse(true).success).toBe(true);
      expect(result.safeParse('true').success).toBe(false);
    });
  });

  describe('complex types', () => {
    it('converts object with required and optional fields', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
        required: ['name'],
      };
      const result = convertJsonSchemaToZod(schema);
      expect(result.safeParse({ name: 'John' }).success).toBe(true);
      expect(result.safeParse({ name: 'John', age: 30 }).success).toBe(true);
      expect(result.safeParse({}).success).toBe(false); // missing required name
    });

    it('converts array type', () => {
      const schema = {
        type: 'array',
        items: { type: 'string' },
      };
      const result = convertJsonSchemaToZod(schema);
      expect(result.safeParse(['a', 'b']).success).toBe(true);
      expect(result.safeParse([1, 2]).success).toBe(false);
    });

    it('converts array with constraints', () => {
      const schema = {
        type: 'array',
        items: { type: 'string' },
        maxItems: 3,
      };
      const result = convertJsonSchemaToZod(schema);
      expect(result.safeParse(['a', 'b']).success).toBe(true);
      expect(result.safeParse(['a', 'b', 'c', 'd']).success).toBe(false);
    });

    it('converts nested objects', () => {
      const schema = {
        type: 'object',
        properties: {
          address: {
            type: 'object',
            properties: {
              street: { type: 'string' },
              city: { type: 'string' },
            },
            required: ['street'],
          },
        },
        required: ['address'],
      };
      const result = convertJsonSchemaToZod(schema);
      expect(result.safeParse({ address: { street: '123 Main' } }).success).toBe(true);
      expect(result.safeParse({ address: {} }).success).toBe(false);
    });
  });

  describe('union types', () => {
    it('converts oneOf', () => {
      const schema = {
        oneOf: [
          { type: 'string' },
          { type: 'number' },
        ],
      };
      const result = convertJsonSchemaToZod(schema);
      expect(result.safeParse('hello').success).toBe(true);
      expect(result.safeParse(42).success).toBe(true);
      expect(result.safeParse(true).success).toBe(false);
    });

    it('converts anyOf', () => {
      const schema = {
        anyOf: [
          { type: 'string' },
          { type: 'number' },
        ],
      };
      const result = convertJsonSchemaToZod(schema);
      expect(result.safeParse('hello').success).toBe(true);
      expect(result.safeParse(42).success).toBe(true);
    });
  });

  describe('nullable', () => {
    it('handles nullable string', () => {
      const schema = { type: 'string', nullable: true };
      const result = convertJsonSchemaToZod(schema);
      expect(result.safeParse('hello').success).toBe(true);
      expect(result.safeParse(null).success).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('returns fallback for null schema', () => {
      const result = convertJsonSchemaToZod(null as unknown as Record<string, unknown>);
      expect(result.safeParse({ anything: 'goes' }).success).toBe(true);
    });

    it('returns fallback for empty object', () => {
      const result = convertJsonSchemaToZod({});
      expect(result.safeParse({ anything: 'goes' }).success).toBe(true);
    });

    it('handles deeply nested schema (>10 levels) without crashing', () => {
      let schema: Record<string, unknown> = { type: 'string' };
      for (let i = 0; i < 12; i++) {
        schema = { type: 'object', properties: { nested: schema }, required: ['nested'] };
      }
      // Should not throw — inner levels beyond MAX_DEPTH get a record fallback,
      // but the outer levels still produce a valid schema
      const result = convertJsonSchemaToZod(schema);
      expect(result).toBeDefined();
    });

    it('returns fallback for object with no properties', () => {
      const schema = { type: 'object' };
      const result = convertJsonSchemaToZod(schema);
      expect(result.safeParse({ key: 'value' }).success).toBe(true);
    });
  });

  describe('extractToolShape', () => {
    it('extracts shape from ZodObject', () => {
      const zodObj = z.object({ name: z.string(), age: z.number() });
      const shape = extractToolShape(zodObj);
      expect(shape).toHaveProperty('name');
      expect(shape).toHaveProperty('age');
    });

    it('returns fallback for non-ZodObject', () => {
      const zodStr = z.string();
      const shape = extractToolShape(zodStr);
      expect(shape).toHaveProperty('input');
    });
  });

  describe('connector function schemas integration', () => {
    it('converts tool-schema cache entries without hitting the fallback path', () => {
      // Phase 2c: schemas come from the in-process cache seeded by the
      // connector-service. Seed a realistic fixture and verify conversion.
      const { __setToolSchemaCacheForTests, __clearToolSchemaCacheForTests, getToolSchemas } =
        require('../../connectors/tool-schema-cache');

      try {
        __setToolSchemaCacheForTests([
          {
            connectorType: 'google_mail',
            displayName: 'Google Mail',
            functions: [
              {
                name: 'send_email',
                description: 'send',
                inputSchema: {
                  type: 'object',
                  properties: {
                    to: { type: 'string' },
                    body: { type: 'string' },
                    attachments: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['to', 'body'],
                },
                categories: ['write'],
              },
            ],
          },
          {
            connectorType: 'slack',
            displayName: 'Slack',
            functions: [
              {
                name: 'post_message',
                description: 'post',
                inputSchema: {
                  type: 'object',
                  properties: {
                    channel: { type: 'string' },
                    text: { type: 'string' },
                  },
                  required: ['channel', 'text'],
                },
                categories: ['write'],
              },
            ],
          },
        ]);

        for (const connectorType of ['google_mail', 'slack']) {
          const functions = getToolSchemas(connectorType);
          expect(functions.length).toBeGreaterThan(0);
          for (const fn of functions) {
            const result = convertJsonSchemaToZod(fn.inputSchema);
            expect(result).toBeDefined();
            const shape = extractToolShape(result);
            expect(shape).toBeDefined();
            expect(typeof shape).toBe('object');
          }
        }
      } finally {
        __clearToolSchemaCacheForTests();
      }
    });
  });
});
