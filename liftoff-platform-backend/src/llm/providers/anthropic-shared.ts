// Shared helpers for the Anthropic provider.
//
// These lived here because there were TWO providers — the direct SDK and
// Claude over Google Vertex — producing identical content blocks, stream
// events, stop reasons and tool shapes, and drift between them was the risk.
// That second provider is retired. The helpers stay because the per-model
// request surface below is still the one place a vendor deprecation is
// recorded, and because the instruction text it holds is model-facing.

import type Anthropic from '@anthropic-ai/sdk';
import type {
  LLMCompletionRequest,
  LLMMessage,
  LLMStopReason,
  LLMToolDefinition,
} from '../types';
import { sanitizeWebContent } from './web-content-sanitizer';

/** Which server-tool wire type a request may ask for.
 *
 *  This was a flat name→version map, which is wrong in two directions that both
 *  fail silently.
 *
 *  1. VERSION. The `_20260209` search/fetch tools (dynamic filtering) run on
 *     Opus 4.6+ and Sonnet 4.6+. Claude Haiku 4.5 — which is what the `small`
 *     tier resolves to — is not among them and takes the basic variants.
 *  It also took a PLATFORM, because serving Claude through Google Vertex
 *  offered only the basic web search and no web fetch at all — sending either
 *  there was a 400 on a request the caller believed was portable. That
 *  provider is retired, so every caller is first-party and the parameter is
 *  gone with it. (The fact was always about Anthropic's server tools on that
 *  platform, never about Vertex: Gemini on Vertex has both under its own
 *  primitives, and providers/google.ts maps the same two serverTools names
 *  onto them.)
 *
 *  Returning null means "this tool cannot be offered"; the caller drops it
 *  rather than sending something the vendor will reject. A model this does not
 *  recognise gets the basic variants, which every model supports: the safe
 *  direction is the older tool, not the newer one. */
const DYNAMIC_FILTERING_MODELS =
  /^claude-(opus-(5|4-8|4-7|4-6)|sonnet-(5|4-6))(-|$)/;
// The `(-|$)` tail is what makes a point release inherit its line, and that is
// deliberate rather than incidental: `claude-opus-5-5` matches through the
// `opus-5` alternative and so gets the dynamic-filtering variants instead of
// silently dropping to the basic ones. A newer model in a listed family
// supports at least what that family did. A model in a NEW family still gets
// the basic variants, which is the safe direction.

export function anthropicServerToolType(
  name: string,
  model: string | undefined,
): string | null {
  const dynamic = !!model && DYNAMIC_FILTERING_MODELS.test(model);
  if (name === 'web_search') return dynamic ? 'web_search_20260209' : 'web_search_20250305';
  if (name === 'web_fetch') return dynamic ? 'web_fetch_20260209' : 'web_fetch_20250910';
  return null;
}

/** Translate our toolChoice into Anthropic's tool_choice parameter.
 *  - 'auto'     → { type: 'auto' }
 *  - 'required' → { type: 'any' }  (any tool, model picks which)
 *  - { name }   → { type: 'tool', name }  (force specific tool) */
export function toAnthropicToolChoice(
  toolChoice: 'auto' | 'required' | 'none' | { name: string } | undefined,
): Anthropic.MessageCreateParams['tool_choice'] | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'required') return { type: 'any' };
  if (toolChoice === 'none') return { type: 'none' };
  return { type: 'tool', name: toolChoice.name };
}

/** Per-model request-surface facts. Lives here rather than in either provider
 *  because both Anthropic providers must answer identically — and because the
 *  instruction text below is model-facing, so a second copy is a second thing
 *  to keep inside INV-PB-016.
 *
 *  A DENY-LIST: an absent entry means the model accepts everything this
 *  provider knows how to send, and `defaultEffort` is only ever what an entry
 *  states. Do NOT give unrecognised models a default effort — `output_config`
 *  is not universal and returns 400 on Haiku 4.5 and Sonnet 4.5, which is the
 *  busiest tier here. */
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
  /** The `thinking.type` to send, or absent to send no `thinking` at all.
   *
   *  Only `between_tools` is expressible here, and only because it changes what
   *  a PERSON sees rather than how the model reasons. From Sonnet 5.5 onward the
   *  prose a model writes between tool calls is returned in `thinking` blocks
   *  instead of `text` blocks, and under the default display those blocks are
   *  empty — so a surface that streams that prose goes silent mid-turn with no
   *  error. `between_tools` is the one setting that returns the notes readably
   *  and needs no beta header.
   *
   *  It is NOT a way to ask for less reasoning, and it is not free: it also
   *  turns off up-front thinking, and it is a 400 above `high` effort. Absent
   *  means adaptive, which is every model's own default. */
  thinking?: 'between_tools';
}

/** WHAT AN UNRECOGNISED MODEL IS ASSUMED TO BE.
 *
 *  This table is an ALLOW-LIST, and the direction is the whole point. As a
 *  deny-list of deprecations — an unlisted model assumed to accept everything —
 *  each time a vendor REMOVES something, the first sign of it is a 400 in
 *  production. A removal such as Opus 5.5 dropping forced tool use has to be
 *  caught by reading the release notes, not by anything here.
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
 *  accepts it. Sonnet 5.5 rejects it on `count_tokens` as well as on a
 *  completion, so the refusal has to happen before a request is built.
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
  // Sonnet 5.5 — the medium tier, and therefore what the three platform
  // assistants run on. No forced tool choice and no temperature (both 400s, the
  // forced choice on `count_tokens` too), structured outputs opted in because
  // that is the route a `responseSchema` caller takes once forcing a tool is
  // gone, and `between_tools` because those assistants stream the model's
  // between-tool prose to a person and it moved into `thinking` blocks on this
  // model.
  //
  // No `effort`: its vendor default is already `high`, the same as Sonnet 5's,
  // so nothing moved under us. The LEVELS are recalibrated between the two —
  // the vendor says to re-run the sweep and start at `medium` or `low` for
  // latency-sensitive chat — but that is a measured change, not a constant to
  // guess at while swapping a model id.
  'claude-sonnet-5-5':          { acceptsStructuredOutputs: true, thinking: 'between_tools' },
  'claude-sonnet-5':            { acceptsForcedToolChoice: true, acceptsStructuredOutputs: true },
  'claude-sonnet-4-6':          { acceptsTemperature: true, acceptsForcedToolChoice: true, acceptsStructuredOutputs: true },
  'claude-sonnet-4-5':          { acceptsTemperature: true, acceptsForcedToolChoice: true },
  'claude-sonnet-4-5-20250929': { acceptsTemperature: true, acceptsForcedToolChoice: true, acceptsStructuredOutputs: true },
  'claude-sonnet-4':            { acceptsTemperature: true, acceptsForcedToolChoice: true },
  // Haiku 5.5 — the small tier, and therefore the busiest path here.
  //
  // It keeps forced tool choice and LOSES temperature, which is the one place
  // this entry is not a copy of the Haiku 4.5 below. Forced tool use is
  // explicitly supported — the vendor's tool-choice page names this model as
  // one that accepts it ("models with thinking on by default, such as Claude
  // Opus 5 and Claude Haiku 5.5, accept it, but a forced call skips thinking"),
  // and the models that 400 on it are listed by name and do not include this
  // one. Temperature goes the other way: "Omit temperature, top_p, and top_k",
  // so this is a vendor-mandated removal rather than the conservative default
  // the inversion would have produced anyway.
  //
  // No `effort`, although this model DOES accept it where Haiku 4.5 400s. Its
  // vendor default is `medium` and Haiku 4.5 was never sent an effort at all,
  // so there is no prior behaviour to preserve and sending one would be a
  // change for its own sake. Opus 5.5 is the only entry with an effort, and
  // only because its vendor default moved under a value we already relied on.
  //
  // No structured outputs, DELIBERATELY and not by omission. The vendor's
  // availability table says "All models" (read 2026-11-12), so this model would
  // take it — but unlike Sonnet 5.5, which needed it because forcing a tool had
  // been removed, here the forced-tool route a `responseSchema` caller takes
  // still works. That makes it a pure optimisation, and the asymmetry says not
  // to take it on a table read: sending `output_config` to a model that does
  // not accept it is a 400 on the first call, while leaving it off costs a
  // working path nothing.
  //
  // Verified 2026-11-12 against platform.claude.com/docs/en/models/haiku-5-5/overview
  // and .../docs/en/agents-and-tools/tool-use/define-tools.
  'claude-haiku-5-5':           { acceptsForcedToolChoice: true },
  // Haiku 4.5 takes temperature and forced tools but NOT effort — sending
  // `output_config.effort` to it is a 400. It was the previous `small` tier.
  'claude-haiku-4-5':           { acceptsTemperature: true, acceptsForcedToolChoice: true },
  'claude-haiku-4-5-20251001':  { acceptsTemperature: true, acceptsForcedToolChoice: true, acceptsStructuredOutputs: true },
};

/** Every id with an entry, for the test that pins them. */
export const MODEL_SURFACES = LEGACY_SURFACES;

/** The registry's surfaces (migration 560), installed by registry-tier-loader on
 *  the same 60-second refresh that carries tiers, rates and windows.
 *
 *  WHY THE TABLE ABOVE IS NOW A SEED. What a model accepts was the last model
 *  fact that still needed a release — in TWO repos, since the tenant runtime
 *  carries its own copy and nothing compared them. It is also the fact with the
 *  least tolerance for being stale, and asymmetrically so: a wrong rate misprices
 *  a call that ran, a wrong surface is a 400 on the FIRST call. All three of the
 *  ways that has happened here were vendors REMOVING something — forced tool use
 *  on Opus 5.5 and Sonnet 5.5, `output_config` on the older models,
 *  `thinking.disabled` on Sonnet 5.5 — which is a thing a release cannot get
 *  ahead of and a registry row can.
 *
 *  ONLY KNOWN KEYS ARE TAKEN, and the filter is the safety property rather than
 *  tidiness. This value comes from a database row that an operator or a sync job
 *  wrote; an unrecognised key silently doing nothing is the correct outcome, and
 *  a typo'd key quietly granting a capability is the outcome that produces a 400
 *  on a live request. */
let registrySurfaces: Record<string, Partial<AnthropicModelSurface>> = {};

const SURFACE_BOOLEAN_KEYS = [
  'acceptsTemperature', 'acceptsForcedToolChoice', 'acceptsStructuredOutputs',
] as const;
const SURFACE_EFFORTS = new Set(['low', 'medium', 'high', 'max']);

/** Install the registry's surfaces, keeping only keys this build understands. */
export function applyRegistryModelSurfaces(
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
    if (raw.thinking === 'between_tools') entry.thinking = 'between_tools';
    if (Object.keys(entry).length > 0) next[modelId] = entry;
  }
  registrySurfaces = next;
}

/** Tests only: drop the registry overlay and answer from the seeds. */
export function _clearRegistryModelSurfaces(): void {
  registrySurfaces = {};
}

export function anthropicModelSurface(modelId: string): AnthropicModelSurface {
  // Registry LAST, so it wins per key — the same precedence the tier overlay
  // uses. It can only ever state a key; a key it omits falls to the seed, and a
  // key neither states falls to the conservative default.
  return {
    ...MODERN_SURFACE,
    ...(LEGACY_SURFACES[modelId] ?? {}),
    ...(registrySurfaces[modelId] ?? {}),
  };
}

/** The `output_config` for a call, or undefined to send none.
 *
 *  Sent ONLY when the caller asks or the model has an explicit
 *  `defaultEffort`. An unrecognised model gets nothing, deliberately: the
 *  parameter is rejected outright by models that predate it. */
export function anthropicOutputConfig(
  modelId: string,
  requestedEffort?: 'low' | 'medium' | 'high' | 'max',
): { effort: 'low' | 'medium' | 'high' | 'max' } | undefined {
  const effort = requestedEffort ?? anthropicModelSurface(modelId).effort;
  return effort ? { effort } : undefined;
}

/** The `thinking` parameter for a call, or undefined to send none.
 *
 *  WHY THIS EXISTS AT ALL. It is not a reasoning knob — it is what keeps a
 *  streaming assistant from going silent. From Sonnet 5.5 onward, prose the
 *  model writes BETWEEN tool calls comes back in `thinking` blocks rather than
 *  `text` blocks, and at the default display those blocks carry no text. The
 *  request still succeeds, the final answer is unaffected, and the only symptom
 *  is that a person watching a multi-tool turn sees nothing until it ends.
 *  `between_tools` returns those notes readably, on every platform, with no beta
 *  header.
 *
 *  WHY ONLY THE STREAMING PATH CALLS THIS. The notes are worth having where a
 *  person is watching them arrive, which is `completeStream`. `between_tools`
 *  also turns OFF up-front thinking, so sending it on the non-streaming paths
 *  would trade reasoning depth for a narration nobody reads — a change to
 *  today's behaviour for no benefit. Those paths stay adaptive, exactly as they
 *  are on Sonnet 5.
 *
 *  WHY IT IS GATED ON EFFORT. `between_tools` is a 400 at `xhigh` / `max`. When
 *  a caller explicitly asks for that much thinking, the right answer is to give
 *  it to them and send no `thinking` at all — adaptive, the model's own default.
 *  A caller asking for maximum reasoning has not asked about narration, and
 *  silently clamping their effort to keep a display feature would be answering a
 *  question they did not ask. Nothing in this repo passes an effort today, so
 *  this is a guard for the next caller rather than a live branch. */
export function anthropicThinkingConfig(
  modelId: string,
  requestedEffort?: 'low' | 'medium' | 'high' | 'max',
): { type: 'between_tools' } | undefined {
  const surface = anthropicModelSurface(modelId);
  if (surface.thinking !== 'between_tools') return undefined;

  const effort = requestedEffort ?? surface.effort;
  if (effort === 'max') return undefined;

  return { type: 'between_tools' };
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

/** Honour a FORCED tool selection on a model that no longer accepts one.
 *
 *  The caller's intent — "you must call this tool" — is preserved; only the
 *  wire shape changes, and only for a model whose surface says the vendor
 *  rejects it. Anthropic's documented replacement is `auto` plus an explicit
 *  instruction naming the tool, so the instruction is returned alongside for
 *  the caller to append to `system`.
 *
 *  `strict` is deliberately NOT promoted here. The vendor's strict subset is
 *  narrower than it looks (closed objects, regex-syntax limits, complexity
 *  caps), so a schema this estate already ships can fail it — `produce_agent`
 *  uses `oneOf` and `maxLength` and would. A caller that sets `strict` itself
 *  keeps it; nothing adds one. */
export function adaptToolChoiceForModel(
  modelId: string,
  toolChoice: Anthropic.MessageCreateParams['tool_choice'] | undefined,
): {
  toolChoice: Anthropic.MessageCreateParams['tool_choice'] | undefined;
  instruction: string | null;
} {
  if (!toolChoice) return { toolChoice, instruction: null };
  if (toolChoice.type !== 'any' && toolChoice.type !== 'tool') {
    return { toolChoice, instruction: null };
  }
  if (anthropicModelSurface(modelId).acceptsForcedToolChoice) {
    return { toolChoice, instruction: null };
  }
  const instruction =
    toolChoice.type === 'tool'
      ? `You must call the ${toolChoice.name} tool to answer this request. Do not reply with plain text.`
      : 'You must call one of the available tools to answer this request. Do not reply with plain text.';
  return { toolChoice: { type: 'auto' }, instruction };
}

/** Append an instruction to the system parameter, after everything already
 *  there. Last, so a cached prefix keeps its bytes and stays a cache hit. */
export function appendSystemInstruction(
  system: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> | undefined,
  instruction: string | null,
): string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> | undefined {
  if (!instruction) return system;
  if (system === undefined) return instruction;
  if (typeof system === 'string') {
    return [{ type: 'text', text: system }, { type: 'text', text: instruction }];
  }
  return [...system, { type: 'text', text: instruction }];
}

/** Build the Anthropic `system` parameter from EVERY system message in the
 *  request, in order.
 *
 *  All of them, not the first one. Anthropic takes `system` as its own
 *  parameter and `buildAnthropicMessages` skips every system-role entry when it
 *  builds the turn list, so a system message this function does not read
 *  reaches no provider at all. It used to read `messages.find(...)`, and callers
 *  that send two — `buildBudgetedPrompt` emits the prompt and then a preamble
 *  carrying the caller's name, their role and the conversation's rolling
 *  summary — had the second silently dropped on this provider while OpenAI kept
 *  it. The symptom is an assistant that does not know who it is talking to and
 *  has forgotten the first half of the conversation, on one provider only.
 *
 *  Emitted as separate content blocks rather than joined, because
 *  `cacheControl` is per block and that is what makes a stable prompt followed
 *  by a volatile preamble cacheable: the breakpoint sits at the end of the
 *  stable block, and everything after it is re-read each turn without moving
 *  the prefix. Joining would put the volatile half inside the cached span.
 *
 *  The single-unmarked-message case still returns a plain string, which is the
 *  shape the vendor documents first and the shape every existing caller and
 *  test already sees. */
export function buildAnthropicSystemParam(
  messages: LLMMessage[] | undefined,
): string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> | undefined {
  const systemMessages = (messages ?? []).filter(m => m.role === 'system' && m.content);
  if (systemMessages.length === 0) return undefined;
  if (systemMessages.length === 1 && !systemMessages[0].cacheControl) {
    return systemMessages[0].content;
  }
  return systemMessages.map(m => ({
    type: 'text' as const,
    text: m.content,
    ...(m.cacheControl ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));
}

/** Translate our LLMToolDefinition[] + serverTools into the Anthropic tools
 *  array. Server tools (e.g. web_search) use versioned type identifiers like
 *  `{ type: "web_search_20250305", name: "web_search" }` and are merged
 *  alongside regular tool definitions.
 *
 *  When a tool carries `cacheControl`, the resulting Anthropic tool object
 *  includes `cache_control: { type: 'ephemeral' }`, marking that position
 *  as a prompt-cache checkpoint (everything up to and including it is cached).
 *
 *  The Anthropic SDK's Tool type may not include all server tool types in
 *  its union, so we cast the merged array to `any` for the tools parameter. */
export function toAnthropicTools(
  tools: LLMToolDefinition[] | undefined,
  serverTools?: ReadonlyArray<{ name: string; type?: string }>,
  /** Which model will run this request. Required to pick a server
   *  tool version the vendor actually offers — see anthropicServerToolType. */
  target?: { model?: string },
): any[] | undefined {
  const userTools = (tools || []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    ...(t.cacheControl ? { cache_control: { type: 'ephemeral' as const } } : {}),
    // Server-side schema enforcement. Only set when the caller asked for it:
    // the vendor rejects schemas using oneOf/maxItems/maxLength under strict,
    // so it cannot be turned on globally.
    ...(t.strict ? { strict: true } : {}),
  }));
  const builtinTools = (serverTools || []).flatMap(st => {
    const type =
      anthropicServerToolType(st.name, target?.model)
      ?? st.type
      ?? null;
    // Dropped rather than guessed: a tool this platform does not offer is
    // better absent than sent under a name the vendor rejects.
    return type ? [{ type, name: st.name }] : [];
  });
  const merged = [...userTools, ...builtinTools];
  return merged.length > 0 ? merged : undefined;
}

/** Build an Anthropic message array from our LLMMessage[] shape.
 *
 *  Anthropic represents multi-round tool use as structured content blocks:
 *  an assistant turn contains `text` + `tool_use` blocks, and the matching
 *  user turn contains `tool_result` blocks (keyed by tool_use_id).
 *
 *  This function handles both the per-message tool shape (LLMMessage.toolCalls
 *  on assistant turns, LLMMessage.toolResults on user turns — used by the
 *  insights chat multi-round tool-use loop) and the legacy request-level
 *  `toolResults` shortcut (preserved for Phase 4 tests).
 */
/**
 * Attach the cache breakpoint a message asked for to its LAST content block.
 *
 * `LLMMessage.cacheControl` says "create a checkpoint at this message's
 * position", and that was true only at the SYSTEM position: this function built
 * every user and assistant turn without ever reading the field, so a caller that
 * marked a turn got nothing, silently, and looked exactly like a caller that had
 * marked the right thing.
 *
 * The distinction matters because the two placements answer different questions.
 * Marking the system prompt caches the part that is identical across
 * CONVERSATIONS and deliberately leaves the turns outside it. Marking the last
 * turn caches the whole prefix, which is what a single-shot call REPEATED with
 * identical input needs — and this platform makes those: the workflow diagram is
 * generated once for the Optimize preview and again by the fire-and-forget
 * writer, same agent, same four inputs, seconds apart. With the mark only on the
 * ~450-token rules block that call pair sat under the vendor's minimum cacheable
 * length and produced no cache entry at all; with it on the turn, the ~2,950-token
 * prefix clears the floor and the second call reads it.
 *
 * On the LAST block because the cached prefix runs up to and including the marked
 * block, so marking anything earlier would leave the rest of the same message
 * outside it. A message whose content is a bare string becomes a one-block array
 * so it has a block to carry the mark.
 */
function withCacheBreakpoint(
  message: Anthropic.MessageParam,
  marked: boolean,
): Anthropic.MessageParam {
  if (!marked) return message;
  const blocks: Anthropic.ContentBlockParam[] =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : [...message.content];
  if (blocks.length === 0) return message;
  const last = blocks[blocks.length - 1];
  blocks[blocks.length - 1] = { ...last, cache_control: { type: 'ephemeral' } } as Anthropic.ContentBlockParam;
  return { ...message, content: blocks };
}

export function buildAnthropicMessages(
  request: LLMCompletionRequest,
): Anthropic.MessageParam[] {
  const baseMessages: Anthropic.MessageParam[] = [];

  for (const m of request.messages) {
    if (m.role === 'system') continue; // system handled separately

    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      // Assistant turn with tool_use blocks. Text (if any) goes first,
      // then the tool_use blocks in order.
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const tc of m.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }
      baseMessages.push(withCacheBreakpoint({ role: 'assistant', content: blocks }, !!m.cacheControl));
      continue;
    }

    if (m.role === 'user' && m.toolResults && m.toolResults.length > 0) {
      // User turn carrying tool_result blocks. Tool results come first,
      // then any accompanying text content.
      // A tool whose answer is a picture carries it here: this vendor's
      // `tool_result.content` takes image blocks beside the text, so the frame
      // needs no turn of its own.
      const blocks: Anthropic.ContentBlockParam[] = m.toolResults.map(tr => ({
        type: 'tool_result' as const,
        tool_use_id: tr.toolCallId,
        content: tr.images && tr.images.length > 0
          ? [
            { type: 'text' as const, text: sanitizeWebContent(tr.content) },
            ...tr.images.map(img => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: img.mimeType as 'image/png', data: img.dataBase64 },
            })),
          ]
          : sanitizeWebContent(tr.content),
      }));
      if (m.content) {
        blocks.push({ type: 'text', text: m.content });
      }
      baseMessages.push(withCacheBreakpoint({ role: 'user', content: blocks }, !!m.cacheControl));
      continue;
    }

    if (m.role === 'user' && m.images && m.images.length > 0) {
      // Images FIRST, then the text. Every vendor's guidance is the same on
      // this and the reason is the same: a question that arrives before the
      // picture it is about is answered from memory of the conversation, not
      // from the image.
      // Images only. Anthropic's ContentBlockParam has an image block and no
      // video one, so anything else here would serialise into a block the API
      // rejects. The modality gate already filters to what this provider can
      // express — this is the backstop that keeps a future caller from finding
      // out at the vendor.
      const blocks: Anthropic.ContentBlockParam[] = m.images
        .filter((img) => img.mimeType.startsWith('image/'))
        .map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
            data: img.dataBase64,
          },
        }));
      if (m.content) blocks.push({ type: 'text', text: m.content });
      baseMessages.push(withCacheBreakpoint({ role: 'user', content: blocks }, !!m.cacheControl));
      continue;
    }

    baseMessages.push(withCacheBreakpoint({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }, !!m.cacheControl));
  }

  // Legacy: request-level `toolResults` shortcut (Phase 4 tests).
  if (request.toolResults?.length) {
    baseMessages.push({
      role: 'user',
      content: request.toolResults.map(r => ({
        type: 'tool_result' as const,
        tool_use_id: r.toolCallId,
        content: sanitizeWebContent(r.content),
      })),
    });
  }

  return baseMessages;
}

/** Normalize Anthropic's stop_reason into our LLMStopReason. Anthropic's
 *  values already match ours for the cases we care about, but we defensively
 *  coerce any other value (e.g. 'stop_sequence', null) to 'end_turn'.
 *
 *  Anthropic emits stop_reason "refusal" when its safety classifier declines
 *  to answer (GA on Opus 4.7+). We map it to 'refusal' so the response is NOT
 *  treated as a successful empty completion downstream. */
export function mapAnthropicStopReason(reason: string | null | undefined): LLMStopReason {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'refusal') return 'refusal';
  return 'end_turn';
}

/** Extract Anthropic's server-tool web-search request count from a usage
 *  object. The SDK's Usage type may not expose server_tool_use (it's a
 *  newer/beta field), so we read it untyped and defensively coerce.
 *  Accepts both full Usage (from message_start / complete) and
 *  MessageDeltaUsage (from message_delta), since either may carry the
 *  server_tool_use field in streaming responses. */
export function extractWebSearchRequests(
  usage: unknown,
): number {
  if (!usage || typeof usage !== 'object') return 0;
  const stu = (usage as any).server_tool_use;
  if (stu && typeof stu.web_search_requests === 'number') {
    return stu.web_search_requests;
  }
  return 0;
}

/** Extract Anthropic's server-tool web-fetch request count from a usage object. */
export function extractWebFetchRequests(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const stu = (usage as any).server_tool_use;
  if (stu && typeof stu.web_fetch_requests === 'number') return stu.web_fetch_requests;
  return 0;
}

/** Extract Anthropic prompt-caching token counts from a usage object.
 *  Returns zeros when absent — non-cached calls or older API versions. */
export function extractCacheTokens(usage: unknown): {
  cacheWriteTokens: number;
  cacheReadTokens: number;
} {
  if (!usage || typeof usage !== 'object') {
    return { cacheWriteTokens: 0, cacheReadTokens: 0 };
  }
  const u = usage as any;
  return {
    cacheWriteTokens: (u.cache_creation_input_tokens ?? 0) as number,
    cacheReadTokens: (u.cache_read_input_tokens ?? 0) as number,
  };
}

/** The whole prompt an Anthropic call carried. The vendor reports the
 *  uncached part as `input_tokens` and the cache reads and cache writes as
 *  their own counts, so the prompt the model actually read is the three
 *  together. A loop that reads `input_tokens` alone under-counts a cached
 *  turn by everything the cache served. */
export function anthropicContextTokens(
  inputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
): number {
  return (inputTokens || 0) + (cacheWriteTokens || 0) + (cacheReadTokens || 0);
}
