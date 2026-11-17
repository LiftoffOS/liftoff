/* eslint-disable @typescript-eslint/no-explicit-any */
// Support for B (outgoing contract validation): resolve OpenAPI $refs, build a
// minimal valid request body, and compile an ajv validator for an operation's
// requestBody — used to assert the bytes our clients actually send conform to the
// vendor's own contract. (ajv v6 / draft-07 — matches the version this service
// already vendors in src/contract-tests.)

import Ajv, { ValidateFunction } from 'ajv';

type J = Record<string, any>;

/** Resolve a single #/components/<section>/<name> $ref. */
export function deref(obj: J | undefined, spec: J): J | undefined {
  const ref = obj?.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/components/')) {
    const [, , section, name] = ref.split('/');
    return spec.components?.[section]?.[name] ?? obj;
  }
  return obj;
}

/** The application/json (or first) requestBody schema for an operation, deref'd. */
export function requestBodySchema(op: J, spec: J): J | undefined {
  const rb = deref(op.requestBody, spec);
  if (!rb) return undefined;
  const content = rb.content ?? {};
  const media = content['application/json'] ?? content['application/xml'] ?? Object.values<J>(content)[0];
  return media?.schema;
}

// Rewrite #/components/schemas/* → #/$defs/* so a schema is self-contained for ajv.
function standalone(schema: J, spec: J): J {
  const defs = spec.components?.schemas ?? {};
  return JSON.parse(JSON.stringify({ ...schema, $defs: defs }).split('#/components/schemas/').join('#/$defs/'));
}

export function compileValidator(schema: J, spec: J): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, unknownFormats: 'ignore', logger: false });
  return ajv.compile(standalone(schema, spec));
}

/** Minimal valid instance of an OpenAPI schema (required fields only, cycle/depth-safe). */
export function sample(schema: J | undefined, spec: J, depth = 0, seen: Set<string> = new Set()): unknown {
  if (!schema || depth > 6) return {};
  if (schema.$ref) {
    const name = String(schema.$ref).split('/').pop()!;
    if (seen.has(name)) return {};
    return sample(deref(schema, spec), spec, depth + 1, new Set(seen).add(name));
  }
  if (Array.isArray(schema.allOf)) {
    const o: J = {};
    for (const s of schema.allOf) Object.assign(o as object, sample(s, spec, depth + 1, seen) as object);
    for (const r of schema.required ?? []) o[r] = sample(schema.properties?.[r] ?? { type: 'string' }, spec, depth + 1, seen);
    return o;
  }
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.find((e: unknown) => e !== null) ?? schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t && t !== 'null') : schema.type;
  if (type === 'object' || schema.properties) {
    const o: J = {};
    for (const r of schema.required ?? []) o[r] = sample(schema.properties?.[r] ?? { type: 'string' }, spec, depth + 1, seen);
    return o;
  }
  if (type === 'array') return schema.minItems ? [sample(schema.items, spec, depth + 1, seen)] : [];
  if (type === 'integer' || type === 'number') return 1;
  if (type === 'boolean') return true;
  if (schema.format === 'date') return '2026-01-01';
  if (schema.format === 'date-time') return '2026-01-01T00:00:00Z';
  return 'x';
}
