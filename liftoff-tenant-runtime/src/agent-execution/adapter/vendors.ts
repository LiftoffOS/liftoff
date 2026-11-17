// Every vendor this runtime can execute, declared ONCE.
//
// WHY THIS FILE EXISTS
//
// Adding Grok meant writing "Grok exists" into about a dozen places: the
// provider list, a second duplicate copy of that same list, the engine list,
// three SQL CHECK constraints, the startup-validation lists, a metrics label
// allow-list, and the provider→engine switch. Six of them were missed, and not
// one failure said so:
//
//   - the provider list missed `xai`, so a Grok agent resolved to ANTHROPIC —
//     the fallback for an unrecognised provider is a working vendor
//   - the duplicate list in engine-resolver missed it too, so invocation
//     creation recorded a NULL engine and provenance read `unknown-legacy`
//   - the startup validation, whose whole job is noticing an unrecognised
//     engine at boot, restated the list by hand and could not see this one
//
// The shape of every one of those: a fact about a vendor, restated somewhere
// that had no way to know it had gone stale. So the fact is stated here and the
// rest is derived. Adding a vendor is an entry in this record; the unions, the
// resolver, the boot check and the metric labels follow from it.
//
// WHAT IS NOT HERE
//
// Rates and tier models. Rates are keyed per MODEL rather than per vendor
// (`xai:grok-4.6`), and tier maps already live one-per-vendor in
// llm/providers/*.ts — neither is duplicated, so moving them would be churn
// rather than a fix. This file is for the facts that WERE being restated.
//
// SQL CHECK constraints cannot derive from TypeScript at all. They stay
// hand-written, and `scripts/__tests__/invocations-provider-constraint.test.ts`
// compares them against what this record produces, which is the same protection
// by the only route the database allows.
//
// Imports nothing on purpose: the provider and engine unions are derived FROM
// this file, so anything it imported from them would be a cycle.

/**
 * Closed, centrally-maintained identity of the CONCRETE outer-agent engine that
 * executed (or will execute) an invocation. Operational metadata, NOT a
 * tenant-extensible registry: a provider maps to one of two engines via a
 * deployment env flag, so `provider` alone cannot tell Codex from OpenAI-Agents,
 * Gemini-GenAI from ADK, or OpenCode from the OpenAI wire.
 *
 * Declared HERE, beside the record that uses it, so the compiler enforces that
 * every engine a vendor names is a real one. Written out rather than derived
 * from the record because `Object.values` widens to `string`, and a widened
 * union accepts any string — including the misspelling this union exists to
 * catch. Together they check each other: the union constrains the record's
 * values, and `vendor-record.test.ts` checks nothing in the union is orphaned.
 */
export type ExecutionEngineId =
  | 'claude-agent-sdk'
  | 'openai-agents'
  | 'openai-codex'
  | 'google-genai'
  | 'google-adk'
  /** Gemini on the Gemini CLI — Google's own agent runtime, driven headless
   *  over its stream-json output. The CLI's SDK form is not published yet;
   *  when it is, this engine moves onto it the way Codex sits on its SDK. */
  | 'google-gemini-cli'
  | 'openrouter-openai-wire'
  /** Grok on api.x.ai. Distinct from `openrouter-openai-wire`, which is the same
   *  model on Liftoff's OpenRouter account: different endpoint, different
   *  account, different model namespace. Serves both funding models — Grok
   *  resolves to provider `xai` whoever pays, and only the credential differs. */
  | 'xai-openai-wire'
  | 'opencode'
  /** Provenance-only sentinel for pre-provenance rows. Never resolved. */
  | 'unknown-legacy';

/**
 * Which concrete engine a provider runs on.
 *
 * A VENDOR FAMILY IS ITS MODELS AND ITS RUNTIME. "Anthropic" means Claude on
 * Claude Code, "OpenAI" means GPT on Codex, "Google" means Gemini on the Gemini
 * CLI, "xAI" and the open-weights families mean Grok and the OpenRouter-served
 * models on opencode — each vendor's own agent loop driving that vendor's
 * model, which is what a workspace chooses when it chooses a vendor. `default`
 * is that runtime.
 *
 * The alternatives are the ESCAPE HATCHES: the OpenAI-wire bridge for OpenAI,
 * xAI and the gateway families (the loop this runtime owns, driving the same
 * model), and the Gen AI SDK or ADK for Google. A deployment flag selects one
 * for every agent on that provider on this service — there is no per-agent
 * engine — without a code change, and it is why a provider cannot simply name
 * one engine.
 */
export interface VendorEngine {
  readonly default: Exclude<ExecutionEngineId, 'unknown-legacy'>;
  /** Env var that can select an alternative engine. */
  readonly envVar?: string;
  /** Value of `envVar` → the engine it selects. */
  readonly alternatives?: Readonly<Record<string, Exclude<ExecutionEngineId, 'unknown-legacy'>>>;
}

export interface VendorSpec {
  /** The provider id the routing chain resolves to, and the value written to
   *  `invocations.provider`. Same as the record key. */
  readonly provider: string;
  readonly engine: VendorEngine;
}

/** The engine every OpenRouter-served family runs on.
 *
 *  One object, shared, rather than the same lines under each of five vendors.
 *  The deployment flag that swaps opencode for the wire adapter applies to the
 *  GATEWAY, not to a family on it — so it has to move for all of them together
 *  or for none, and five copies is five chances for it to move for four.
 *
 *  Exported because its IDENTITY is what marks a family as gateway-served
 *  (`model-family.ts` derives that set from it): the engine id cannot say so
 *  any more, now that Grok runs on the same engine from its own account. */
export const OPEN_WEIGHTS_ENGINE = {
  default: 'opencode',
  envVar: 'OPENROUTER_ENGINE',
  alternatives: { wire: 'openrouter-openai-wire' },
} as const satisfies VendorEngine;

export const VENDORS = {
  anthropic: {
    provider: 'anthropic',
    engine: { default: 'claude-agent-sdk' },
  },
  // GPT on Codex. The Agents SDK bridge is the escape hatch.
  openai: {
    provider: 'openai',
    engine: {
      default: 'openai-codex',
      envVar: 'OPENAI_ENGINE',
      alternatives: { agents: 'openai-agents' },
    },
  },
  // Gemini on the Gemini CLI. The Gen AI SDK loop this runtime owns and ADK
  // are the escape hatches — two, because both predate the CLI here and each
  // has been the flagged alternative at some point.
  google: {
    provider: 'google',
    engine: {
      default: 'google-gemini-cli',
      envVar: 'GOOGLE_ENGINE',
      alternatives: { genai: 'google-genai', adk: 'google-adk' },
    },
  },
  // Grok, on its own account and its own API. It used to execute as
  // `openrouter`, which meant a Grok agent ran whatever OpenRouter's shared
  // tier map published — GLM — and funding it from a customer's key meant
  // swapping adapters mid-run.
  //
  // On opencode, from xAI's own account: the engine is shared with the
  // open-weights families, the transport and the key are not. Its flag is its
  // own, because the gateway's flag moves the gateway's families and Grok is
  // not one of them any more. The wire bridge to api.x.ai is the escape hatch.
  xai: {
    provider: 'xai',
    engine: {
      default: 'opencode',
      envVar: 'XAI_ENGINE',
      alternatives: { wire: 'xai-openai-wire' },
    },
  },
  // The open-weight families, each reached through the OpenRouter gateway.
  //
  // A PROVIDER NAMES A FAMILY, and `openrouter` named the gateway. A gateway
  // cannot say which family was chosen: resolution produces one adapter and one
  // tier map per provider, so that value answered all four with whatever the
  // single OpenRouter tier map published — GLM. A workspace set to Qwen ran
  // GLM, silently, because nothing downstream had a second thing to compare it
  // against. Grok hit exactly this and left; these four had nowhere to go until
  // they had names of their own.
  //
  // They SHARE the engine record rather than gaining one each, because the
  // endpoint and the account are OpenRouter's — the ids stay namespaced
  // (`z-ai/…`, `qwen/…`, `deepseek/…`, `moonshotai/…`) and the calls bill
  // there. That is the line Grok is on the other side of: it moved to api.x.ai
  // and took its billing with it. The gateway's name lives on the shared
  // record's flag and on the wire engine it can select, which is where it
  // belongs.
  glm: {
    provider: 'glm',
    engine: OPEN_WEIGHTS_ENGINE,
  },
  qwen: {
    provider: 'qwen',
    engine: OPEN_WEIGHTS_ENGINE,
  },
  deepseek: {
    provider: 'deepseek',
    engine: OPEN_WEIGHTS_ENGINE,
  },
  kimi: {
    provider: 'kimi',
    engine: OPEN_WEIGHTS_ENGINE,
  },
  minimax: {
    provider: 'minimax',
    engine: OPEN_WEIGHTS_ENGINE,
  },
  xiaomi: {
    provider: 'xiaomi',
    engine: OPEN_WEIGHTS_ENGINE,
  },
} as const satisfies Record<string, VendorSpec>;

/** Provenance-only sentinel for pre-provenance rows. Belongs to no vendor and
 *  is never produced by resolution, which is why it is named here rather than
 *  reached by deriving it from something. */
export const UNKNOWN_ENGINE: ExecutionEngineId = 'unknown-legacy';

/** Every engine any vendor can resolve to — defaults and alternatives both.
 *  An alternative that is not listed here is an engine a deployment flag can
 *  select and nothing else knows about. */
export const VENDOR_ENGINE_IDS: readonly ExecutionEngineId[] = [
  ...new Set(
    Object.values(VENDORS).flatMap((v) => [
      v.engine.default,
      ...Object.values((v.engine as VendorEngine).alternatives ?? {}),
    ]),
  ),
];

/** One (engine, provider) configuration a run can land on. */
export interface EngineProviderPair {
  readonly engine: Exclude<ExecutionEngineId, 'unknown-legacy'>;
  readonly provider: keyof typeof VENDORS;
}

/**
 * Providers that share one engine AND one configuration of it, collapsed to a
 * representative for the callers that exercise an engine per configuration
 * rather than per family: the certification probes and the cache benchmark.
 *
 * The gateway families are one such group. They share the shared engine
 * record — one transport, one key, one flag — so opencode configured for GLM
 * and opencode configured for Qwen are the same configuration with a different
 * model id, and the first declared answers for all of them.
 *
 * EMPTY TODAY, and deliberately kept. Its only entry was 'anthropic-vertex',
 * collapsed onto `anthropic` because it was the same SDK behind a different
 * credential; Claude over Google Vertex is retired and there is nothing left to
 * collapse. The mechanism stays because the next vendor that is one transport
 * of another needs exactly this, and the gateway families above describe the
 * shape it takes.
 */
const PAIR_REPRESENTATIVE: Partial<Record<keyof typeof VENDORS, keyof typeof VENDORS>> = {};

/**
 * Every (engine, provider) pair a run can resolve to, defaults and
 * alternatives both — the inverse of the record, enumerated rather than
 * collapsed to one provider per engine.
 *
 * It WAS collapsed: `providerForEngine` answered "one that runs here", by
 * declaration order, and the certification probes and the cache benchmark
 * drove each engine as that one provider. That was one row short the moment
 * an engine served two configurations. After the flip opencode serves Grok
 * from xAI's account and the open-weights families from OpenRouter's, and a
 * certification keyed on the engine alone would have driven it as xAI and
 * left its OpenRouter configuration — the one every open-weights agent runs
 * on — untested.
 *
 * Providers that are one configuration of an engine are collapsed to a
 * representative (`PAIR_REPRESENTATIVE`, and the shared gateway record), so
 * the list is the set of things that can differ, not the set of names.
 * Declaration order decides which family represents the gateway, which keeps
 * the answer stable and inspectable.
 */
export function engineProviderPairs(): readonly EngineProviderPair[] {
  const seen = new Set<string>();
  const pairs: EngineProviderPair[] = [];
  let gatewayRepresentative: keyof typeof VENDORS | undefined;
  for (const [name, spec] of Object.entries(VENDORS) as [keyof typeof VENDORS, VendorSpec][]) {
    let provider = PAIR_REPRESENTATIVE[name] ?? name;
    if (spec.engine === OPEN_WEIGHTS_ENGINE) {
      gatewayRepresentative ??= name;
      provider = gatewayRepresentative;
    }
    const engines = [spec.engine.default, ...Object.values((spec.engine as VendorEngine).alternatives ?? {})];
    for (const engine of engines) {
      const key = `${engine}+${provider}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ engine, provider });
    }
  }
  return pairs;
}

/** The pairs on ONE engine, for the callers that already know which. */
export function pairsForEngine(engine: ExecutionEngineId): readonly EngineProviderPair[] {
  return engineProviderPairs().filter((p) => p.engine === engine);
}

/**
 * Providers that exist in the record but are not certified or benchmarked as
 * a family of their own, each with the reason.
 *
 * EMPTY TODAY, and deliberately kept. Its only entry was 'anthropic-vertex',
 * excluded because it was an inert failover with no certification credential —
 * certifying it would have been certifying a pair that could only fail. It is
 * retired, so it is not excluded from the matrix, it is absent from the record
 * entirely. The mechanism stays for the next provider that is present but not
 * certifiable, and a reason string is required of it.
 */
export const PROVIDER_FAMILY_EXCLUSIONS: Readonly<Record<string, string>> = Object.freeze({});

/**
 * THE SECOND MATRIX. Every reachable provider FAMILY, with the engine(s) it
 * resolves to — defaults and alternatives both — and NO representative
 * collapse.
 *
 * `engineProviderPairs` above enumerates what can differ in TRANSPORT, and it
 * deliberately folds qwen, deepseek, kimi and minimax onto glm: for a
 * turn-closing or usage-emission test the four are one configuration of the
 * gateway engine. That is exactly wrong for anything where the model id, the
 * provider's own configuration or the provider's CACHE behaviour differs —
 * Qwen has cache rules of its own while its representative is GLM — so a cache
 * benchmark run over the first matrix would report GLM's numbers as Qwen's.
 *
 * Derived from `VENDORS`, never hand-written, minus the exclusions above with
 * their reasons. Adding a vendor adds a row here by construction.
 */
export function providerFamilyPairs(): readonly EngineProviderPair[] {
  const pairs: EngineProviderPair[] = [];
  for (const [name, spec] of Object.entries(VENDORS) as [keyof typeof VENDORS, VendorSpec][]) {
    if (PROVIDER_FAMILY_EXCLUSIONS[name]) continue;
    const engines = [spec.engine.default, ...Object.values((spec.engine as VendorEngine).alternatives ?? {})];
    for (const engine of engines) pairs.push({ engine, provider: name });
  }
  return pairs;
}
