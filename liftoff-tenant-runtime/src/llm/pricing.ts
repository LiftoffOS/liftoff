// Model Pricing Module
// Maps provider + model to per-token pricing for cost calculation at invocation completion.
// Source of truth for pricing data — every model in the LLM client must have pricing tracked here.
//
// Pricing sources:
//   Anthropic direct API: https://platform.claude.com/docs/en/about-claude/pricing
//   Claude on Vertex AI:  https://cloud.google.com/vertex-ai/generative-ai/pricing#claude-models
//   Gemini on Vertex AI:  https://cloud.google.com/vertex-ai/generative-ai/pricing#google_models
//   OpenAI:               https://platform.openai.com/docs/pricing

import { GATEWAY_SERVED_FAMILIES } from '../agent-execution/adapter/model-family';
import { logger } from '../infrastructure/logging';
import { pool } from '../infrastructure/database';
import { xaiNativeModelId } from './providers/xai';
import type { LLMProvider } from './types';
import { effectivePricing, totalPromptTokensFor, type PricingOverride } from './pricing-tiers';

/** A provider value rows still CARRY that nothing resolves any more.
 *
 *  'anthropic-vertex' is the whole list: Claude over Google Vertex is retired
 *  and absent from VENDORS, so it is not an LLMProvider and a live call can
 *  never name it. Invocations written while it existed have not gone anywhere,
 *  though, and repricing them is a live path — the stalled-run billing
 *  reconciler calls calculateCost on whatever it finds. So the ACCOUNTING
 *  surface accepts it while the EXECUTION surface cannot: that split is the
 *  point, and it is why this is a separate type rather than a member of
 *  LLMProvider. */
export type HistoricProvider = 'anthropic-vertex';

/** What the pricing and token-accounting functions accept: anything that can
 *  execute today, plus anything a stored row can still say. */
export type PricingProvider = LLMProvider | HistoricProvider;

export interface ModelPricing {
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cachedInputPricePerMillion: number | null;      // Cache read/hit price (0.1x base input)
  cacheWrite5mPricePerMillion?: number | null;    // 5-minute cache write (1.25x base input)
  cacheWrite1hPricePerMillion?: number | null;    // 1-hour cache write (2.0x base input)
  /** Conditional overrides that REPLACE the rates above for requests matching a
   *  prompt-token threshold or UTC window (see pricing-tiers.ts). Synced from
   *  platform-backend; absent for the direct-API models. Several OpenRouter
   *  models we serve have thresholds as low as 32k prompt tokens. */
  overrides?: PricingOverride[];
}

/** Optional inputs to conditional-rate resolution. Both exist because a rate is
 *  no longer a property of the model alone — it depends on the request. */
export interface CalculateCostOptions {
  /** When the call happened. Defaults to now, which is right for the live
   *  completion paths and wrong for anything repricing a stored row — those
   *  must pass the row's own timestamp or a UTC-windowed rate resolves against
   *  the wrong window. */
  at?: Date;
  /** Set when the token counts are a SUM over several requests (e.g. a coding
   *  session's per-model totals, which the vendor SDKs report with no
   *  per-request breakdown). Suppresses conditional bands, because a threshold
   *  tested against a sum charges a band no single request reached. */
  aggregated?: boolean;
  /** Tokens spent WRITING the prompt cache, which Anthropic bills at 1.25x the
   *  input rate (5-minute TTL) and nobody else charges for.
   *
   *  It lives here rather than beside the other three counts because those are
   *  positional and every caller already passes `opts` in the sixth slot. The
   *  cost of the alternative is a silent one: a call site that kept compiling
   *  while its cache writes moved into the options argument.
   *
   *  Additive, never a reallocation. Anthropic reports `input_tokens` exclusive
   *  of cache reads AND cache writes — `freshInputTokensFor` returns it
   *  unchanged for that provider — so this is spend the other buckets do not
   *  contain. On every OpenAI-convention provider it is absent, because a cache
   *  write there is free. */
  cacheWriteTokens?: number;
}

/**
 * The Vertex endpoint the Gemini rows in this table are priced at.
 *
 * NOT a routing default — `providers/google.ts` and the agent-execution adapter
 * own that, and they must agree with this. It is the claim those rows make, named
 * so that anything which could move a Gemini request to another endpoint can
 * refuse instead of mispricing it.
 *
 * Google publishes a non-global column about 10% higher for the GA Gemini 3
 * families, and platform-backend records THAT one because its own provider
 * hardcodes `us-west1`. Two correct tables that disagree look exactly like one
 * wrong table, which is why the endpoint is asserted rather than assumed: a
 * managed Gemini session offered on any other location is declined by
 * `byok/session.ts` rather than billed from a table that does not describe it.
 */
export const GEMINI_PRICED_VERTEX_LOCATION = 'global';

export interface CostResult {
  costUsd: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cachedInputPricePerMillion?: number;
  /** The 5-minute cache-write rate this call was priced at. Undefined where the
   *  model publishes none, which is every non-Anthropic vendor. */
  cacheWritePricePerMillion?: number;
}

// ── Google Search grounding (per-QUERY, not per-token) ────────────────────
// Native googleSearch grounding is billed per search query, separate from model
// tokens: $14 / 1,000 queries = $0.014/query (Vertex list, billing since
// 2026-01-05). https://cloud.google.com/vertex-ai/generative-ai/pricing
// Every query is charged — deliberately no free-tier handling.
export const GOOGLE_SEARCH_GROUNDING_USD_PER_QUERY = 0.014;
export function googleSearchGroundingCostUsd(queries: number): number {
  return Math.max(0, queries) * GOOGLE_SEARCH_GROUNDING_USD_PER_QUERY;
}

// ── OpenAI hosted web_search (per-CALL, not per-token) ────────────────────
// OpenAI bills the hosted web_search tool per call; search-result content tokens
// are free. $10.00 / 1,000 calls = $0.01/call (OpenAI pricing page, verified
// 2026-06-19). Re-check on the next vendor-pricing recalibration cycle (same
// cadence as the Anthropic/Google list above).
export const OPENAI_WEB_SEARCH_USD_PER_CALL = 0.01;
export function openAiWebSearchCostUsd(queries: number): number {
  return Math.max(0, queries) * OPENAI_WEB_SEARCH_USD_PER_CALL;
}

// ── Anthropic hosted web_search (per-CALL, not per-token) ─────────────────
// Claude bills its hosted WebSearch at $10 / 1,000 searches = $0.010/search
// (platform.claude.com/docs/en/about-claude/pricing, read 2026-09-05), on top of
// the tokens the results add to context. Each search counts once however many
// results come back, and a search that errors is not billed.
//
// `WebSearch` is attached default-on to every Claude agent, and Claude is the
// default provider — so on a default configuration this rate covers most runs.
//
// Claude's WebFetch is deliberately absent: Anthropic bills it at NO additional
// cost. Its expense is the tokens it pulls into context, which the token counts
// already carry, and giving it a per-call rate would invent a charge the vendor
// does not make.
export const ANTHROPIC_WEB_SEARCH_USD_PER_CALL = 0.010;
export function anthropicWebSearchCostUsd(searches: number): number {
  return Math.max(0, searches) * ANTHROPIC_WEB_SEARCH_USD_PER_CALL;
}

// ── xAI hosted web_search (per-CALL, not per-token) ───────────────────────
// xAI bills its server-side tools per invocation: web_search $5 / 1,000 calls =
// $0.005/call (docs.x.ai/developers/pricing, read 2026-09-04). x_search and
// code_execution are the same rate, attachment_search $10/1k and
// collections_search $2.50/1k — add those beside this one if we ever offer
// them, rather than reusing this constant for a different tool.
export const XAI_WEB_SEARCH_USD_PER_CALL = 0.005;
export function xaiWebSearchCostUsd(queries: number): number {
  return Math.max(0, queries) * XAI_WEB_SEARCH_USD_PER_CALL;
}

// Pricing keyed by "provider:modelId"
// The same model can have different pricing depending on the provider (e.g. Anthropic direct vs Vertex AI).
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ── Anthropic direct API ──────────────────────────────────────────────
  // Cache pricing: read=0.1x, 5m write=1.25x, 1h write=2.0x base input
  // Opus 5.5 is CHEAPER than the Opus 5 it replaces ($4/$20 against $5/$25) and
  // its cache read is 5% of base input rather than the usual 10% — $0.20, the
  // vendor's own published figure, not a typo to "correct" to $0.40. Verified
  // 2026-09-22 against platform.claude.com/docs/en/models/opus-5-5/overview.
  //
  // KEYED ON THE DOTTED FORM. normalizeModelId collapses a trailing `-N-N`, so
  // `claude-opus-5-5` is looked up as `claude-opus-5.5`; a hyphenated key here
  // would never be read. Opus 5's row stays for the invocations already written
  // against it.
  // Claude Fable 5.1 (codename Cronus). Nothing routes to it yet; the row exists
  // so a pin prices from its first call rather than recording tokens at zero.
  // Its cache read is 2.5% of base input, not 10%: $0.25, the vendor's own
  // figure ("0.025x the base input price"), not a typo to "correct" to $1.00.
  // Writes keep the usual 1.25x / 2x. Verified 2026-09-23 against
  // platform.claude.com/docs/en/about-claude/pricing.
  'anthropic:claude-fable-5.1':  { inputPricePerMillion: 10.00, outputPricePerMillion: 50.00, cachedInputPricePerMillion: 0.25,  cacheWrite5mPricePerMillion: 12.50, cacheWrite1hPricePerMillion: 20.00 },
  'anthropic:claude-opus-5.5':   { inputPricePerMillion: 4.00,  outputPricePerMillion: 20.00, cachedInputPricePerMillion: 0.20,  cacheWrite5mPricePerMillion: 5.00,  cacheWrite1hPricePerMillion: 8.00 },
  'anthropic:claude-opus-5':   { inputPricePerMillion: 5.00,  outputPricePerMillion: 25.00, cachedInputPricePerMillion: 0.50,  cacheWrite5mPricePerMillion: 6.25,  cacheWrite1hPricePerMillion: 10.00 },
  'anthropic:claude-opus-4.8':   { inputPricePerMillion: 5.00,  outputPricePerMillion: 25.00, cachedInputPricePerMillion: 0.50,  cacheWrite5mPricePerMillion: 6.25,  cacheWrite1hPricePerMillion: 10.00 },
  'anthropic:claude-opus-4.7':   { inputPricePerMillion: 5.00,  outputPricePerMillion: 25.00, cachedInputPricePerMillion: 0.50,  cacheWrite5mPricePerMillion: 6.25,  cacheWrite1hPricePerMillion: 10.00 },
  'anthropic:claude-opus-4.6':   { inputPricePerMillion: 5.00,  outputPricePerMillion: 25.00, cachedInputPricePerMillion: 0.50,  cacheWrite5mPricePerMillion: 6.25,  cacheWrite1hPricePerMillion: 10.00 },
  'anthropic:claude-opus-4.5':   { inputPricePerMillion: 5.00,  outputPricePerMillion: 25.00, cachedInputPricePerMillion: 0.50,  cacheWrite5mPricePerMillion: 6.25,  cacheWrite1hPricePerMillion: 10.00 },
  'anthropic:claude-opus-4.1':   { inputPricePerMillion: 15.00, outputPricePerMillion: 75.00, cachedInputPricePerMillion: 1.50,  cacheWrite5mPricePerMillion: 18.75, cacheWrite1hPricePerMillion: 30.00 },
  'anthropic:claude-opus-4':     { inputPricePerMillion: 15.00, outputPricePerMillion: 75.00, cachedInputPricePerMillion: 1.50,  cacheWrite5mPricePerMillion: 18.75, cacheWrite1hPricePerMillion: 30.00 },
  // $2/$10 IS the standard price; do not "restore" $3/$15. Sonnet 5 launched
  // at $2/$10 as introductory pricing through 2026-08-31 with an increase to
  // $3/$15 scheduled for 2026-09-01, and this row carried the higher pair so it
  // would not under-attribute once the window closed. The increase was then
  // cancelled — platform.claude.com/docs/en/about-claude/pricing says $2/$10
  // "is now the standard price" and the increase "will not occur".
  // Verified 2026-09-11.
  //
  // Sonnet 5.5 carries Sonnet 5's rates UNCHANGED — same input, output, both
  // cache writes, and a cache read at the usual 10% of base input. It is the
  // medium tier; Sonnet 5 and 4.6 keep their rows because invocations already
  // written against them still have to price, and a tier move is not a
  // repricing of what already ran. Verified 2026-09-28 against
  // platform.claude.com/docs/en/about-claude/pricing and
  // .../models/sonnet-5-5/overview.
  //
  // KEYED ON THE DOTTED FORM, and this is the whole trap: normalizeModelId
  // collapses a trailing `-N-N`, so the wire id `claude-sonnet-5-5` is looked
  // up as `claude-sonnet-5.5`. A hyphenated key here would never be read, and
  // an unmatched key is a MISS rather than an error — every row would record
  // its tokens at zero cost, silently. `claude-sonnet-5` needs no such care:
  // it has no trailing pair to collapse.
  'anthropic:claude-sonnet-5.5': { inputPricePerMillion: 2.00,  outputPricePerMillion: 10.00, cachedInputPricePerMillion: 0.20,  cacheWrite5mPricePerMillion: 2.50,  cacheWrite1hPricePerMillion: 4.00 },
  'anthropic:claude-sonnet-5':   { inputPricePerMillion: 2.00,  outputPricePerMillion: 10.00, cachedInputPricePerMillion: 0.20,  cacheWrite5mPricePerMillion: 2.50,  cacheWrite1hPricePerMillion: 4.00 },
  'anthropic:claude-sonnet-4.6': { inputPricePerMillion: 3.00,  outputPricePerMillion: 15.00, cachedInputPricePerMillion: 0.30,  cacheWrite5mPricePerMillion: 3.75,  cacheWrite1hPricePerMillion: 6.00 },
  'anthropic:claude-sonnet-4.5': { inputPricePerMillion: 3.00,  outputPricePerMillion: 15.00, cachedInputPricePerMillion: 0.30,  cacheWrite5mPricePerMillion: 3.75,  cacheWrite1hPricePerMillion: 6.00 },
  'anthropic:claude-sonnet-4':   { inputPricePerMillion: 3.00,  outputPricePerMillion: 15.00, cachedInputPricePerMillion: 0.30,  cacheWrite5mPricePerMillion: 3.75,  cacheWrite1hPricePerMillion: 6.00 },
  'anthropic:claude-haiku-4.5':  { inputPricePerMillion: 1.00,  outputPricePerMillion: 5.00,  cachedInputPricePerMillion: 0.10,  cacheWrite5mPricePerMillion: 1.25,  cacheWrite1hPricePerMillion: 2.00 },

  // ── Claude on Vertex AI — HISTORY ONLY ────────────────────────────────
  // Claude over Google Vertex is retired: nothing resolves 'anthropic-vertex'
  // any more, and the provider is gone. These rates stay because invocations
  // already written against it have not gone anywhere, and repricing them is a
  // live path — stalled-run-billing-reconciler.ts calls calculateCost on runs
  // it finds, whatever provider they ran on. Delete these rows and that
  // reconciler stops returning a cost for every Vertex-era run: not a wrong
  // number, no number, because getModelPricing answers null.
  //
  // Nothing WRITES these any more, so they are frozen. A new model does not
  // need a row here.
  'vertex-ai:claude-opus-5.5':   { inputPricePerMillion: 4.00,  outputPricePerMillion: 20.00, cachedInputPricePerMillion: 0.20,  cacheWrite5mPricePerMillion: 5.00,  cacheWrite1hPricePerMillion: 8.00 },
  'vertex-ai:claude-opus-5':     { inputPricePerMillion: 5.00,  outputPricePerMillion: 25.00, cachedInputPricePerMillion: 0.50,  cacheWrite5mPricePerMillion: 6.25,  cacheWrite1hPricePerMillion: 10.00 },
  'vertex-ai:claude-opus-4.8':   { inputPricePerMillion: 5.00,  outputPricePerMillion: 25.00, cachedInputPricePerMillion: 0.50,  cacheWrite5mPricePerMillion: 6.25,  cacheWrite1hPricePerMillion: 10.00 },
  'vertex-ai:claude-opus-4.7':   { inputPricePerMillion: 5.00,  outputPricePerMillion: 25.00, cachedInputPricePerMillion: 0.50,  cacheWrite5mPricePerMillion: 6.25,  cacheWrite1hPricePerMillion: 10.00 },
  'vertex-ai:claude-opus-4.6':   { inputPricePerMillion: 5.00,  outputPricePerMillion: 25.00, cachedInputPricePerMillion: 0.50,  cacheWrite5mPricePerMillion: 6.25,  cacheWrite1hPricePerMillion: 10.00 },
  'vertex-ai:claude-opus-4.5':   { inputPricePerMillion: 5.00,  outputPricePerMillion: 25.00, cachedInputPricePerMillion: 0.50,  cacheWrite5mPricePerMillion: 6.25,  cacheWrite1hPricePerMillion: 10.00 },
  'vertex-ai:claude-opus-4.1':   { inputPricePerMillion: 15.00, outputPricePerMillion: 75.00, cachedInputPricePerMillion: 1.50,  cacheWrite5mPricePerMillion: 18.75, cacheWrite1hPricePerMillion: 30.00 },
  'vertex-ai:claude-opus-4':     { inputPricePerMillion: 15.00, outputPricePerMillion: 75.00, cachedInputPricePerMillion: 1.50,  cacheWrite5mPricePerMillion: 18.75, cacheWrite1hPricePerMillion: 30.00 },
  'vertex-ai:claude-sonnet-5':   { inputPricePerMillion: 3.00,  outputPricePerMillion: 15.00, cachedInputPricePerMillion: 0.30,  cacheWrite5mPricePerMillion: 3.75,  cacheWrite1hPricePerMillion: 6.00 },
  'vertex-ai:claude-sonnet-4.6': { inputPricePerMillion: 3.00,  outputPricePerMillion: 15.00, cachedInputPricePerMillion: 0.30,  cacheWrite5mPricePerMillion: 3.75,  cacheWrite1hPricePerMillion: 6.00 },
  'vertex-ai:claude-sonnet-4.5': { inputPricePerMillion: 3.00,  outputPricePerMillion: 15.00, cachedInputPricePerMillion: 0.30,  cacheWrite5mPricePerMillion: 3.75,  cacheWrite1hPricePerMillion: 6.00 },
  'vertex-ai:claude-sonnet-4':   { inputPricePerMillion: 3.00,  outputPricePerMillion: 15.00, cachedInputPricePerMillion: 0.30,  cacheWrite5mPricePerMillion: 3.75,  cacheWrite1hPricePerMillion: 6.00 },
  'vertex-ai:claude-haiku-4.5':  { inputPricePerMillion: 1.00,  outputPricePerMillion: 5.00,  cachedInputPricePerMillion: 0.10,  cacheWrite5mPricePerMillion: 1.25,  cacheWrite1hPricePerMillion: 2.00 },

  // ── Gemini on Vertex AI ───────────────────────────────────────────────
  // Canonical 3.1 set. Legacy gemini-2.0/2.5 IDs are remapped to these by
  // migration 198 before this code starts using the new keys.
  'google:gemini-3.1-pro':        { inputPricePerMillion: 1.25, outputPricePerMillion: 10.00, cachedInputPricePerMillion: 0.13 },
  'google:gemini-3.1-flash':      { inputPricePerMillion: 0.30, outputPricePerMillion: 2.50,  cachedInputPricePerMillion: 0.03 },
  'google:gemini-3.1-flash-lite': { inputPricePerMillion: 0.25, outputPricePerMillion: 1.50,  cachedInputPricePerMillion: 0.025 },
  // The IDs the LLM-tier provider (providers/google.ts) actually resolves to on
  // Vertex. Official list price at the GLOBAL endpoint, because that is the
  // endpoint this runtime calls — named once as
  // `GEMINI_PRICED_VERTEX_LOCATION` below, so anything that could move the
  // endpoint has something to check itself against. Google publishes a non-global
  // column ~10% higher (GA Gemini 3 families, from 2026-07-01), which is what
  // platform-backend records instead — its provider hardcodes `us-west1`. The two
  // tables differ for that reason and not by accident.
  //
  // THE PRO BAND IS REAL AND IS NOT A ROUNDING DETAIL: over 200K prompt tokens
  // Google charges $4.00 input, $18.00 output and $0.40 cached — double the
  // input and cache, 1.5x the output — and the reprice covers the WHOLE request,
  // which is what minPromptTokens means (strictly greater). Flat, a long-context
  // Pro call bills at half its input cost. The two Flash models publish one price
  // on both sides of that boundary, so they carry no override: an override that
  // restates the base is a claim that something changes there.
  'google:gemini-3.1-pro-preview': { inputPricePerMillion: 2.00, outputPricePerMillion: 12.00, cachedInputPricePerMillion: 0.20,
    overrides: [{ minPromptTokens: 200_000, input: 4.00, output: 18.00, cacheRead: 0.40 }] },
  'google:gemini-3.5-flash':       { inputPricePerMillion: 1.50, outputPricePerMillion: 9.00,  cachedInputPricePerMillion: 0.15 },

  // ── OpenAI ────────────────────────────────────────────────────────────
  // Mirrors platform-backend's src/llm/pricing.ts, which is where these rates
  // are sourced (OpenAI's per-1M Standard prices; PB migration 527). They are
  // NOT in the synced overlay: /api/internal/model-registry serves
  // `model_pricing`, which holds only the OpenRouter-synced open-weights rows,
  // so an OpenAI id missing here records its tokens at zero cost (and shows up
  // as llm_unpriced_tokens).
  //
  // GPT-6 is the current ladder (providers/openai.ts TIER_MODELS). THE FAMILY
  // NAMES DO NOT CARRY THEIR 5.6 MEANING ACROSS: `gpt-5.6-sol` was the large tier
  // at $4 / $20, `gpt-6-sol` is the MEDIUM tier at $2 / $10. Copy a rate by
  // name and it is wrong on every row.
  //
  // One long band on both lines: prompts over 272K input tokens reprice the
  // whole request at 2x input and cache, 1.5x output. Every rate is stated in
  // the override because an omitted key inherits BASE (pricing-tiers.ts).
  // OpenAI publishes one cache-write price with no TTL tiering, so the 5m and
  // 1h fields hold the same number.
  'openai:gpt-6-astra':   { inputPricePerMillion: 10.00, outputPricePerMillion: 50.00, cachedInputPricePerMillion: 1.00, cacheWrite5mPricePerMillion: 12.50, cacheWrite1hPricePerMillion: 12.50,
    overrides: [{ minPromptTokens: 272_000, input: 20.00, output: 75.00, cacheWrite5m: 25.00, cacheWrite1h: 25.00, cacheRead: 2.00 }] },
  // GPT-6.1 Sol — the current medium tier, succeeding gpt-6-sol. Base input,
  // cache writes and output are IDENTICAL to its predecessor, and so is the long
  // band past the same 272k threshold. Exactly one figure moved, and it is the one
  // that reads like a mistake: its CACHED INPUT is 5% of base, $0.10 against
  // gpt-6-sol's $0.20, and $0.20 against $0.40 on the long band. Every sibling
  // here is 10% — astra $1.00 on $10, luna $0.01 on $0.10. It is the vendor's own
  // published figure (developers.openai.com/api/docs/pricing, 2026-09-29), the
  // same shape as Opus 5.5's 5% cache read, and NOT a typo to correct.
  //
  // The id needs no dotted rewriting: normalizeModelId collapses a trailing
  // `-N-N`, and this one ends in `-sol`, so the key is the vendor's id as written.
  'openai:gpt-6.1-sol':   { inputPricePerMillion: 2.00,  outputPricePerMillion: 10.00, cachedInputPricePerMillion: 0.10, cacheWrite5mPricePerMillion: 2.50,  cacheWrite1hPricePerMillion: 2.50,
    overrides: [{ minPromptTokens: 272_000, input: 4.00,  output: 15.00, cacheWrite5m: 5.00,  cacheWrite1h: 5.00,  cacheRead: 0.20 }] },
  'openai:gpt-6-sol':     { inputPricePerMillion: 2.00,  outputPricePerMillion: 10.00, cachedInputPricePerMillion: 0.20, cacheWrite5mPricePerMillion: 2.50,  cacheWrite1hPricePerMillion: 2.50,
    overrides: [{ minPromptTokens: 272_000, input: 4.00,  output: 15.00, cacheWrite5m: 5.00,  cacheWrite1h: 5.00,  cacheRead: 0.40 }] },
  'openai:gpt-6-luna':    { inputPricePerMillion: 0.10,  outputPricePerMillion: 0.50,  cachedInputPricePerMillion: 0.01, cacheWrite5mPricePerMillion: 0.125, cacheWrite1hPricePerMillion: 0.125,
    overrides: [{ minPromptTokens: 272_000, input: 0.20,  output: 0.75,  cacheWrite5m: 0.25,  cacheWrite1h: 0.25,  cacheRead: 0.02 }] },
  // The GPT-5.6 ladder GPT-6 replaced (large sol / medium terra / small
  // luna). Kept for the invocations already written against it, and for any
  // workspace whose routing policy still names a 5.6 id until it is resynced.
  'openai:gpt-5.6-sol':   { inputPricePerMillion: 4.00,  outputPricePerMillion: 20.00, cachedInputPricePerMillion: 0.40, cacheWrite5mPricePerMillion: 5.00,  cacheWrite1hPricePerMillion: 5.00,
    overrides: [{ minPromptTokens: 272_000, input: 8.00,  output: 30.00, cacheWrite5m: 10.00, cacheWrite1h: 10.00, cacheRead: 0.80 }] },
  'openai:gpt-5.6-terra': { inputPricePerMillion: 2.00,  outputPricePerMillion: 12.00, cachedInputPricePerMillion: 0.20, cacheWrite5mPricePerMillion: 2.50,  cacheWrite1hPricePerMillion: 2.50,
    overrides: [{ minPromptTokens: 272_000, input: 4.00,  output: 18.00, cacheWrite5m: 5.00,  cacheWrite1h: 5.00,  cacheRead: 0.40 }] },
  'openai:gpt-5.6-luna':  { inputPricePerMillion: 0.20,  outputPricePerMillion: 1.20,  cachedInputPricePerMillion: 0.02, cacheWrite5mPricePerMillion: 0.25,  cacheWrite1hPricePerMillion: 0.25,
    overrides: [{ minPromptTokens: 272_000, input: 0.40,  output: 1.80,  cacheWrite5m: 0.50,  cacheWrite1h: 0.50,  cacheRead: 0.04 }] },
  // Older lines, kept for the rows written against them. NOTE: gpt-5.5 is
  // priced 2x gpt-5.4 (5.00/30.00), NOT the same — and OpenAI ships NO
  // gpt-5.5-mini/nano (the mini/nano models are the gpt-5.4 line).
  'openai:gpt-5.4':     { inputPricePerMillion: 2.50, outputPricePerMillion: 15.00, cachedInputPricePerMillion: 0.25 },
  'openai:gpt-5.4-mini': { inputPricePerMillion: 0.75, outputPricePerMillion: 4.50,  cachedInputPricePerMillion: 0.075 },
  'openai:gpt-5.4-nano': { inputPricePerMillion: 0.20, outputPricePerMillion: 1.25,  cachedInputPricePerMillion: 0.02 },
  'openai:gpt-5.5':      { inputPricePerMillion: 5.00, outputPricePerMillion: 30.00, cachedInputPricePerMillion: 0.50 },

  // ── Embedding models ──────────────────────────────────────────────────
  // Mirrored from platform-backend/src/llm/pricing.ts so cross-system cost
  // reasoning is consistent. Tenant-runtime uses usage_ledger (not
  // llm_usage_log) for its own embedding cost path today, so these are
  // present for forward-looking usage_ledger-to-cost code paths.
  //
  // OpenAI (priced per 1M tokens):
  'openai:text-embedding-3-small':       { inputPricePerMillion: 0.02, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'openai:text-embedding-3-large':       { inputPricePerMillion: 0.13, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  // Google Vertex AI: gemini-embedding-001 priced per token ($0.15/1M),
  // text-embedding-004/005/multilingual-002 priced per character ($0.10/1M
  // tokens equivalent at ~4 chars/token approximation).
  'google:text-embedding-004':              { inputPricePerMillion: 0.10, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'google:text-embedding-005':              { inputPricePerMillion: 0.10, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'google:text-multilingual-embedding-002': { inputPricePerMillion: 0.10, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'google:gemini-embedding-001':            { inputPricePerMillion: 0.15, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  // Voyage direct API:
  'voyage:voyage-4-large':                  { inputPricePerMillion: 0.12, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'voyage:voyage-4':                        { inputPricePerMillion: 0.06, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'voyage:voyage-4-lite':                   { inputPricePerMillion: 0.02, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'voyage:voyage-3.5':                      { inputPricePerMillion: 0.06, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'voyage:voyage-3.5-lite':                 { inputPricePerMillion: 0.02, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'voyage:voyage-3':                        { inputPricePerMillion: 0.06, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'voyage:voyage-3-large':                  { inputPricePerMillion: 0.18, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'voyage:voyage-3-lite':                   { inputPricePerMillion: 0.02, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'voyage:voyage-context-3':                { inputPricePerMillion: 0.18, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'voyage:voyage-code-3':                   { inputPricePerMillion: 0.18, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'voyage:voyage-finance-2':                { inputPricePerMillion: 0.12, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'voyage:voyage-law-2':                    { inputPricePerMillion: 0.12, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'voyage:voyage-code-2':                   { inputPricePerMillion: 0.12, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  'voyage:voyage-multilingual-2':           { inputPricePerMillion: 0.12, outputPricePerMillion: 0, cachedInputPricePerMillion: null },
  // GLM (Z.ai), served over OpenRouter. Keyed under the FAMILY, like its three
  // neighbours below: `openrouter:` was the gateway standing in for the vendor,
  // readable only while GLM was the only family under that name — and it never
  // was. Keys use the full gateway model id (normalizeModelId leaves
  // 'z-ai/glm-5.2' unchanged). Z.ai LIST rates — conservative.
  //
  // EVERY SEED BELOW IS THE COLD-START FALLBACK, NOT THE RATE. The overlay
  // installed from platform-backend's model-registry snapshot supersedes it
  // within a refresh, so these only ever price calls made before the first load
  // succeeds — or after one fails. That makes a stale seed invisible in normal
  // operation and wrong exactly when the overlay is unavailable, so a seed is
  // only as good as its last reconciliation against `model_pricing`. Reconcile
  // these against that table rather than against a vendor page: the table is
  // what the sync computes (max across serving endpoints) and what the overlay
  // will install a moment later, so anything else guarantees a step change at
  // first load.
  // The GLM-5.3 line — the current ladder. Max across serving endpoints,
  // read from OpenRouter's endpoints API 2026-09-25; the catalog headline is
  // the CHEAPEST endpoint and differs sharply (glm-5.3 lists at 1.40/4.40
  // across 37 endpoints), so seeding from that would step at first load.
  'glm:z-ai/glm-5.3':        { inputPricePerMillion: 2.80, outputPricePerMillion: 8.80, cachedInputPricePerMillion: 0.56 },
  'glm:z-ai/glm-5.3-flash':  { inputPricePerMillion: 0.30, outputPricePerMillion: 1.00, cachedInputPricePerMillion: 0.07 },
  // Superseded, and KEPT: a historic usage row naming these must keep
  // pricing at the rate it actually ran at.
  'glm:z-ai/glm-5.2':        { inputPricePerMillion: 2.31, outputPricePerMillion: 8.00, cachedInputPricePerMillion: 0.56 },
  'glm:z-ai/glm-5-turbo':    { inputPricePerMillion: 1.20, outputPricePerMillion: 4.00, cachedInputPricePerMillion: 0.24 },
  'glm:z-ai/glm-4.7-flash':  { inputPricePerMillion: 0.07, outputPricePerMillion: 0.40, cachedInputPricePerMillion: 0.01 },
  // Qwen, served over OpenRouter. Single-endpoint list rates
  // (OpenRouter /models, 2026-08-04).
  //
  // Three of these carry CONDITIONAL BANDS that this table modelled as flat
  // rates until the tiered-pricing module landed — which under-attributes
  // them. qwen3.7-flash is the
  // Qwen SMALL tier and its first band starts at 32,000 prompt tokens, a
  // routine turn once skills and tool results are injected. These literals are
  // the offline/first-boot seed only; the synced overlay from platform-backend
  // is authoritative.
  // The DATED slug, and it is not cosmetic: OpenRouter publishes this model only
  // as `qwen/qwen3.8-max-0902` and serves no bare `qwen/qwen3.8-max`, so that is
  // the id every request carries and the only one a lookup can match. Keyed
  // undated, the Qwen LARGE model was unpriced on every call — and an unpriced
  // model does not fail, it records the tokens at no cost. Same id the control
  // plane's rate row and registry carry.
  'qwen:qwen/qwen3.8-max-0902':   { inputPricePerMillion: 2.00, outputPricePerMillion: 6.00,  cachedInputPricePerMillion: 0.25 },
  'qwen:qwen/qwen3.7-plus':       { inputPricePerMillion: 0.32, outputPricePerMillion: 1.28,  cachedInputPricePerMillion: 0.064,
    overrides: [{ minPromptTokens: 256_000, input: 0.96, output: 3.84, cacheRead: 0.192 }] },
  'qwen:qwen/qwen3.8-flash':    { inputPricePerMillion: 0.15, outputPricePerMillion: 0.47, cachedInputPricePerMillion: 0.016 },
  'qwen:qwen/qwen3.7-flash':      { inputPricePerMillion: 0.03, outputPricePerMillion: 0.13,  cachedInputPricePerMillion: 0.006,
    overrides: [
      { minPromptTokens:  32_000, input: 0.10, output: 0.40, cacheRead: 0.02 },
      { minPromptTokens: 256_000, input: 0.20, output: 0.80, cacheRead: 0.04 },
    ] },
  'qwen:qwen/qwen3-coder-plus':   { inputPricePerMillion: 0.65, outputPricePerMillion: 3.25,  cachedInputPricePerMillion: 0.13,
    overrides: [
      { minPromptTokens:  32_000, input: 1.17, output: 5.85, cacheRead: 0.234 },
      { minPromptTokens: 128_000, input: 1.95, output: 9.75, cacheRead: 0.39  },
    ] },
  // DeepSeek + Kimi (Moonshot), served over OpenRouter. These
  // slugs serve MANY endpoints with wide rate spreads — static fallback uses the
  // MAX across endpoints (fail-safe-toward-business, matching the sync job's
  // conservative convention; OpenRouter /models/:slug/endpoints, 2026-08-04).
  'deepseek:deepseek/deepseek-v4-pro':   { inputPricePerMillion: 1.91, outputPricePerMillion: 3.83,  cachedInputPricePerMillion: 0.33 },
  'deepseek:deepseek/deepseek-v4-flash': { inputPricePerMillion: 0.21, outputPricePerMillion: 0.70,  cachedInputPricePerMillion: 0.07 },
  // v4.1-flash is the current medium/small tier; v4-flash above stays because
  // invocations recorded under it still have to price as they did. No bands:
  // DeepSeek's own endpoint prices this one by time of day, but every band it
  // publishes sits below what the other ten endpoints charge flat, and a band
  // binds only the endpoint that published it — so the control plane's sync
  // drops them and the conservative max is the whole rate card.
  // Max across endpoints, OpenRouter /models/…/endpoints, read 2026-09-11.
  'deepseek:deepseek/deepseek-v4.1-flash': { inputPricePerMillion: 0.375, outputPricePerMillion: 1.50, cachedInputPricePerMillion: 0.03 },
  'kimi:moonshotai/kimi-k3':         { inputPricePerMillion: 6.00, outputPricePerMillion: 22.50, cachedInputPricePerMillion: 0.60 },
  'kimi:moonshotai/kimi-k2.6':       { inputPricePerMillion: 1.09, outputPricePerMillion: 4.60,  cachedInputPricePerMillion: 0.37 },
  // MiniMax, same max-across-endpoints convention (OpenRouter
  // /models/:slug/endpoints, read 2026-09-11). Two rates, because the small
  // tier resolves to the medium model. Neither publishes a conditional band.
  // Rates are the CONSERVATIVE max across OpenRouter's serving endpoints, which
  // is what sync-model-pricing writes and what these seeds must mirror. The
  // models-list `pricing` field is the DEFAULT endpoint, not the ceiling: for
  // minimax it reads $0.30 / $1.20 while endpoints range to $0.60 / $2.40 and
  // higher, so seeding from it under-attributes every call the router sends to
  // a dearer endpoint. Take the max from /models/:slug/endpoints, never the
  // models list.
  // Xiaomi MiMo, max across serving endpoints — which is what the control
  // plane's sync writes, so a seed that disagrees makes attributed cost step
  // the moment the overlay first loads. Pro is served by three (GMICloud,
  // DeepInfra, Xiaomi) which agree on input and output and not on cache reads:
  // GMICloud quotes 0.004 against the others' 0.0036. Read 2026-09-25.
  'xiaomi:xiaomi/mimo-v2.6-pro':     { inputPricePerMillion: 0.435, outputPricePerMillion: 0.87, cachedInputPricePerMillion: 0.004 },
  'xiaomi:xiaomi/mimo-v2.6-flash':   { inputPricePerMillion: 0.14,  outputPricePerMillion: 0.28, cachedInputPricePerMillion: 0.0028 },
  'minimax:minimax/minimax-m3':      { inputPricePerMillion: 0.75, outputPricePerMillion: 3.00,  cachedInputPricePerMillion: 0.15 },
  'minimax:minimax/minimax-m2.7':    { inputPricePerMillion: 0.60, outputPricePerMillion: 2.40,  cachedInputPricePerMillion: 0.07 },
  // Grok, on xAI's own account. Rates are xAI's published list
  // (docs.x.ai/docs/models), which is where they have to come from now that
  // these bill to an xAI account rather than an OpenRouter one. Doubling above
  // 200k prompt tokens is the COMMON case here rather than an edge, since the
  // 500k/1M/2M windows are why these models were picked.
  //
  // THE THRESHOLD IS 199_999 ON PURPOSE. `minPromptTokens` is STRICTLY GREATER
  // (pricing-tiers.ts note 1, which is OpenRouter's rule and is what this wire
  // shape means everywhere), while xAI's rule is "requests whose prompt REACHES
  // 200k tokens are billed at the higher rate for all tokens in the request" —
  // inclusive. 199_999 is how an inclusive 200k is spelled in an exclusive
  // field. Do not "correct" it to 200_000: that silently bills a prompt of
  // exactly 200,000 tokens at half rate.
  'xai:grok-4.6':  { inputPricePerMillion: 2.00, outputPricePerMillion: 6.00, cachedInputPricePerMillion: 0.50,
    overrides: [{ minPromptTokens: 199_999, input: 4.00, output: 12.00, cacheRead: 1.00 }] },
  'xai:grok-4.3':  { inputPricePerMillion: 1.25, outputPricePerMillion: 2.50, cachedInputPricePerMillion: 0.20,
    overrides: [{ minPromptTokens: 199_999, input: 2.50, output: 5.00,  cacheRead: 0.40 }] },
  // Keyed on the id api.x.ai actually serves. A rate under the bare `grok-4.20`
  // would be looked up by nothing, because no request can name a model the
  // endpoint does not have.
  'xai:grok-4.20-0309-non-reasoning': { inputPricePerMillion: 1.25, outputPricePerMillion: 2.50, cachedInputPricePerMillion: 0.20,
    overrides: [{ minPromptTokens: 199_999, input: 2.50, output: 5.00,  cacheRead: 0.40 }] },
};

// The same rate under the gateway name, derived rather than copied.
//
// These four are providers in their own right and are keyed that way above, but
// they still EXECUTE on OpenRouter — so a row that recorded the gateway name is
// the same call at the same price. `invocations.provider` keeps what ran, and
// re-costing an old row must not silently find nothing: an unmatched key does
// not fail, it records zero.
//
// Derived because three of these carry conditional rate bands, and two
// hand-written copies of a banded rate eventually disagree about one band —
// which surfaces as a reconciliation gap rather than as an error.
for (const [key, rate] of Object.entries(MODEL_PRICING)) {
  const [provider, ...rest] = key.split(':');
  if (!(GATEWAY_SERVED_FAMILIES as readonly string[]).includes(provider)) continue;
  const gatewayKey = `openrouter:${rest.join(':')}`;
  if (!MODEL_PRICING[gatewayKey]) MODEL_PRICING[gatewayKey] = rate;
}

/**
 * Normalize versioned model IDs to the canonical dotted-version form used by
 * MODEL_PRICING keys.
 *
 * Two transformations, applied in order:
 *  1. Strip Anthropic-style date suffixes:        "-20250514"      → ""
 *  2. Collapse a trailing "-major-minor" tail to "-major.minor":
 *       "claude-opus-4-6"  → "claude-opus-4.6"
 *       "claude-haiku-4-5" → "claude-haiku-4.5"
 *
 * The second step bridges the hyphenated IDs the Anthropic and Anthropic-Vertex
 * SDKs emit today against the dotted keys that this table (and the upstream
 * Anthropic / Vertex pricing docs) use. Applied only to the *trailing* segment
 * pair so unversioned base names like "claude-opus-4" pass through untouched.
 */
export function normalizeModelId(modelId: string): string {
  // Grok is priced under xAI's own id. Configurations written before it left
  // OpenRouter still carry the publisher slug, and the rate table is keyed
  // natively, so `xai:x-ai/grok-4.3` matches nothing and the run records its
  // tokens at ZERO cost — silently, because an unknown model is a miss rather
  // than an error.
  //
  // Only this publisher segment is stripped. The other OpenRouter-hosted
  // vendors are still priced under their namespaced slugs (`z-ai/glm-5.2`,
  // `qwen/...`), deliberately, because that is where they still bill.
  const nativeGrok = xaiNativeModelId(modelId);
  const dateStripped = nativeGrok.replace(/-\d{8}$/, '');
  return dateStripped.replace(/-(\d+)-(\d+)$/, '-$1.$2');
}

/**
 * Map the LLMProvider type to the pricing key prefix.
 * Provider types now match pricing keys directly:
 *   'anthropic'        → 'anthropic' (direct API)
 *   'anthropic-vertex' → 'vertex-ai' (Claude via Vertex AI — HISTORY ONLY;
 *                                      nothing resolves this provider now)
 *   'google'           → 'google'
 *   'openai'           → 'openai'
 */
function resolvePricingProvider(provider: PricingProvider): string {
  if (provider === 'anthropic-vertex') {
    return 'vertex-ai';
  }
  return provider;
}

/**
 * Look up pricing for a model + provider combination.
 * Returns null if the model has no pricing configured.
 */
// ── DB-sourced rate overlay (synced from PB GET /api/internal/model-registry) ──
// Installed by src/llm/model-registry-loader.ts on a background refresh. Keyed
// 'provider:normalizeModelId(model_id)' (same shape/normalization as MODEL_PRICING).
// getModelPricing consults this FIRST, falling back to the static MODEL_PRICING
// below. null until first load.
let dbRates: Map<string, ModelPricing> | null = null;

/** Install (or clear, with null) the DB-sourced rate overlay. Called by the loader. */
export function setModelPricingRates(rates: Map<string, ModelPricing> | null): void {
  dbRates = rates;
}

export function getModelPricing(modelId: string, provider: PricingProvider): ModelPricing | null {
  const normalizedModel = normalizeModelId(modelId);
  const pricingProvider = resolvePricingProvider(provider);
  const key = `${pricingProvider}:${normalizedModel}`;

  const pricing = dbRates?.get(key) ?? MODEL_PRICING[key] ?? null;
  if (!pricing) {
    logger.warn({
      event: 'model_pricing_not_found',
      modelId,
      normalizedModel,
      provider,
      pricingProvider,
      key,
    }, `No pricing configured for ${key}. Cost will not be tracked for this invocation.`);
  }

  return pricing;
}

/**
 * Provider-aware fresh-input-token count. Different LLM SDKs report token
 * usage with different cache semantics:
 *   - Anthropic / Anthropic-via-Vertex: `input_tokens` EXCLUDES
 *     `cache_read_input_tokens` (mutually exclusive fields). Fresh = input.
 *   - OpenAI: `prompt_tokens` INCLUDES the cached portion (separately
 *     reported in `prompt_tokens_details.cached_tokens`). Fresh = input - cached.
 *   - Google (Gemini via Vertex): same convention as OpenAI —
 *     `prompt_token_count` is total, `cached_content_token_count` is the
 *     cached portion. Fresh = input - cached.
 *
 * Inline subtraction without this helper is the historical bug source: an
 * Anthropic invocation with input=3, cached=11040 produced `freshInput=-11037`
 * and a negative computed cost. Always route through this function.
 */
export function freshInputTokensFor(
  provider: PricingProvider,
  inputTokens: number,
  cachedTokens: number,
): number {
  if (provider === 'anthropic' || provider === 'anthropic-vertex') {
    return inputTokens;
  }
  return Math.max(0, inputTokens - cachedTokens);
}

/**
 * SQL fragment that returns the fresh-input token count with the same
 * provider semantics as `freshInputTokensFor`. Inline this into queries
 * where `provider`, `input_tokens`, and `cached_tokens` are columns on
 * the row (e.g. `invocations`). Wraps in CASE because Postgres has no
 * native helper for this — keep the literal in lockstep with the TS
 * version above.
 */
export const FRESH_INPUT_TOKENS_SQL = `
  (CASE WHEN provider IN ('anthropic', 'anthropic-vertex')
        THEN input_tokens
        ELSE GREATEST(input_tokens - COALESCE(cached_tokens, 0), 0)
   END)
`.trim();

/**
 * Calculate the USD cost for an invocation based on token usage.
 * Returns null if the model has no pricing configured — the price snapshot columns
 * will remain NULL and cost will be derived as null on read.
 */
export function calculateCost(
  modelId: string,
  provider: PricingProvider,
  inputTokens: number,
  outputTokens: number,
  cachedTokens?: number,
  opts?: CalculateCostOptions,
): CostResult | null {
  const base = getModelPricing(modelId, provider);
  if (!base) {
    return null;
  }

  const cached = cachedTokens ?? 0;

  // Resolve conditional rates BEFORE the arithmetic. The threshold is measured
  // against TOTAL prompt tokens — which for the OpenAI-wire providers already
  // includes the cached portion — not against the fresh-input figure billed
  // below. Conflating the two would trip a threshold late on every cache-heavy
  // request.
  //
  // `aggregated` suppresses bands entirely. A caller holding a SUM over several
  // requests cannot evaluate a per-request threshold: the sum is a number no
  // single call ever had, and testing it would charge a long-context band that
  // nothing justifies. Base rates are the only defensible answer there, and
  // they are also the status quo, so this under-states rather than inventing.
  const pricing = opts?.aggregated
    ? base
    : effectivePricing(base, base.overrides, {
        promptTokens: totalPromptTokensFor(provider, inputTokens, cached),
        at: opts?.at ?? new Date(),
      });

  const freshInputTokens = freshInputTokensFor(provider, inputTokens, cached);
  let costUsd =
    (freshInputTokens * pricing.inputPricePerMillion + outputTokens * pricing.outputPricePerMillion) / 1_000_000;

  if (cached && pricing.cachedInputPricePerMillion) {
    costUsd += (cached * pricing.cachedInputPricePerMillion) / 1_000_000;
  }

  // Cache WRITES. Priced at the 5-minute rate because nothing in this runtime
  // asks for the 1-hour TTL — every `cache_control` breakpoint is plain
  // `ephemeral` — so the 1h column is published and unreachable, and choosing it
  // here would charge a TTL we never bought.
  const cacheWrite = opts?.cacheWriteTokens ?? 0;
  if (cacheWrite > 0 && pricing.cacheWrite5mPricePerMillion) {
    costUsd += (cacheWrite * pricing.cacheWrite5mPricePerMillion) / 1_000_000;
  }

  return {
    costUsd,
    inputPricePerMillion: pricing.inputPricePerMillion,
    outputPricePerMillion: pricing.outputPricePerMillion,
    cachedInputPricePerMillion: pricing.cachedInputPricePerMillion ?? undefined,
    cacheWritePricePerMillion: pricing.cacheWrite5mPricePerMillion ?? undefined,
  };
}

// ── Pricing History (database-backed audit trail) ──────────────���──────────

/**
 * Record a pricing rate change. Closes the current active rate and inserts a new one.
 * Call this when updating MODEL_PRICING entries during a deploy or manual rate change.
 */
export async function recordPricingChange(
  provider: string,
  modelId: string,
  pricing: ModelPricing,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Close the currently active rate
    await client.query(
      `UPDATE model_pricing_history
       SET effective_to = NOW()
       WHERE provider = $1 AND model_id = $2 AND effective_to IS NULL`,
      [provider, modelId],
    );

    // Insert the new rate
    await client.query(
      `INSERT INTO model_pricing_history
        (provider, model_id, input_price_per_million, output_price_per_million, cached_input_price_per_million)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        provider,
        modelId,
        pricing.inputPricePerMillion,
        pricing.outputPricePerMillion,
        pricing.cachedInputPricePerMillion,
      ],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Look up the pricing that was active at a specific point in time.
 * Useful for recomputing historical cost from raw token counts.
 */
export async function getHistoricalPricing(
  provider: string,
  modelId: string,
  asOfDate: Date,
): Promise<ModelPricing | null> {
  const result = await pool.query(
    `SELECT input_price_per_million, output_price_per_million, cached_input_price_per_million
     FROM model_pricing_history
     WHERE provider = $1
       AND model_id = $2
       AND effective_from <= $3
       AND (effective_to IS NULL OR effective_to > $3)
     LIMIT 1`,
    [provider, modelId, asOfDate],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    inputPricePerMillion: parseFloat(row.input_price_per_million),
    outputPricePerMillion: parseFloat(row.output_price_per_million),
    cachedInputPricePerMillion: row.cached_input_price_per_million
      ? parseFloat(row.cached_input_price_per_million)
      : null,
  };
}
