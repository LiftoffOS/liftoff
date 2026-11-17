// JSON-Schema → Vertex/genai Schema conversion for ADK function declarations.
//
// Anthropic and OpenAI accept raw JSON-Schema tool inputSchemas, but Vertex's
// function-calling wants its own Schema shape: an UPPERCASE `Type` enum
// (OBJECT, not "object"), a whitelisted field set, and integer bounds encoded
// as strings. Passing raw JSON-Schema (the old `as Schema` cast) makes Vertex
// reject the declaration with:
//   Unable to submit request because `<tool>` functionDeclaration parameters
//   schema should be of type OBJECT
// This normalizes recursively and drops keywords Vertex does not accept
// (additionalProperties, $schema, $ref, oneOf, allOf, patternProperties, ...).

import { Type, type Schema } from '@google/genai';

const TYPE_MAP: Record<string, Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
  object: Type.OBJECT,
};

const intBound = (v: unknown): string | undefined => (typeof v === 'number' ? String(v) : undefined);

/** Convert one JSON-Schema node into a Vertex/genai Schema node. */
export function toGenaiSchema(input: unknown): Schema {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    // Vertex needs a typed schema; default unknown nodes to an open object.
    return { type: Type.OBJECT };
  }
  const js = input as Record<string, unknown>;
  const out: Schema = {};

  // `type` may be a string or a nullable union like ['string','null'].
  let rawType = js.type as string | string[] | undefined;
  if (Array.isArray(rawType)) {
    if (rawType.includes('null')) out.nullable = true;
    rawType = rawType.find((t) => t !== 'null');
  }
  if (typeof rawType === 'string' && TYPE_MAP[rawType]) out.type = TYPE_MAP[rawType];
  if (js.nullable === true) out.nullable = true;

  if (typeof js.description === 'string') out.description = js.description;
  if (typeof js.title === 'string') out.title = js.title;
  if (typeof js.format === 'string') out.format = js.format;
  if (typeof js.pattern === 'string') out.pattern = js.pattern;
  if (js.default !== undefined) out.default = js.default;
  if (typeof js.minimum === 'number') out.minimum = js.minimum;
  if (typeof js.maximum === 'number') out.maximum = js.maximum;
  if (intBound(js.minItems)) out.minItems = intBound(js.minItems);
  if (intBound(js.maxItems)) out.maxItems = intBound(js.maxItems);
  if (intBound(js.minLength)) out.minLength = intBound(js.minLength);
  if (intBound(js.maxLength)) out.maxLength = intBound(js.maxLength);

  if (Array.isArray(js.enum)) {
    out.enum = js.enum.map(String);
    out.format = 'enum';
    if (!out.type) out.type = Type.STRING;
  }

  if (js.properties && typeof js.properties === 'object') {
    const props: Record<string, Schema> = {};
    for (const [k, v] of Object.entries(js.properties as Record<string, unknown>)) {
      props[k] = toGenaiSchema(v);
    }
    out.properties = props;
    if (!out.type) out.type = Type.OBJECT;
  }
  if (Array.isArray(js.required)) out.required = (js.required as unknown[]).map(String);

  if (js.items) {
    out.items = toGenaiSchema(js.items);
    if (!out.type) out.type = Type.ARRAY;
  }

  if (Array.isArray(js.anyOf)) out.anyOf = (js.anyOf as unknown[]).map((s) => toGenaiSchema(s));

  return out;
}

/**
 * Top-level function `parameters` MUST be an OBJECT schema for Vertex. Coerce
 * any non-object (or empty) schema into a valid empty-object parameters schema.
 */
export function toGenaiParameters(input: unknown): Schema {
  const schema = toGenaiSchema(input);
  if (schema.type !== Type.OBJECT) {
    return { type: Type.OBJECT, properties: schema.properties ?? {} };
  }
  if (!schema.properties) schema.properties = {};
  return schema;
}
