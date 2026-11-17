// Shared helpers for the Zod-derived normalizer schemas.
//
// Each connector normalizer defines a Zod schema per entity type, uses it at
// runtime to validate the data record it emits, and exposes the corresponding
// JSON Schema via entitySchemas for the catalog endpoint. These helpers
// centralize the Zod → JSON Schema conversion so every normalizer uses the
// same options (target='jsonSchema7') and so a single change here propagates
// to every connector.

import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { JSONSchema7 } from 'json-schema';

export function toJsonSchema(schema: z.ZodTypeAny): JSONSchema7 {
  return zodToJsonSchema(schema, { target: 'jsonSchema7' }) as JSONSchema7;
}

export function buildEntitySchemas<K extends string>(
  schemas: Record<K, z.ZodTypeAny>,
): Record<K, JSONSchema7> {
  const out = {} as Record<K, JSONSchema7>;
  for (const [name, schema] of Object.entries(schemas) as [K, z.ZodTypeAny][]) {
    out[name] = toJsonSchema(schema);
  }
  return out;
}
