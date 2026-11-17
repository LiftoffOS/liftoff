// JSON Schema to Zod Converter
// SECURITY: Direct conversion — NO eval, NO new Function(), NO code string generation.
// External agent MCP tool schemas are untrusted input. This converter produces
// Zod objects directly from JSON Schema without any intermediate code representation.
//
// Handles: string, number, integer, boolean, array, object, oneOf, anyOf, nullable, enum.
// Falls back to z.record(z.string(), z.unknown()) on any unsupported feature — never crashes.

import { z, type ZodTypeAny, type ZodRawShape } from 'zod';
import { logger } from '../infrastructure/logging';

/**
 * Extracts the raw shape from a Zod schema for use with the SDK's tool() function.
 * tool() expects AnyZodRawShape (Record<string, ZodType>), not a wrapped ZodObject.
 * If the schema is a ZodObject, extracts its shape. Otherwise falls back to { input: z.unknown() }.
 */
export function extractToolShape(zodSchema: ZodTypeAny): ZodRawShape {
  // ZodObject has a .shape property containing the raw shape
  if (zodSchema && typeof zodSchema === 'object' && 'shape' in zodSchema) {
    return (zodSchema as z.ZodObject<ZodRawShape>).shape;
  }
  // Not a ZodObject — wrap as a single 'input' field
  return { input: z.unknown() };
}

const MAX_DEPTH = 10; // Prevent deeply nested schema DoS

/**
 * Converts a JSON Schema object to a Zod schema for the Claude Agent SDK's tool() helper.
 * Direct recursive conversion — no eval, no code generation.
 * Falls back to z.record(z.string(), z.unknown()) on any unsupported feature or error.
 */
export function convertJsonSchemaToZod(schema: Record<string, unknown>, depth = 0): ZodTypeAny {
  if (!schema || typeof schema !== 'object' || depth > MAX_DEPTH) {
    return z.record(z.string(), z.unknown());
  }

  try {
    return convertNode(schema, depth);
  } catch (err) {
    logger.warn(
      { err, schemaType: schema.type, schemaKeys: Object.keys(schema) },
      'JSON Schema to Zod conversion failed — falling back to z.record(z.string(), z.unknown())'
    );
    return z.record(z.string(), z.unknown());
  }
}

function convertNode(schema: Record<string, unknown>, depth: number): ZodTypeAny {
  // Handle type arrays like ['string', 'number'] → z.union([z.string(), z.number()])
  if (Array.isArray(schema.type)) {
    const types = (schema.type as string[]).filter(t => t !== 'null');
    const isNullable = (schema.type as string[]).includes('null');
    if (types.length === 0) return z.unknown();
    if (types.length === 1) {
      const result = convertNode({ ...schema, type: types[0] }, depth);
      return isNullable ? result.nullable() : result;
    }
    const variants = types.map(t => convertNode({ ...schema, type: t }, depth));
    const union = z.union(variants as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
    return isNullable ? union.nullable() : union;
  }

  const type = schema.type as string;

  // Handle nullable
  const isNullable = schema.nullable === true;

  let result: ZodTypeAny;

  switch (type) {
    case 'string': {
      let s = z.string();
      if (typeof schema.maxLength === 'number') s = s.max(schema.maxLength);
      if (typeof schema.minLength === 'number') s = s.min(schema.minLength);
      if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        return z.enum(schema.enum as [string, ...string[]]);
      }
      if (typeof schema.description === 'string') s = s.describe(schema.description);
      result = s;
      break;
    }
    case 'number':
    case 'integer': {
      let n = type === 'integer' ? z.number().int() : z.number();
      if (typeof schema.minimum === 'number') n = n.min(schema.minimum);
      if (typeof schema.maximum === 'number') n = n.max(schema.maximum);
      if (typeof schema.description === 'string') n = n.describe(schema.description);
      result = n;
      break;
    }
    case 'boolean':
      result = z.boolean();
      break;
    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined;
      const itemSchema = items ? convertNode(items, depth + 1) : z.unknown();
      let a = z.array(itemSchema);
      if (typeof schema.maxItems === 'number') a = a.max(schema.maxItems);
      if (typeof schema.minItems === 'number') a = a.min(schema.minItems);
      result = a;
      break;
    }
    case 'object':
    default: {
      // Handle oneOf/anyOf as z.union if present
      if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
        const variants = (schema.oneOf as Record<string, unknown>[]).map(s => convertNode(s, depth + 1));
        if (variants.length >= 2) return z.union(variants as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
        return variants[0] || z.unknown();
      }
      if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
        const variants = (schema.anyOf as Record<string, unknown>[]).map(s => convertNode(s, depth + 1));
        if (variants.length >= 2) return z.union(variants as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
        return variants[0] || z.unknown();
      }

      const properties = (schema.properties || {}) as Record<string, Record<string, unknown>>;
      const required = (schema.required || []) as string[];

      if (Object.keys(properties).length === 0) {
        // No properties defined — accept any object
        result = z.record(z.string(), z.unknown());
        break;
      }

      const shape: Record<string, ZodTypeAny> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        let propZod = convertNode(propSchema, depth + 1);
        if (!required.includes(key)) {
          propZod = propZod.optional();
        }
        shape[key] = propZod;
      }
      result = z.object(shape);
      break;
    }
  }

  return isNullable ? result.nullable() : result;
}
