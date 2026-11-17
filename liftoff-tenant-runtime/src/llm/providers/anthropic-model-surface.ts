// The per-model request surface for Anthropic, mirrored from platform-backend's
// providers/anthropic-shared.ts.
//
// TWO PLANES, ONE ANSWER. The control plane and this runtime both call the same
// vendor with the same model ids, so a capability they disagree about is a call
// that works on one and 400s on the other. The table below is deliberately a
// copy rather than an abstraction: there is no shared package between these
// repos on this path, and a drifting copy is a visible diff while a missing
// dependency is a build failure nobody wants at this seam.
//
// The direction of the default is the point — see the comment on
// MODERN_SURFACE. Keep both copies in step when a model is added.
//
// TWO DELIBERATE OMISSIONS from the control plane's copy, both because nothing
// here would call them and an export nothing calls is a feature that does not
// run (the reachability ratchet says so, and it caught exactly this):
//
//   * `anthropicOutputConfig` — the control plane sends `output_config.effort`
//     through it. This runtime sends effort from the Claude Agent SDK adapter
//     instead (`effortForModel` in agent-execution/adapter/anthropic), which is
//     the path its tokens actually go through.
//   * `MODEL_SURFACES` — the control plane's test pins every entry through it.
//     The test here asks `anthropicModelSurface` directly.

export interface AnthropicModelSurface {
  /** Whether `temperature` may be sent. */
  acceptsTemperature: boolean;
  /** Whether `tool_choice` `any` / `tool` may be sent. */
  acceptsForcedToolChoice: boolean;
  /** Sent as `output_config.effort` when the caller states none. Absent means
   *  send no `output_config` at all. */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Whether `output_config.format` (structured outputs) may be sent. */
  acceptsStructuredOutputs: boolean;
}

/** WHAT AN UNRECOGNISED MODEL IS ASSUMED TO BE.
 *
 *  This table is an ALLOW-LIST, and the direction is the whole point. It used
 *  to be a deny-list of deprecations — an unlisted model was assumed to accept
 *  everything — so each time a vendor REMOVES something, the first sign of it
 *  is a 400 at request time.
 *
 *  THE RULE THAT MAKES A DEFAULT SAFE: default to sending LESS.
 *
 *  A field whose default means "do not send this parameter" costs nothing when
 *  it is wrong — an unrecognised model simply does not get a capability it
 *  might have supported, and a later entry turns it on. A field whose default
 *  means "DO send this parameter" is not symmetric: it is a 400 on the first
 *  call to any model that does not take it. So the two booleans that gate
 *  REMOVAL default to false, while `effort` and structured outputs — both of
 *  which are positive acts, and both of which models have rejected — stay
 *  opt-in per model.
 *
 *  The consequence worth stating: a new Anthropic model works on the day it
 *  ships, conservatively. It gets no `temperature`, no forced tool choice, no
 *  `output_config`, and the tool-choice translation below. Adding its entry
 *  is then an optimisation, not a rescue. */
const MODERN_SURFACE: AnthropicModelSurface = {
  acceptsTemperature: false,
  acceptsForcedToolChoice: false,
  acceptsStructuredOutputs: false,
};

/** Models that differ from the modern surface.
 *
 *  Seeded with every id this estate can currently reach, so the inversion
 *  changed nothing for a model already in service — only what happens to the
 *  NEXT one. `model-surface.test.ts` pins the resolved surface per id so that
 *  stays true.
 *
 *  Sampling params: removed on Opus 4.7+ and Sonnet 5. Opus 4.6, Sonnet 4.6 and
 *  everything older still accept `temperature`.
 *
 *  Forced tool use: removed on Opus 5.5 and Sonnet 5.5 (and on Fable 5.1 /
 *  Mythos 5.1, which this estate does not route to). Every earlier model still
 *  accepts it. Sonnet 5.5 rejects it on `count_tokens` too, not just on a
 *  completion.
 *
 *  Effort: supported from Opus 4.5 onward but only SENT where a vendor default
 *  moved under us — that is Opus 5.5 alone, whose default dropped to `medium`
 *  where Opus 5's was `high`. Sending it anywhere else would change today's
 *  behaviour for no reason, and it 400s outright on Haiku 4.5 and Sonnet 4.5.
 *
 *  Structured outputs: GA on the models listed, per the vendor's own support
 *  table (read 2026-09-22). Opt-in because a model that lacks it rejects the
 *  request rather than ignoring the field. */
const LEGACY_SURFACES: Record<string, Partial<AnthropicModelSurface>> = {
  'claude-opus-5-5':            { effort: 'high', acceptsStructuredOutputs: true },
  'claude-opus-5':              { acceptsForcedToolChoice: true, acceptsStructuredOutputs: true },
  'claude-opus-4-8':            { acceptsForcedToolChoice: true, acceptsStructuredOutputs: true },
  'claude-opus-4-7':            { acceptsForcedToolChoice: true, acceptsStructuredOutputs: true },
  'claude-opus-4-6':            { acceptsTemperature: true, acceptsForcedToolChoice: true, acceptsStructuredOutputs: true },
  'claude-opus-4-5':            { acceptsTemperature: true, acceptsForcedToolChoice: true },
  'claude-opus-4-5-20251101':   { acceptsTemperature: true, acceptsForcedToolChoice: true, acceptsStructuredOutputs: true },
  'claude-opus-4':              { acceptsTemperature: true, acceptsForcedToolChoice: true },
  // Sonnet 5.5 is the medium tier. It takes NO forced tool choice and NO
  // temperature, so it needs neither flag — what it does need is the structured
  // outputs opt-in, because that is the route a `responseSchema` caller takes
  // once forcing a tool is off the table. No `effort`: its vendor default is
  // already `high`, the same as Sonnet 5's, so nothing moved under us. The
  // levels ARE recalibrated between the two, which is an effort sweep — a
  // measured change of its own, not a constant to guess at here.
  'claude-sonnet-5-5':          { acceptsStructuredOutputs: true },
  'claude-sonnet-5':            { acceptsForcedToolChoice: true, acceptsStructuredOutputs: true },
  'claude-sonnet-4-6':          { acceptsTemperature: true, acceptsForcedToolChoice: true, acceptsStructuredOutputs: true },
  'claude-sonnet-4-5':          { acceptsTemperature: true, acceptsForcedToolChoice: true },
  'claude-sonnet-4-5-20250929': { acceptsTemperature: true, acceptsForcedToolChoice: true, acceptsStructuredOutputs: true },
  'claude-sonnet-4':            { acceptsTemperature: true, acceptsForcedToolChoice: true },
  // Haiku 4.5 takes temperature and forced tools but NOT effort — sending
  // `output_config.effort` to it is a 400, and it is what the `small` tier
  // resolves to, which makes it the busiest path here.
  'claude-haiku-4-5':           { acceptsTemperature: true, acceptsForcedToolChoice: true },
  'claude-haiku-4-5-20251001':  { acceptsTemperature: true, acceptsForcedToolChoice: true, acceptsStructuredOutputs: true },
};


/** The registry's surfaces, installed from the control plane's snapshot on the
 *  same refresh that carries rates, windows and tiers.
 *
 *  WHY THE TABLE ABOVE IS NOW A SEED, AND WHY THAT MATTERS MOST HERE. This file
 *  is a deliberate COPY of the control plane's `anthropic-shared.ts`, and its own
 *  header says a drifting copy is a visible diff — but nothing compared them, and
 *  the tier map in this same directory drifted a generation exactly that way.
 *  What a model accepts is the fact least able to survive being stale: a wrong
 *  rate misprices a call that ran, a wrong surface is a 400 on the FIRST call.
 *  Every instance in this estate has been a vendor REMOVING something, which a
 *  release in two repos cannot get ahead of and a registry row can.
 *
 *  ONLY KNOWN KEYS ARE TAKEN. The value arrives over the wire from a database
 *  row; an unrecognised key doing nothing is correct, and a typo'd key quietly
 *  granting a capability is the 400 this table exists to prevent. */
let registrySurfaces: Record<string, Partial<AnthropicModelSurface>> = {};

const SURFACE_BOOLEAN_KEYS = [
  'acceptsTemperature', 'acceptsForcedToolChoice', 'acceptsStructuredOutputs',
] as const;
const SURFACE_EFFORTS = new Set(['low', 'medium', 'high', 'max']);

/** Install the registry's surfaces, keeping only keys this build understands. */
export function setRegistryModelSurfaces(
  surfaces: Record<string, Record<string, unknown>>,
): void {
  const next: Record<string, Partial<AnthropicModelSurface>> = {};
  for (const [modelId, raw] of Object.entries(surfaces)) {
    const entry: Partial<AnthropicModelSurface> = {};
    for (const key of SURFACE_BOOLEAN_KEYS) {
      if (raw[key] === true) entry[key] = true;
      else if (raw[key] === false) entry[key] = false;
    }
    if (typeof raw.effort === 'string' && SURFACE_EFFORTS.has(raw.effort)) {
      entry.effort = raw.effort as AnthropicModelSurface['effort'];
    }
    if (Object.keys(entry).length > 0) next[modelId] = entry;
  }
  registrySurfaces = next;
}

/** Tests only: drop the overlay and answer from the seeds. */
export function _clearRegistryModelSurfaces(): void {
  registrySurfaces = {};
}

export function anthropicModelSurface(modelId: string): AnthropicModelSurface {
  // Registry LAST, so it wins per key. It can only ever STATE a key; one it
  // omits falls to the seed, and one neither states falls to the conservative
  // default — so a row can grant or revoke a capability but never widen the
  // surface by saying nothing.
  return {
    ...MODERN_SURFACE,
    ...(LEGACY_SURFACES[modelId] ?? {}),
    ...(registrySurfaces[modelId] ?? {}),
  };
}

/** Turn a caller's response schema into an `output_config.format` payload, or
 *  null when it cannot be trusted to one.
 *
 *  WHY THIS EXISTS. A `responseSchema` request has always been served by handing
 *  the model a single tool and FORCING it — the only way to guarantee
 *  schema-shaped JSON when that was written. Structured outputs is the vendor's
 *  real answer to the same need: the sampler is constrained to the schema, so
 *  the guarantee is in the decoder rather than in a tool the model has to be
 *  told to call. It also survives Opus 5.5 removing forced tool use, where the
 *  tool route degrades to `auto` plus an instruction — a request, not a promise.
 *
 *  WHY A WHITELIST OF KEYS, NOT A BLACKLIST. Grammar-constrained sampling
 *  accepts a SUBSET of JSON Schema, and the subset is narrower than it reads:
 *  `oneOf`, `pattern`, `minLength`/`maxLength`, `maxItems` and
 *  `minimum`/`maximum` are all rejected, `minItems` only takes 0 or 1, and
 *  objects must be closed. Enumerating what is forbidden means every keyword
 *  nobody thought of is silently permitted — and the failure is a 400 on a live
 *  request. So this enumerates what is ALLOWED and refuses everything else.
 *  A false negative costs one unnecessary fallback to the tool route; a false
 *  positive costs a failed call. They are not symmetric.
 *
 *  `additionalProperties: false` is INJECTED rather than demanded of callers:
 *  the vendor requires it on every object and no existing caller writes it, so
 *  requiring it would mean nobody qualifies. */
const STRUCTURED_OUTPUT_ALLOWED_KEYS = new Set([
  'type', 'properties', 'required', 'items', 'enum', 'description',
  'additionalProperties', 'title',
]);

const STRUCTURED_OUTPUT_ALLOWED_TYPES = new Set([
  'object', 'array', 'string', 'number', 'integer', 'boolean', 'null',
]);

function structuredOutputSafe(node: unknown): boolean {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const obj = node as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!STRUCTURED_OUTPUT_ALLOWED_KEYS.has(key)) return false;
  }

  const type = obj.type;
  if (typeof type !== 'string' || !STRUCTURED_OUTPUT_ALLOWED_TYPES.has(type)) return false;

  if (type === 'object') {
    const props = obj.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) return false;
    for (const value of Object.values(props as Record<string, unknown>)) {
      if (!structuredOutputSafe(value)) return false;
    }
    if (obj.required !== undefined && !Array.isArray(obj.required)) return false;
  }

  if (type === 'array') {
    if (!structuredOutputSafe(obj.items)) return false;
  }

  if (obj.enum !== undefined) {
    if (!Array.isArray(obj.enum)) return false;
    // Complex values inside an enum are not supported.
    if (obj.enum.some((v) => v !== null && typeof v === 'object')) return false;
  }

  return true;
}

/** Close every object in a schema, which the vendor requires and no caller writes. */
function closeObjects(node: unknown): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const obj = { ...(node as Record<string, unknown>) };

  if (obj.type === 'object') {
    obj.additionalProperties = false;
    if (obj.properties && typeof obj.properties === 'object') {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj.properties as Record<string, unknown>)) {
        props[k] = closeObjects(v);
      }
      obj.properties = props;
      // Every property is required, because a constrained decode that may omit
      // a field gives the caller back the same optionality the tool route had —
      // and every caller here reads the fields it named.
      if (obj.required === undefined) obj.required = Object.keys(props);
    }
  }
  if (obj.type === 'array' && obj.items) obj.items = closeObjects(obj.items);
  return obj;
}

/** The `output_config.format` for a response schema, or null to use the tool
 *  route: the model does not support structured outputs, or the schema uses
 *  something the constrained decoder does not accept. */
export function anthropicStructuredOutputFormat(
  modelId: string,
  schema: unknown,
): { type: 'json_schema'; schema: Record<string, unknown> } | null {
  if (!anthropicModelSurface(modelId).acceptsStructuredOutputs) return null;
  if (!structuredOutputSafe(schema)) return null;
  return { type: 'json_schema', schema: closeObjects(schema) as Record<string, unknown> };
}

