// Do the authored arguments satisfy the tool's schema? Asked of the schema
// itself, rather than of a reimplementation of it.
//
// This started as a presence check, gained a type check, then gained a rule
// about literals inside templates. Each addition was prompted by a redistill
// that shipped a call the previous version had passed: a missing `target`, then
// `target` as a string, then the same string moved into a template. Three
// rounds of "the check did not catch this" is not bad luck, it is what
// reimplementing a validator looks like from the inside, and the pieces still
// missing were nested shape, enums and formats.
//
// `ajv` is already a dependency here and already validates schemas in two other
// modules, so the schema is handed to it whole and it answers in one pass.
//
// ONE DELIBERATE EXEMPTION, and it is the reason this is not a bare ajv call. A
// value holding `{{steps.s1.x}}` is a placeholder the runtime substitutes, so
// its type at authoring time is the string the template happens to be written
// in and says nothing about what arrives. Judging those would refuse the
// correct authoring of every templated step. Every other value is judged,
// including a literal that happens to sit inside a template — which is exactly
// where the third wrong value appeared once the literal form was closed.

import Ajv, { type ErrorObject } from 'ajv';

/** Shared, because compiling per call is the expensive part and these schemas
 *  are small and reused. `strict: false` because connector schemas are authored
 *  by vendors and routinely omit things ajv's strict mode objects to; refusing
 *  to validate a real schema for being untidy would switch the check off for
 *  the tools that have one. */
const ajv = new Ajv({ allErrors: true, strict: false });

const PLACEHOLDER = /\{\{[^}]*\}\}/;

export interface ToolArgProblem {
  /** JSON pointer into the arguments, `''` for the object itself. */
  path: string;
  message: string;
}

/**
 * Replace every placeholder-bearing value with null and report where they were.
 *
 * Null rather than removal: a required argument written as `"{{input.id}}"` IS
 * supplied, and removing it would report it missing. It is present and its type
 * is unknowable, which is precisely the pair `null` plus an exempt path says.
 */
function neutralisePlaceholders(
  value: unknown,
  path: string,
  exempt: string[],
): unknown {
  if (typeof value === 'string') {
    if (PLACEHOLDER.test(value)) {
      exempt.push(path);
      return null;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => neutralisePlaceholders(v, `${path}/${i}`, exempt));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // JSON pointer escaping, so a key containing '/' or '~' cannot be
      // confused with a path separator when errors are matched back.
      const key = k.replace(/~/g, '~0').replace(/\//g, '~1');
      out[k] = neutralisePlaceholders(v, `${path}/${key}`, exempt);
    }
    return out;
  }
  return value;
}

/** An error under an exempt path is an error about a placeholder. */
function isExempt(err: ErrorObject, exempt: string[]): boolean {
  return exempt.some((p) => err.instancePath === p || err.instancePath.startsWith(`${p}/`));
}

/**
 * Validate a step's authored arguments against the tool's own JSON Schema.
 *
 * `args` is the literal `toolInput` object or the parsed `toolInputTemplate`.
 * Returns [] when there is nothing to say — including when the tool has no
 * schema recorded, because a check that guesses is worse than one that is
 * silent.
 *
 * `additionalProperties: false` is imposed at the top level whatever the schema
 * says. An argument the tool does not define is silently ignored at dispatch,
 * which is how `{"id": …}` looked reasonable while addressing nothing.
 */
/** Which character offsets sit inside a JSON string literal.
 *
 *  Needed because one template mixes both placeholder forms:
 *  `{"path": "{{item.path}}", "line": {{item.line}}}` has one inside a string
 *  and one bare in a value position. Substituting uniformly cannot parse that
 *  either way — leave the bare one unquoted and the document is invalid, quote
 *  them all and the in-string one becomes `""{{P}}""`. Templated connector
 *  steps of that shape would otherwise be skipped in silence, which is the safe
 *  direction and still blind.
 *
 *  Escapes are honoured so a `\"` inside a string does not read as its end. */
export function jsonStringOffsets(template: string): boolean[] {
  const inside = new Array<boolean>(template.length).fill(false);
  let open = false;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === '\\') {
      inside[i] = open;
      if (i + 1 < template.length) inside[i + 1] = open;
      i++;
      continue;
    }
    if (ch === '"') {
      // The quote belongs to the boundary, not the interior.
      inside[i] = false;
      open = !open;
      continue;
    }
    inside[i] = open;
  }
  return inside;
}

/**
 * Parse a step's authored arguments, keeping every placeholder visible.
 *
 * A literal object is returned as-is. A template is rendered with each `{{…}}`
 * replaced by `{{P}}` where it already sits inside a string and by `"{{P}}"`
 * where it does not, so the document parses and every placeholder survives for
 * `validateToolArgs` to exempt. Undefined when it cannot be parsed at all —
 * malformed JSON is reported by the template check and is not doubled here.
 */
export function parseAuthoredArgs(argSource: string | Record<string, unknown>): unknown {
  if (typeof argSource !== 'string') return argSource;
  const inStr = jsonStringOffsets(argSource);
  const rendered = argSource.replace(
    /\{\{[^}]*\}\}/g,
    (_m: string, offset: number) => (inStr[offset] ? '{{P}}' : '"{{P}}"'),
  );
  try {
    return JSON.parse(rendered) as unknown;
  } catch {
    return undefined;
  }
}

// ── Lossless coercion of authored arguments ──────────────────────────────
//
// `parseAuthoredArgs` above is fit for VALIDATION and unfit for REPAIR: it
// collapses every placeholder to the same `{{P}}`, keeps no offsets, and would
// hand a bare `{{steps.s1.total}}` back as a quoted string. So a type mismatch
// the schema states plainly — `post_at` authored as a number where the tool
// declares a string — was a `tool_input_mismatch` and a full regeneration of
// the artifact, when the value was right and only its type was wrong.
//
// The three functions below let the template be edited as data and written
// back with every placeholder byte-identical:
//
//   tokenizeTemplate   each `{{…}}` becomes a unique printable sentinel,
//                      quoted where the placeholder sat bare, in place where it
//                      sat inside a string, so the document parses
//   coerceToolArgs     value-preserving type changes only, driven by the
//                      schema's declared `type` at each path; never touches a
//                      sentinel or a string that carries a placeholder
//   restoreTemplate    re-serialises and puts every placeholder back exactly
//                      as it was written
//
// The sentinel is printable ASCII on purpose. JSON.parse rejects a raw control
// character and JSON.stringify re-escapes one, so a U+0001 marker could not
// survive the round trip; `__LIFTOFF_PH_n__` is legal inside a JSON string
// as-is and survives parse/stringify byte-for-byte. The trailing `__` is what
// keeps `_1__` from matching inside `_10__`.

/** Prefix of the per-placeholder sentinel. A template that already contains
 *  it cannot be tokenised unambiguously and is left untouched. */
export const PLACEHOLDER_SENTINEL_PREFIX = '__LIFTOFF_PH_';

export interface TemplateToken {
  /** Ordinal of the placeholder in the template, 0-based. */
  n: number;
  /** The placeholder exactly as authored, braces included. */
  original: string;
  /** Whether it sat outside a JSON string (a bare value) or inside one. */
  bare: boolean;
}

export interface ArgCoercion {
  /** JSON pointer of the value that was coerced. */
  path: string;
  /** The JSON type it was authored as. */
  from: string;
  /** The JSON type the schema declares, which it now is. */
  to: string;
}

const PLACEHOLDER_GLOBAL = /\{\{[^}]*\}\}/g;

function sentinelFor(n: number): string {
  return `${PLACEHOLDER_SENTINEL_PREFIX}${n}__`;
}

/**
 * Replace each placeholder with a unique sentinel and remember how it was
 * written. Returns undefined — and the caller leaves the template untouched —
 * when the template already contains the sentinel prefix or does not parse
 * once substituted; malformed JSON is the template check's finding.
 */
export function tokenizeTemplate(
  template: string,
): { json: string; tokens: TemplateToken[] } | undefined {
  if (template.includes(PLACEHOLDER_SENTINEL_PREFIX)) return undefined;
  const inStr = jsonStringOffsets(template);
  const tokens: TemplateToken[] = [];
  const json = template.replace(PLACEHOLDER_GLOBAL, (match: string, offset: number) => {
    const n = tokens.length;
    const bare = !inStr[offset];
    tokens.push({ n, original: match, bare });
    return bare ? `"${sentinelFor(n)}"` : sentinelFor(n);
  });
  try {
    JSON.parse(json);
  } catch {
    return undefined;
  }
  return { json, tokens };
}

/** A string that is, or carries, a placeholder: its type is unknowable at
 *  authoring time and it is never coerced. */
function carriesPlaceholder(value: string): boolean {
  return value.includes(PLACEHOLDER_SENTINEL_PREFIX) || value.includes('{{');
}

const NUMERIC_STRING = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

type SchemaNode = {
  type?: unknown;
  properties?: Record<string, unknown>;
  items?: unknown;
};

function declaredType(schema: SchemaNode): string | undefined {
  // Only a single declared type drives a coercion. A union (`['string',
  // 'null']`) says the author accepts more than one shape, and choosing one
  // for them would be a judgment, not a repair.
  return typeof schema.type === 'string' ? schema.type : undefined;
}

function coerceValue(
  schema: SchemaNode | undefined,
  value: unknown,
  path: string,
  coercions: ArgCoercion[],
): unknown {
  if (!schema || typeof schema !== 'object') return value;
  const want = declaredType(schema);

  // Strings holding a placeholder (or its sentinel) are left exactly as they
  // are, whatever the schema says.
  if (typeof value === 'string' && carriesPlaceholder(value)) return value;

  let out: unknown = value;
  if (want === 'string' && typeof value === 'number' && Number.isFinite(value)) {
    out = String(value);
    coercions.push({ path, from: 'number', to: 'string' });
  } else if ((want === 'number' || want === 'integer') && typeof value === 'string'
    && NUMERIC_STRING.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && (want === 'number' || Number.isInteger(parsed))) {
      out = parsed;
      coercions.push({ path, from: 'string', to: want });
    }
  } else if (want === 'boolean' && (value === 'true' || value === 'false')) {
    out = value === 'true';
    coercions.push({ path, from: 'string', to: 'boolean' });
  } else if (want === 'array' && value !== null && value !== undefined
    && typeof value !== 'object') {
    out = [value];
    coercions.push({ path, from: typeof value, to: 'array' });
  }

  // Recurse into the shape the schema describes. Keys the schema does not
  // define are carried as they are: dropping one is the validator's finding.
  if (Array.isArray(out)) {
    const items = (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items))
      ? (schema.items as SchemaNode)
      : undefined;
    if (!items) return out;
    return out.map((v, i) => coerceValue(items, v, `${path}/${i}`, coercions));
  }
  if (out !== null && typeof out === 'object' && schema.properties) {
    const props = schema.properties;
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out as Record<string, unknown>)) {
      const key = k.replace(/~/g, '~0').replace(/\//g, '~1');
      const sub = props[k];
      copy[k] = sub && typeof sub === 'object'
        ? coerceValue(sub as SchemaNode, v, `${path}/${key}`, coercions)
        : v;
    }
    return copy;
  }
  return out;
}

/**
 * Coerce value-preserving type mismatches against the schema.
 *
 * By the declared `type` at each path: number → string for `string`; a
 * numeric string → number for `number` / `integer`; `'true'` / `'false'` →
 * boolean for `boolean`; a scalar → `[scalar]` for `array`. Nothing else: no
 * key is dropped, no enum value is substituted, no missing value is invented —
 * those are judgments, and the retry loop is where judgments are made. A
 * string carrying `{{` or the sentinel prefix is never touched.
 *
 * Returns a copy; the input is not mutated.
 */
export function coerceToolArgs(
  inputSchema: unknown,
  args: unknown,
): { args: unknown; coercions: ArgCoercion[] } {
  const coercions: ArgCoercion[] = [];
  const schema = inputSchema as SchemaNode | undefined;
  if (!schema || typeof schema !== 'object' || !schema.properties) return { args, coercions };
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { args, coercions };
  return { args: coerceValue(schema, args, '', coercions), coercions };
}

/**
 * Re-serialise coerced arguments and put every placeholder back exactly as it
 * was written. A bare token was quoted at tokenise time and an in-string token
 * was not, so the quoted form is replaced first (with the bare original) and
 * whatever remains is in-string; the two cannot collide. Undefined when a
 * token's sentinel is no longer present, which means the coercion lost a
 * placeholder and its result must not be used.
 */
export function restoreTemplate(coerced: unknown, tokens: TemplateToken[]): string | undefined {
  let out = JSON.stringify(coerced);
  if (typeof out !== 'string') return undefined;
  for (const token of tokens) {
    const sentinel = sentinelFor(token.n);
    const quoted = `"${sentinel}"`;
    if (token.bare) {
      if (!out.includes(quoted)) return undefined;
      out = out.split(quoted).join(token.original);
    }
    if (out.includes(sentinel)) {
      out = out.split(sentinel).join(token.original);
    } else if (!token.bare) {
      return undefined;
    }
  }
  if (out.includes(PLACEHOLDER_SENTINEL_PREFIX)) return undefined;
  return out;
}

export function validateToolArgs(
  inputSchema: unknown,
  args: unknown,
): ToolArgProblem[] {
  const schema = inputSchema as { properties?: Record<string, unknown> } | undefined;
  if (!schema?.properties) return [];
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return [];

  const exempt: string[] = [];
  const neutral = neutralisePlaceholders(args, '', exempt);

  let validate;
  try {
    validate = ajv.compile({ ...(schema as object), additionalProperties: false });
  } catch {
    // A schema ajv cannot compile is one this cannot judge. Silence, never a
    // guess — the same rule as a tool with no schema at all.
    return [];
  }

  if (validate(neutral)) return [];
  const live = (validate.errors ?? []).filter((e) => !isExempt(e, exempt));

  // Grouped by kind before they are worded. ajv reports one error per missing
  // property, and "MISSING required: user_id. MISSING required: thread_id."
  // reads as two problems when it is one: the author left the identity out.
  const missing = live
    .filter((e) => e.keyword === 'required')
    .map((e) => (e.params as { missingProperty: string }).missingProperty);
  const unknown = live
    .filter((e) => e.keyword === 'additionalProperties')
    .map((e) => (e.params as { additionalProperty: string }).additionalProperty);
  const rest = live.filter((e) => e.keyword !== 'required' && e.keyword !== 'additionalProperties');

  const out: ToolArgProblem[] = [];
  if (missing.length > 0) out.push({ path: '', message: `MISSING required: ${missing.join(', ')}` });
  if (unknown.length > 0) out.push({ path: '', message: `NOT a parameter: ${unknown.join(', ')}` });
  for (const e of rest) out.push({ path: e.instancePath, message: describe(e) });
  return out;
}

/** ajv's own wording, rephrased where it would send an author looking for the
 *  wrong thing. Everything else is passed through: ajv is clearer than a
 *  paraphrase for the cases it already states well. */
function describe(e: ErrorObject): string {
  const at = e.instancePath ? `${e.instancePath.slice(1).replace(/\//g, '.')} ` : '';
  switch (e.keyword) {
    case 'required':
      return `MISSING required: ${(e.params as { missingProperty: string }).missingProperty}`;
    case 'additionalProperties':
      return `NOT a parameter: ${(e.params as { additionalProperty: string }).additionalProperty}`;
    case 'type': {
      const want = (e.params as { type: string }).type;
      // "an object" / "an array" rather than ajv's bare noun: the two that are
      // structured are the two an author gets wrong, and the article is what
      // makes the sentence read as an instruction.
      const article = want === 'object' || want === 'array' ? `an ${want}` : `a ${want}`;
      return `WRONG type: ${at}must be ${article}`;
    }
    default:
      return `${at}${e.message ?? 'is not valid'}`.trim();
  }
}
