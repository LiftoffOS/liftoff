// Whether a set of arguments fits a candidate's COMPLETE input schema, as is.
//
// The execution chain may run another candidate automatically — without the
// model choosing it — only when the arguments the model wrote for the first
// one are, unchanged, a valid input for the second. Not coerced ("5" is not
// an integer), not defaulted (a required field the schema would fill in is
// still missing), and with every supplied top-level name declared by the
// schema, because an argument the candidate does not list is an argument it
// will silently ignore, and a search that ignores its search term searches
// for nothing. The display hint (args-hint.ts) is a truncated summary and
// cannot answer any of this; only the full document can.
//
// Deliberately strict in the other direction too: a schema this validator
// does not understand — a `$ref`, a `not`, a dialect it has not met — is
// "unvalidated", and an unvalidated schema never authorises a run. Wrong here
// costs one handoff to the model; wrong the other way runs a paid source on
// arguments that do not fit it.

export type ArgsValidation = { valid: true } | { valid: false; reason: string };

interface Schema {
  type?: string | string[];
  properties?: Record<string, unknown>;
  required?: unknown;
  items?: unknown;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  additionalProperties?: unknown;
  anyOf?: unknown[];
  oneOf?: unknown[];
  allOf?: unknown[];
  nullable?: boolean;
  [key: string]: unknown;
}

const UNSUPPORTED_KEYWORDS = ['$ref', 'not', 'if', 'then', 'else', 'dependentSchemas', 'dependentRequired', 'patternProperties', 'propertyNames', 'unevaluatedProperties', 'contains', 'prefixItems'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The arguments as a whole against the top-level object schema. Every
 *  supplied top-level name must be declared; every required name must be
 *  present; every supplied value must validate. */
export function validateArgsAgainstSchema(args: Record<string, unknown>, schema: unknown): ArgsValidation {
  if (!isPlainObject(schema)) return { valid: false, reason: 'no schema' };
  const top = schema as Schema;
  const properties = top.properties;
  if (!isPlainObject(properties)) return { valid: false, reason: 'schema declares no properties' };
  if (top.type !== undefined && top.type !== 'object' && !(Array.isArray(top.type) && top.type.includes('object'))) {
    return { valid: false, reason: 'schema is not an object schema' };
  }
  const unsupported = UNSUPPORTED_KEYWORDS.find((k) => k in top);
  if (unsupported) return { valid: false, reason: `schema uses ${unsupported}, which is not validated here` };

  for (const name of Object.keys(args)) {
    if (args[name] === undefined) continue;
    if (!(name in properties)) return { valid: false, reason: `argument "${name}" is not declared` };
  }
  const required = Array.isArray(top.required) ? top.required.filter((r): r is string => typeof r === 'string') : [];
  for (const name of required) {
    if (args[name] === undefined) return { valid: false, reason: `required argument "${name}" is missing` };
  }
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const verdict = validateValue(value, properties[name], name, 0);
    if (!verdict.valid) return verdict;
  }
  return { valid: true };
}

const MAX_DEPTH = 16;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(declared: string, actual: string): boolean {
  if (declared === actual) return true;
  if (declared === 'number' && actual === 'integer') return true;
  return false;
}

function validateValue(value: unknown, schema: unknown, path: string, depth: number): ArgsValidation {
  if (schema === true || (isPlainObject(schema) && Object.keys(schema).length === 0)) return { valid: true };
  if (schema === false) return { valid: false, reason: `"${path}" admits no value` };
  if (!isPlainObject(schema)) return { valid: false, reason: `"${path}" has no usable schema` };
  if (depth > MAX_DEPTH) return { valid: false, reason: `"${path}" is nested too deep to validate` };
  const s = schema as Schema;
  const unsupported = UNSUPPORTED_KEYWORDS.find((k) => k in s);
  if (unsupported) return { valid: false, reason: `"${path}" uses ${unsupported}, which is not validated here` };

  if (Array.isArray(s.allOf)) {
    for (const branch of s.allOf) {
      const v = validateValue(value, branch, path, depth + 1);
      if (!v.valid) return v;
    }
  }
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const branches = (s.anyOf ?? s.oneOf) as unknown[];
    const fits = branches.filter((b) => validateValue(value, b, path, depth + 1).valid);
    if (fits.length === 0) return { valid: false, reason: `"${path}" fits none of its alternatives` };
    if (Array.isArray(s.oneOf) && fits.length > 1) return { valid: false, reason: `"${path}" fits more than one alternative` };
  }

  const actual = typeOf(value);
  if (s.type !== undefined) {
    const declared = Array.isArray(s.type) ? s.type : [s.type];
    const allowed = s.nullable === true ? [...declared, 'null'] : declared;
    if (!allowed.some((t) => typeof t === 'string' && typeMatches(t, actual))) {
      return { valid: false, reason: `"${path}" is ${actual}, not ${allowed.join(' or ')}` };
    }
  } else if (value === null && s.nullable !== true && !Array.isArray(s.enum) && s.const === undefined) {
    return { valid: false, reason: `"${path}" is null` };
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => sameJson(e, value))) {
    return { valid: false, reason: `"${path}" is not one of its allowed values` };
  }
  if (s.const !== undefined && !sameJson(s.const, value)) {
    return { valid: false, reason: `"${path}" is not its required value` };
  }

  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) return { valid: false, reason: `"${path}" is too short` };
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) return { valid: false, reason: `"${path}" is too long` };
    if (typeof s.pattern === 'string') {
      try {
        if (!new RegExp(s.pattern).test(value)) return { valid: false, reason: `"${path}" does not match its pattern` };
      } catch {
        return { valid: false, reason: `"${path}" has a pattern this validator cannot read` };
      }
    }
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) return { valid: false, reason: `"${path}" is below its minimum` };
    if (typeof s.maximum === 'number' && value > s.maximum) return { valid: false, reason: `"${path}" is above its maximum` };
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) return { valid: false, reason: `"${path}" is at or below its minimum` };
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) return { valid: false, reason: `"${path}" is at or above its maximum` };
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) return { valid: false, reason: `"${path}" has too few items` };
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) return { valid: false, reason: `"${path}" has too many items` };
    if (s.items !== undefined) {
      if (Array.isArray(s.items)) return { valid: false, reason: `"${path}" uses tuple items, which are not validated here` };
      for (let i = 0; i < value.length; i++) {
        const v = validateValue(value[i], s.items, `${path}[${i}]`, depth + 1);
        if (!v.valid) return v;
      }
    }
  }
  if (isPlainObject(value)) {
    const props = isPlainObject(s.properties) ? s.properties : {};
    const required = Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === 'string') : [];
    for (const name of required) {
      if (value[name] === undefined) return { valid: false, reason: `"${path}.${name}" is required and missing` };
    }
    for (const [name, field] of Object.entries(value)) {
      if (field === undefined) continue;
      if (name in props) {
        const v = validateValue(field, props[name], `${path}.${name}`, depth + 1);
        if (!v.valid) return v;
      } else if (s.additionalProperties === false) {
        return { valid: false, reason: `"${path}.${name}" is not declared` };
      } else if (isPlainObject(s.additionalProperties)) {
        const v = validateValue(field, s.additionalProperties, `${path}.${name}`, depth + 1);
        if (!v.valid) return v;
      }
    }
  }
  return { valid: true };
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
