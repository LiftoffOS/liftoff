// Canonical LLM pricing table and per-row cost calculation.
// Single source of truth — imported by both cost-attribution ingesters
// and insights data providers.

import { log } from '../infrastructure/logging';
import { OPENROUTER_HOSTED_PROVIDERS } from '../model-registry/workspace-ai-vendors';
import {
  effectivePricing,
  freshInputTokensFor,
  totalPromptTokensFor,
  type PricingOverride,
} from './pricing-tiers';

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** Conditional overrides that REPLACE the rates above for requests matching a
   *  prompt-token threshold or UTC window (see pricing-tiers.ts). Populated by
   *  the sync job for the OpenRouter-hosted models, several of which have
   *  thresholds as low as 32k tokens, and written by hand for the direct-API
   *  models whose vendors publish a long-context band — OpenAI's GPT-5.6 line at
   *  272k, Gemini 3.1 Pro at 200k. */
  overrides?: PricingOverride[];
}

// All prices in USD per million tokens.
// cacheWrite5m: Anthropic 5-minute TTL cache write (1.25× base input).
// cacheWrite1h: Anthropic 1-hour TTL cache write (2× base input).
//               The Anthropic SDK returns cache_creation_input_tokens but does
//               NOT distinguish 5m vs 1h TTL. Use cacheWrite5m for attribution
//               (conservative — the cheaper tier). cacheWrite1h is present for
//               future use if we start tracking TTL at request time.
// cacheRead:    Anthropic cache read. NOT a fixed multiple of base input, and
//               writing one here is how this table ends up wrong by 2x.
//               Claude 4.x and Claude 5 read at 0.1x; the 5.5 generation does
//               not — Opus 5.5 and Sonnet 5.5 read at 0.05x and Fable 5.2 at
//               0.025x. Take every cache read from the vendor's own published
//               figure for that model, never from its predecessor and never
//               from a multiplier.
//
// COMPLETENESS, verified 2026-11-12 by reading the vendors' own pages (Chromium
// over docs.claude.com/en/docs/about-claude/models/overview and its pricing
// page, and platform.openai.com/docs/{models,pricing}):
//
//   Anthropic's current lineup is exactly four — Fable 5.2, Opus 5.5,
//   Sonnet 5.5, Haiku 5.5, all at 1M context / 128K output — and OpenAI's
//   flagship text lineup is exactly four: gpt-6-astra, gpt-6.1-sol,
//   gpt-6.1-terra, gpt-6-luna. All eight are in this table at the rates those
//   pages publish. There is no gpt-6.1-astra or gpt-6.1-luna: the 6.1 line is
//   sol and terra only.
//
// WHAT IS DELIBERATELY ABSENT, so it is not re-found as a gap and filled in:
//
//   * Claude Mythos 5.2 / 5.1 / 5. The vendor's own page: "available only to
//     organizations verified through Anthropic's verification programs, such as
//     the Cyber Verification Program. It has the same specifications and
//     pricing as Claude Fable 5.2." Access-gated, and rate-identical to a model
//     already here.
//   * gpt-6-cyber ($20 / $100) and gpt-6-rosalind ($15 / $75), both behind
//     OpenAI's Trusted Access programmes, plus gpt-6-astra-law — the vertical
//     specialisations, listed under "Specialized models" rather than flagship.
//   * chat-latest, which is the ChatGPT model and not an API lineup model.
//   * The image, audio and realtime families (gpt-image-*, gpt-live-*,
//     gpt-realtime-*). Different modalities; the voice lane prices its own.
//
//   A rate row costs nothing, so the bar for adding one is low — but it is not
//   zero, because branding-guardrail.test.ts requires every key here to have a
//   MODEL_ID_MAP entry, and that means inventing a display name for a model
//   nobody can call. That is product surface, not a rate. If access to one of
//   these is ever granted, add the rate and the name together, from the vendor's
//   page, in one change.
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude Fable 5.2 — Anthropic's Frontier model (WORKSPACE_AI_VENDORS
  // `frontier`). No tier routes to it; the rate is here so a run that names it
  // is never billed at another model's price. Verified 2026-11-12 against
  // platform.claude.com/docs/en/models/fable-5-2/overview: $8 / $40, 5m write
  // $10, 1h write $16, cache hits $0.20.
  //
  // CHEAPER than the Fable 5.1 it succeeds ($10 / $50), which is the direction
  // this generation has moved in throughout — Opus 5.5 under Opus 5, Fable 5.2
  // under Fable 5.1 — so a rate carried forward on the strength of the family
  // name OVER-charges here rather than under-charging. The cache read keeps the
  // family's 0.025x: $0.20 on $8 input, not a tenth of it.
  'claude-fable-5-2':             { input: 8.00,  output: 40.00, cacheWrite5m: 10.00, cacheWrite1h: 16.00, cacheRead: 0.20 },
  // Claude Fable 5.1 — the previous Frontier model, kept for the rows
  // already written against it. Verified 2026-09-23 against
  // platform.claude.com/docs/en/about-claude/pricing:
  // $10 / $50, 5m write $12.50, 1h write $20, cache hits $0.25.
  //
  // Its cache-read rate BREAKS the 0.1x rule the header above states, further
  // than Opus 5.5 does: $0.25 is 2.5% of base input, per the vendor's own
  // footnote ("priced at 0.025x the base input price"), not a typo to
  // "correct" to $1.00. The write tiers keep the usual ratios (1.25x / 2x).
  'claude-fable-5-1':             { input: 10.00, output: 50.00, cacheWrite5m: 12.50, cacheWrite1h: 20.00, cacheRead: 0.25 },
  // Claude Opus 5.5 — the current large-tier model (see providers/anthropic*.ts
  // TIER_MODELS). CHEAPER than the Opus 5 it replaces: $4 / $20 against
  // $5 / $25. Verified 2026-09-22 against
  // platform.claude.com/docs/en/models/opus-5-5/overview.
  //
  // Its cache-read rate BREAKS the 0.1x rule the header above states: it is
  // $0.20, which is 5% of base input, not 10%. That is the vendor's own
  // published figure for this model, not a typo to "correct" back to $0.40.
  // The write tiers keep the usual ratios (1.25x / 2x).
  'claude-opus-5-5':              { input: 4.00,  output: 20.00, cacheWrite5m: 5.00,  cacheWrite1h: 8.00,  cacheRead: 0.20 },
  // Claude Opus 5 + Claude 4.x Opus. Opus 5 is priced identically to Opus 4.8
  // ($5 / $25). Verified 2026-07-24 against platform.claude.com pricing.
  // KEPT after the large tier moved to Opus 5.5: every historic llm_usage_log row
  // naming this model must keep pricing at the rate it actually ran at.
  'claude-opus-5':                { input: 5.00,  output: 25.00, cacheWrite5m: 6.25,  cacheWrite1h: 10.00, cacheRead: 0.50 },
  'claude-opus-4-8':              { input: 5.00,  output: 25.00, cacheWrite5m: 6.25,  cacheWrite1h: 10.00, cacheRead: 0.50 },
  'claude-opus-4-7':              { input: 5.00,  output: 25.00, cacheWrite5m: 6.25,  cacheWrite1h: 10.00, cacheRead: 0.50 },
  'claude-opus-4-6':              { input: 5.00,  output: 25.00, cacheWrite5m: 6.25,  cacheWrite1h: 10.00, cacheRead: 0.50 },
  'claude-opus-4-5':              { input: 5.00,  output: 25.00, cacheWrite5m: 6.25,  cacheWrite1h: 10.00, cacheRead: 0.50 },
  // Claude Sonnet 5.5 — the current medium tier (see providers/anthropic*.ts
  // TIER_MODELS). Input, output and both cache writes carry Sonnet 5's rates
  // unchanged.
  //
  // ITS CACHE READ DOES NOT, however natural it is to assume otherwise. The
  // rate is $0.10 — 5% of base input — where Sonnet 5 is $0.20 at the usual
  // 10%. The 5.5 generation moved this whole family off 0.1x (Opus 5.5 to 5%,
  // Fable 5.2 to 2.5%), so the cache read is the one rate on this row that
  // cannot be carried across from the model it succeeds, and the two point
  // releases do NOT differ here. The vendor publishes the figure twice, in the
  // model pricing table and again in the cache-hit multiplier table
  // ("Claude Sonnet 5.5 — 0.05x — $0.10 USD"), read 2026-11-12 from
  // platform.claude.com/docs/en/about-claude/pricing.
  //
  // Read as 10% it doubles what every cache read costs on the tier that caches
  // most: medium is what the three platform assistants run on and what a
  // workspace's everyday work resolves to.
  //
  // A tier move is not a repricing of what already ran: Sonnet 5 keeps its row
  // below, and so do the 4.x rows, because llm_usage_log rows naming them still
  // have to price at what they cost. An unpriced model is worse here than a
  // wrong one is elsewhere — computeRowCost falls back to the conservative
  // 'default' $3 / $15, so a missing row bills 1.5x on the busiest tier while
  // looking like a working system.
  'claude-sonnet-5-5':            { input: 2.00,  output: 10.00, cacheWrite5m: 2.50,  cacheWrite1h: 4.00,  cacheRead: 0.10 },
  // Claude Sonnet 5 — the previous medium tier, kept for the rows
  // already written against it. $2 / $10 IS the standard price; do not
  // "restore" $3 / $15.
  //
  // It was launched as introductory pricing through 2026-08-31 with an increase
  // to $3 / $15 scheduled for 2026-09-01. The table has no time-based logic, so
  // a scheduled increase tempts carrying the higher pair in advance. The
  // increase was then cancelled: platform.claude.com/docs/en/about-claude/pricing
  // states that the $2 / $10 pricing "is now the standard price" and that the
  // scheduled increase "will not occur".
  //
  // A medium tier is the default workhorse, so a stale higher pair charges 1.5x
  // on the most-travelled path.
  // Verified 2026-09-11 against platform.claude.com pricing.
  'claude-sonnet-5':              { input: 2.00,  output: 10.00, cacheWrite5m: 2.50,  cacheWrite1h: 4.00,  cacheRead: 0.20 },
  // Claude 4.x Sonnet — retained for historical llm_usage_log rows.
  'claude-sonnet-4-6':            { input: 3.00,  output: 15.00, cacheWrite5m: 3.75,  cacheWrite1h: 6.00,  cacheRead: 0.30 },
  'claude-sonnet-4-5':            { input: 3.00,  output: 15.00, cacheWrite5m: 3.75,  cacheWrite1h: 6.00,  cacheRead: 0.30 },
  // Claude Haiku 5.5 — the current small tier (see providers/anthropic*.ts
  // TIER_MODELS). Verified 2026-11-12 against
  // platform.claude.com/docs/en/models/haiku-5-5/overview.
  //
  // THE FIRST ANTHROPIC MODEL WITH A PROMPT-LENGTH BAND. Every rate on this row
  // has two values: a request whose prompt is over 100,000 tokens pays 5x input,
  // 5x output, 5x both cache writes and 5x cache reads, for the WHOLE request.
  // The override below states every key explicitly rather than deriving any of
  // them, because an absent key inherits BASE (pricing-tiers.ts) — a
  // half-written override charges the short rate for half the request.
  //
  // Three of the band's semantics are the vendor's and match pricing-tiers
  // exactly, which is why this needs no new mechanism:
  //   - STRICTLY GREATER. "over 100,000 tokens" is `promptTokens > 100_000`,
  //     and a request of exactly 100,000 pays the short rate.
  //   - THE WHOLE REQUEST, not the excess tokens.
  //   - THE THRESHOLD COUNTS CACHE. "A request's prompt length counts all of
  //     its input tokens, including cache reads and cache writes" — which is
  //     `totalPromptTokensFor`'s Anthropic branch, already
  //     input + cacheRead + cacheCreation. A request that trips the band on
  //     cache reads alone pays the long rate on all of them.
  // Each request is priced on its own: an earlier request keeps the prices it
  // was billed at, so a conversation that grows past the threshold is not
  // retroactively repriced.
  //
  // 10x CHEAPER THAN THE HAIKU 4.5 IT REPLACES ($0.10 against $1.00 input), and
  // the saving is real but not 10x: this model uses the Claude 4.7+ tokenizer,
  // so the same text counts about 30% more tokens than on Haiku 4.5. Call it
  // ~7.7x on identical prompts. The token counts land in llm_usage_log as the
  // vendor reports them, so nothing here needs to know that — it matters for
  // reading a before-and-after, not for pricing a row.
  'claude-haiku-5-5':             { input: 0.10,  output: 0.50,  cacheWrite5m: 0.125, cacheWrite1h: 0.20,  cacheRead: 0.01,
                                    overrides: [{ minPromptTokens: 100_000, input: 0.50,  output: 2.50,  cacheWrite5m: 0.625,  cacheWrite1h: 1.00,   cacheRead: 0.05 }] },
  // Claude 4.x Haiku — the previous small tier, kept for the rows
  // already written against it.
  'claude-haiku-4-5':             { input: 1.00,  output: 5.00,  cacheWrite5m: 1.25,  cacheWrite1h: 2.00,  cacheRead: 0.10 },
  'claude-haiku-4-5-20251001':    { input: 1.00,  output: 5.00,  cacheWrite5m: 1.25,  cacheWrite1h: 2.00,  cacheRead: 0.10 },
  // OpenAI GPT-6 family — the current tier ladder (providers/openai.ts
  // TIER_MODELS: astra / sol / luna). Rates are OpenAI's published per-1M
  // Standard prices, read 2026-09-23 from each model's page on
  // developers.openai.com and independently agreed by the price list at
  // developers.openai.com/api/docs/pricing.
  //
  // THE FAMILY NAMES DO NOT CARRY THEIR 5.6 MEANING ACROSS. `gpt-5.6-sol` was
  // the large tier at $4 / $20; `gpt-6-sol` is the MEDIUM tier at $2 / $10, and
  // `gpt-6-luna` is a fifth of the `gpt-5.6-luna` it succeeds. A rate copied
  // across on the strength of a shared name is a wrong rate on every row.
  //
  // One long band, published in the same words on all three model pages:
  // "Prompts with more than 272K input tokens are priced at 2x input and cache
  // rates and 1.5x output for the full request." The threshold is the same
  // 272,000 the GPT-5.6 line carries, and the override below states every rate
  // explicitly rather than deriving it — an entry that omits a key inherits
  // BASE (see pricing-tiers.ts), so a half-written override silently charges
  // the short rate for half the request.
  'gpt-6-astra':                  { input: 10.00, output: 50.00, cacheWrite5m: 12.50, cacheWrite1h: 12.50, cacheRead: 1.00,
                                    overrides: [{ minPromptTokens: 272_000, input: 20.00, output: 75.00, cacheWrite5m: 25.00,  cacheWrite1h: 25.00,  cacheRead: 2.00 }] },
  // GPT-6.1 Sol — the current medium tier, succeeding gpt-6-sol. Base input,
  // cache writes and output are IDENTICAL to its predecessor, and the long band
  // is identical too, which is what makes the one difference easy to lose:
  //
  //   ITS CACHED INPUT IS 5% OF BASE, NOT 10%. $0.10 where gpt-6-sol is $0.20,
  //   and $0.20 in the long band where gpt-6-sol is $0.40. Every sibling in this
  //   family is 10% — astra $1.00 on $10, luna $0.01 on $0.10 — so this row is
  //   the odd one out on purpose. It is the vendor's own published figure
  //   (developers.openai.com/api/docs/pricing, read 2026-09-29), the same shape
  //   as Opus 5.5's 5% cache read, and NOT a typo to correct to $0.20. Doubling
  //   it doubles what every cache read costs on the tier that caches most.
  //
  // gpt-6-sol keeps its row below: it no longer resolves, but every row already
  // written against it prices at what it actually cost.
  'gpt-6.1-sol':                  { input: 2.00,  output: 10.00, cacheWrite5m: 2.50,  cacheWrite1h: 2.50,  cacheRead: 0.10,
                                    overrides: [{ minPromptTokens: 272_000, input: 4.00,  output: 15.00, cacheWrite5m: 5.00,   cacheWrite1h: 5.00,   cacheRead: 0.20 }] },
  'gpt-6-sol':                    { input: 2.00,  output: 10.00, cacheWrite5m: 2.50,  cacheWrite1h: 2.50,  cacheRead: 0.20,
                                    overrides: [{ minPromptTokens: 272_000, input: 4.00,  output: 15.00, cacheWrite5m: 5.00,   cacheWrite1h: 5.00,   cacheRead: 0.40 }] },
  // GPT-6.1 Terra — NO TIER, and that is the fact to carry away from this row.
  // At $1 / $5 it sits BETWEEN the medium slot ($2 / $10, gpt-6.1-sol) and the
  // small one ($0.10 / $0.50, gpt-6-luna), and a tier here is an absolute
  // capability class rather than a ranking of one vendor's models against each
  // other (WORKSPACE_AI_VENDORS). It matches neither class, so it is registered
  // with a NULL tier the way Fable is: reachable when a request names it,
  // routed to by nothing.
  //
  // The name is the trap, in the opposite direction to `sol`. In the GPT-5.6
  // line `gpt-5.6-terra` WAS the medium tier, so a reader pattern-matching on
  // "terra" promotes a model nothing routes to into the slot gpt-6.1-sol holds.
  // Its branding codename stays `apollo` — the class it is nearest — which is a
  // capability label and not a claim about which slot a workspace resolves to.
  //
  // Its cached input is 5% of base, not 10%: $0.05 on $1.00, the same shape as
  // gpt-6.1-sol and for the same reason — the vendor's own page says so in
  // words ("Cached input tokens are priced at 5% of the uncached input token
  // rate"). Cache writes follow this family's convention of recording the
  // 30-minute retention figure in both write slots; the 12-hour figure is
  // $2.50, and nothing reads cacheWrite1h for attribution.
  //
  // Long band: the same 272,000 threshold and the same words as the rest of the
  // line — "priced at 2x input and cache rates and 1.5x output for the full
  // request". Verified 2026-11-12 against
  // developers.openai.com/api/docs/models/gpt-6.1-terra and agreed by the Long
  // column of developers.openai.com/api/docs/pricing.
  'gpt-6.1-terra':                { input: 1.00,  output: 5.00,  cacheWrite5m: 1.25,  cacheWrite1h: 1.25,  cacheRead: 0.05,
                                    overrides: [{ minPromptTokens: 272_000, input: 2.00,  output: 7.50,  cacheWrite5m: 2.50,   cacheWrite1h: 2.50,   cacheRead: 0.10 }] },
  'gpt-6-luna':                   { input: 0.10,  output: 0.50,  cacheWrite5m: 0.125, cacheWrite1h: 0.125, cacheRead: 0.01,
                                    overrides: [{ minPromptTokens: 272_000, input: 0.20,  output: 0.75,  cacheWrite5m: 0.25,   cacheWrite1h: 0.25,   cacheRead: 0.02 }] },
  // OpenAI GPT-5.6 family — the ladder the GPT-6 line above replaced
  // (large sol / medium terra / small luna). Rates are OpenAI's published
  // per-1M Standard prices.
  //
  // KEPT, and load-bearing rather than obsolete: every llm_usage_log row
  // already written against these three ran at these rates and must keep
  // pricing here. Deleting an entry would not fail — computeRowCost falls back
  // to the conservative default — it would silently reprice history at another
  // model's rate, on every historic row, with every surface still looking
  // healthy. Pinned by the enumerating test in __tests__/pricing.test.ts.
  //
  // Unlike the 5.4 family below, these DO charge for cache writes, so the
  // cacheWrite fields carry the published "Cache writes" column rather than 0.
  // OpenAI publishes ONE cache-write price with no TTL tiering, so the 5m and
  // 1h fields hold the same number — whichever TTL a caller reports, the rate
  // is that one.
  //
  // OpenAI publishes a SHORT-context and a LONG-context band per model. The base
  // rates here are the short band; the long band is a conditional override,
  // because a rate is a property of the REQUEST rather than of the model and
  // pricing-tiers.ts evaluates exactly that. Flattening the two into one number
  // would be wrong whichever way it went: the short rate under-attributes every
  // large prompt, and the long rate over-charges every small one.
  //
  // The 272,000 threshold is the vendor's own figure, not an inference. OpenAI's
  // price list names the two bands without saying where they meet; the boundary
  // is published as `min_prompt_tokens` on OpenAI's own serving endpoint, and
  // every one of the eight rates it publishes per model agrees with the price
  // list to the cent. Two independent sources, which is the standard migration
  // 343 sets for a number like this.
  //
  // minPromptTokens is STRICTLY greater and the reprice covers the WHOLE request
  // (see pricing-tiers.ts), which is what the vendor does: a 300k-token prompt is
  // billed entirely at the long rate, not just its excess over 272k.
  //
  // Sol's price is promotional at least through 2026-11-21. It is recorded
  // anyway, unlike the Sonnet 5 intro rate above, because there IS no published
  // standard rate to fall back to — an absent entry bills at the conservative
  // default, which is a different model's price and further from the truth.
  'gpt-5.6-sol':                  { input: 4.00,  output: 20.00, cacheWrite5m: 5.00,  cacheWrite1h: 5.00,  cacheRead: 0.40,
                                    overrides: [{ minPromptTokens: 272_000, input: 8.00, output: 30.00, cacheWrite5m: 10.00, cacheWrite1h: 10.00, cacheRead: 0.80 }] },
  'gpt-5.6-terra':                { input: 2.00,  output: 12.00, cacheWrite5m: 2.50,  cacheWrite1h: 2.50,  cacheRead: 0.20,
                                    overrides: [{ minPromptTokens: 272_000, input: 4.00, output: 18.00, cacheWrite5m: 5.00,  cacheWrite1h: 5.00,  cacheRead: 0.40 }] },
  'gpt-5.6-luna':                 { input: 0.20,  output: 1.20,  cacheWrite5m: 0.25,  cacheWrite1h: 0.25,  cacheRead: 0.02,
                                    overrides: [{ minPromptTokens: 272_000, input: 0.40, output: 1.80,  cacheWrite5m: 0.50,  cacheWrite1h: 0.50,  cacheRead: 0.04 }] },
  // OpenAI GPT-5.4 family (no cache write; cache read is discounted prompt
  // caching). Retained for historical llm_usage_log rows: the ladder left this
  // family at migration 396 and DEFAULT_MODEL with it, and `gpt-5.4` is still
  // what migration 059 stamped into every tenant's routing policy.
  'gpt-5.4':                      { input: 2.50,  output: 10.00, cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 1.25 },
  'gpt-5.4-2026-03-05':           { input: 2.50,  output: 10.00, cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 1.25 },
  'gpt-5.4-mini':                 { input: 0.15,  output: 0.60,  cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0.075 },
  'gpt-5.4-nano':                 { input: 0.10,  output: 0.40,  cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0.05 },
  // OpenAI embedding models (output tokens = 0; no cache)
  'text-embedding-3-small':       { input: 0.02,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  'text-embedding-3-large':       { input: 0.13,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  // Google Gemini via Vertex AI — the tier ladder in providers/google.ts.
  //
  // NON-GLOBAL rates, because that is the endpoint this estate calls: the
  // provider constructs VertexAI with `location: 'us-west1'`, hardcoded. Google
  // publishes a global column and a non-global column ~10% higher, and the
  // non-global prices took effect for the GA Gemini 3 families on 2026-07-01.
  // Taking the global column would under-attribute every Gemini call by that
  // 10%, in the direction this table exists to avoid. If the provider ever moves
  // to the global endpoint, these three come down with it.
  //
  // `gemini-3.1-pro-preview` is the exception and carries the GLOBAL rate: Google
  // publishes no non-global column for it, which is what a preview model served
  // only from the global endpoint looks like. The published number is recorded
  // rather than a 10% uplift inferred from its GA siblings — an inferred rate is
  // an invented one.
  //
  // The Pro band: input over 200K tokens reprices the WHOLE request, input and
  // output together, which is exactly what minPromptTokens means here (strictly
  // greater, whole request). The two Flash models publish one price for both
  // sides of that boundary, so they carry no override — an override that
  // restates the base is a claim that something changes there.
  //
  // cacheWrite is 0 across all three, and that is a real zero rather than an
  // unknown: Google's table prices "cached input" (a read discount) and charges
  // cache STORAGE by the hour, not by the written token. There is no per-token
  // write rate to record.
  //
  // Flash-Lite prices AUDIO input at double its text/image/video rate. The
  // text/image/video number is recorded because that is what this provider
  // sends — voice runs through its own lane and its own vendor map, never
  // through the Gemini chat path.
  'gemini-3.1-pro-preview':       { input: 2.00,  output: 12.00, cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0.20,
                                    overrides: [{ minPromptTokens: 200_000, input: 4.00, output: 18.00, cacheRead: 0.40 }] },
  'gemini-3.5-flash':             { input: 1.65,  output: 9.90,  cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0.165 },
  'gemini-3.1-flash-lite':        { input: 0.275, output: 1.65,  cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0.0275 },
  // Google Vertex AI embedding models. Rates verified from:
  //   https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
  //
  // gemini-embedding-001 is priced per 1K INPUT TOKENS (online prediction):
  //   $0.00015 / 1k tokens = $0.15 / 1M tokens
  // text-embedding-004 / 005 / multilingual-002 priced per 1K INPUT CHARACTERS:
  //   $0.000025 / 1k chars ≈ $0.10 / 1M tokens (using ~4 chars/token approximation,
  //   matching the GoogleEmbeddingProvider's tokenCount fallback)
  //
  // Batch-prediction API rates are cheaper ($0.00012/1k tokens for Gemini,
  // $0.00002/1k chars for text models) but we use the synchronous predict API,
  // not the asynchronous batch prediction API — so online rates apply.
  //
  // Output tokens are not billed for embedding endpoints. gemini-embedding-001
  // cost is independent of Matryoshka output dim (server-side truncation;
  // billed on input only).
  'text-embedding-004':              { input: 0.10,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  'text-embedding-005':              { input: 0.10,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  'text-multilingual-embedding-002': { input: 0.10,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  'gemini-embedding-001':            { input: 0.15,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  // Voyage embedding models — direct API path (provider='voyage' on usage rows).
  // Rates verified from https://docs.voyageai.com/docs/pricing
  // Note: voyage-4-nano is NOT a real model (was hallucinated in an earlier
  // draft of this plan). Only voyage-4, voyage-4-large, voyage-4-lite exist
  // in the voyage-4 family.
  'voyage:voyage-4-large':           { input: 0.12,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  'voyage:voyage-4':                 { input: 0.06,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  'voyage:voyage-4-lite':            { input: 0.02,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  // Older Voyage models — included for tenants/agents that explicitly select
  // them via entitlement. Not used by our defaults.
  'voyage:voyage-3.5':               { input: 0.06,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  'voyage:voyage-3.5-lite':          { input: 0.02,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  'voyage:voyage-3':                 { input: 0.06,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  'voyage:voyage-3-large':           { input: 0.18,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  'voyage:voyage-3-lite':            { input: 0.02,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  // Domain-specific Voyage models — also verified from docs.voyageai.com/docs/pricing.
  // Included so tenants selecting them via entitlement get correct cost
  // accounting. Not used by our defaults.
  'voyage:voyage-context-3':         { input: 0.18,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  'voyage:voyage-code-3':            { input: 0.18,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  'voyage:voyage-finance-2':         { input: 0.12,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  'voyage:voyage-law-2':             { input: 0.12,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  'voyage:voyage-code-2':            { input: 0.12,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },
  'voyage:voyage-multilingual-2':    { input: 0.12,  output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },

  // No `voyage-vertex:*` entries: Voyage models are NOT exposed via Google
  // Cloud Model Garden as of verification (the
  // publishers/voyageai Vertex AI API endpoint returns an empty model list).
  // Add entries here only if/when we onboard Voyage as a GCP Model Garden
  // partner. Voyage remains accessible via the direct Voyage API.

  // SHARP EDGE — Provider-aware lookup precedence:
  //   computeRowCost looks up `${provider}:${model}` first, falls back to `${model}`.
  // If both forms exist for the same model, the provider-prefixed entry wins
  // silently. Today's unprefixed `'text-embedding-3-small'` entry continues to
  // apply to OpenAI rows because no `openai:text-embedding-3-small` entry exists.
  // If someone later adds `openai:text-embedding-3-small` with a different rate,
  // the OpenAI rows immediately re-price without warning. When adding a new
  // provider-prefixed entry, either (a) match the unprefixed rate, or (b) also
  // delete the unprefixed entry.

  // GLM (Z.ai), served over OpenRouter. Keyed under the FAMILY, like its three
  // neighbours below: `openrouter:` was the gateway standing in for the vendor,
  // which is readable only while GLM is the only family under that name. It was
  // not — Qwen, DeepSeek and Kimi were under it too, and the runtime had one
  // tier map to answer all four with.
  //
  // OpenRouter passes through the routed backend's price + margin; these are
  // conservative rates (over-attribution, per this file's fail-safe-toward-
  // business philosophy), verified against the live OpenRouter models API.
  //
  // EVERY SYNCED SEED BELOW IS THE COLD-START FALLBACK, NOT THE RATE. The
  // `model_pricing` overlay supersedes it on the first background load, so a
  // seed only ever prices calls made before that load succeeds — or after one
  // fails. A stale seed is therefore invisible in normal operation and wrong
  // precisely when the overlay is unavailable, which is the worst time to be
  // wrong and the hardest moment to notice.
  //
  // Reconcile them against `model_pricing` rather than against a vendor page:
  // that table is what the sync computes (max across serving endpoints) and
  // what the overlay installs a moment later, so any other source guarantees a
  // step change in attributed cost at first load. `reportPricingCoverage` on
  // each sync run is the place that can see the gap; this table cannot.
  // The GLM-5.3 line — the current ladder. `glm-5.3-flashx` and
  // `glm-5.3-prime` are absent deliberately: both are same-size faster builds
  // that no tier names, and a rate here for a model nothing resolves to reads
  // as a model this platform serves.
  //
  // The GLM-5.3 line — the current ladder. Max across serving endpoints, read
  // from OpenRouter's endpoints API on 2026-09-25, which is the figure the sync
  // computes and installs a moment later; the catalog's headline price is the
  // CHEAPEST endpoint and differs sharply (glm-5.3 lists at 1.40/4.40 across 37
  // endpoints, glm-5.3-flash at 0.045/0.14 across 33), so seeding from it would
  // guarantee a step change in attributed cost at first load.
  'glm:z-ai/glm-5.3':         { input: 2.80, output: 8.80, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.56 },
  'glm:z-ai/glm-5.3-flash':   { input: 0.30, output: 1.00, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.07 },
  // The 5.2-and-earlier ladder. KEPT: every llm_usage_log row already written
  // against these ran at these rates and must keep pricing here.
  'glm:z-ai/glm-5.2':        { input: 2.31, output: 8.00, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.56 },
  'glm:z-ai/glm-5-turbo':    { input: 1.20, output: 4.00, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.24 },
  'glm:z-ai/glm-4.7-flash':  { input: 0.07, output: 0.40, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.01 },

  // Qwen via OpenRouter. Single-endpoint list rates (OpenRouter /models, 2026-08-04).
  //
  // Three of these carry CONDITIONAL BANDS (migration 379); modelled as flat
  // rates they are under-attributed. qwen3.7-flash is the Qwen SMALL tier and
  // its first band starts at 32,000 prompt tokens, i.e. a routine turn once
  // skills and tool results are injected, so the gap is on the common path.
  // Verified against the live endpoints API, and re-synced from it on schedule;
  // these literals are the offline/first-boot seed only.
  // Dated slug: OpenRouter publishes the large model only as `-0902` and serves no
  // bare `qwen/qwen3.8-max`. Rate is the vendor's own for that id and unchanged
  // by the rename.

  // Keyed under the family's OWN provider, not under `openrouter`.
  //
  // `computeRowCost` builds `${provider}:${model}`, and these three became
  // providers in their own right the day the vendor record gained them — the
  // control-plane registry had approved them at tier level for some time while
  // nothing could route one. A rate left under the old key would be read by
  // nothing: the lookup misses, falls through to the conservative default, and
  // every call bills at another model's price without erroring. That is the move
  // Grok needed when it split out, for the same reason.
  //
  // The `openrouter:` names still resolve, through the aliases derived below
  // rather than copies here: these models still EXECUTE on OpenRouter, so a run
  // that resolved under the gateway name is the same call at the same price, and
  // two hand-written copies of a rate with conditional bands would eventually
  // disagree about one.
  'qwen:qwen/qwen3.8-max-0902': { input: 2.00, output: 6.00, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.25 },
  'qwen:qwen/qwen3.7-plus':     { input: 0.32, output: 1.28, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.064,
    overrides: [{ minPromptTokens: 256_000, input: 0.96, output: 3.84, cacheRead: 0.192 }] },
  // 3.8 Flash is FLAT — no conditional bands, unlike the 3.7 Flash below it.
  'qwen:qwen/qwen3.8-flash':    { input: 0.15, output: 0.47, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.016 },
  'qwen:qwen/qwen3.7-flash':    { input: 0.03, output: 0.13, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.006,
    overrides: [
      { minPromptTokens:  32_000, input: 0.10, output: 0.40, cacheRead: 0.02 },
      { minPromptTokens: 256_000, input: 0.20, output: 0.80, cacheRead: 0.04 },
    ] },
  'qwen:qwen/qwen3-coder-plus': { input: 0.65, output: 3.25, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.13,
    overrides: [
      { minPromptTokens:  32_000, input: 1.17, output: 5.85, cacheRead: 0.234 },
      { minPromptTokens: 128_000, input: 1.95, output: 9.75, cacheRead: 0.39  },
    ] },

  // Grok (SpaceXAI/xAI) via OpenRouter. Base rates are the MAX across serving
  // endpoints (fail-safe-toward-business, matching the sync job), and every
  // model doubles above 200k prompt tokens — which is the common case for these
  // specifically, since the 500k/1M/2M windows are why they were selected.
  // Bands are ordered ascending by threshold, matching what the sync job emits.
  // Grok, keyed under its OWN provider and its NATIVE ids. It executes on
  // api.x.ai now, so `computeRowCost` builds `xai:grok-4.6` and a row left
  // under the old `openrouter:x-ai/...` key would be read by nothing.
  //
  // Rates are xAI's own published list (docs.x.ai/docs/models), which is where
  // they have to come from now that these bill to an xAI account rather than an
  // OpenRouter one.
  //
  // THE THRESHOLD IS 199_999 ON PURPOSE. `minPromptTokens` is STRICTLY GREATER
  // (pricing-tiers.ts note 1, which is OpenRouter's rule and is what this wire
  // shape means everywhere), while xAI's rule is "requests whose prompt REACHES
  // 200k tokens are billed at the higher rate for all tokens in the request" —
  // inclusive. 199_999 is how an inclusive 200k is spelled in an exclusive
  // field. Do not "correct" it to 200_000: that silently bills a prompt of
  // exactly 200,000 tokens at half rate.
  'xai:grok-4.6':  { input: 2.00, output: 6.00,  cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.50,
    overrides: [{ minPromptTokens: 199_999, input: 4.00, output: 12.00, cacheRead: 1.00 }] },
  'xai:grok-4.3':  { input: 1.25, output: 2.50,  cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.20,
    overrides: [{ minPromptTokens: 199_999, input: 2.50, output: 5.00,  cacheRead: 0.40 }] },
  // Keyed on the id api.x.ai actually serves; a rate under the bare `grok-4.20`
  // would be looked up by nothing.
  'xai:grok-4.20-0309-non-reasoning': { input: 1.25, output: 2.50,  cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.20,
    overrides: [{ minPromptTokens: 199_999, input: 2.50, output: 5.00,  cacheRead: 0.40 }] },

  // DeepSeek + Kimi (Moonshot) via OpenRouter. These slugs serve MANY endpoints
  // with wide spreads — rates are the MAX across endpoints (fail-safe-toward-
  // business, matching the sync job; OpenRouter /models/:slug/endpoints, 2026-08-04).
  'deepseek:deepseek/deepseek-v4-pro':   { input: 1.91, output: 3.83,  cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.33 },
  'deepseek:deepseek/deepseek-v4-flash': { input: 0.21, output: 0.70,  cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.07 },
  // v4.1-flash is the current medium/small tier; v4-flash above stays because
  // rows recorded under it are still read and still have to price as they did.
  //
  // NO `overrides`, and that is a decision rather than an omission. DeepSeek's
  // own endpoint prices this model by time of day (weekday peaks at 0.30/1.20),
  // but the eleven endpoints serving the slug run up to 0.375/1.50 flat, and a
  // band published by one endpoint cannot bind a request another served. Every
  // band it publishes therefore sits at or below the conservative max and would
  // only ever lower it — see the raise-only pass in sync-model-pricing.ts,
  // which drops them for the same reason. Max across endpoints, OpenRouter
  // /models/deepseek/deepseek-v4.1-flash/endpoints, read 2026-09-11.
  'deepseek:deepseek/deepseek-v4.1-flash': { input: 0.375, output: 1.50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.03 },
  'kimi:moonshotai/kimi-k3':         { input: 6.00, output: 22.50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.60 },
  'kimi:moonshotai/kimi-k2.6':       { input: 1.09, output: 4.60,  cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.37 },

  // MiniMax via OpenRouter. Same max-across-endpoints convention (OpenRouter
  // /models/:slug/endpoints, 2026-09-11). Two tiers: the small tier resolves to
  // the medium model, so it needs no rate of its own.
  //
  // No `overrides` on either, and here that is simply the vendor: MiniMax
  // publishes no conditional band on any model it serves.
  // Rates are the CONSERVATIVE max across OpenRouter's serving endpoints, which
  // is what sync-model-pricing writes and what these seeds must mirror. The
  // models-list `pricing` field is the DEFAULT endpoint, not the ceiling: for
  // minimax it reads $0.30 / $1.20 while endpoints range to $0.60 / $2.40 and
  // higher, so seeding from it under-attributes every call the router sends to
  // a dearer endpoint. Take the max from /models/:slug/endpoints, never the
  // models list.
  // Xiaomi MiMo via OpenRouter. Max across serving endpoints, read 2026-09-25.
  //
  // MAX, not the catalog headline, because that is what the sync writes and a
  // seed that disagrees makes attributed cost STEP the moment the overlay first
  // loads. Pro is served by three endpoints — GMICloud, DeepInfra and Xiaomi —
  // which agree on input and output and not on cache reads: GMICloud quotes
  // 0.004 where the other two quote 0.0036, so 0.004 is the rate. The endpoint
  // SET is what moves here, not any one vendor's price list.
  // `mimo-v2.6-pro-ultraspeed` is deliberately unpriced here: nothing resolves
  // to it, and a rate in this table for a model no tier names would be read as
  // a model this platform serves.
  'xiaomi:xiaomi/mimo-v2.6-pro':   { input: 0.435, output: 0.87, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.004 },
  'xiaomi:xiaomi/mimo-v2.6-flash': { input: 0.14,  output: 0.28, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.0028 },
  'minimax:minimax/minimax-m3':   { input: 0.75, output: 3.00, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.15 },
  'minimax:minimax/minimax-m2.7': { input: 0.60, output: 2.40, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.07 },

  // TypeSafe's Jev (src/typesafe/): input-only classification, $0.042 per 1M
  // input tokens and $0 output. The vendor reports an output_tokens count on
  // every response and prices it at zero; the count is still recorded. Read
  // from docs.typesafe.ai/models on 2026-09-21. Keyed on the pinned concrete
  // id (questions.ts TYPESAFE_MODEL); a drifted response is rejected before it
  // is used, so no other id lands in a row under this provider.
  'typesafe:jev-1.13.0':          { input: 0.042, output: 0,     cacheWrite5m: 0,     cacheWrite1h: 0,     cacheRead: 0 },

  // Legacy rows where model was not recorded — price conservatively as Sonnet
  'default':                      { input: 3.00,  output: 15.00, cacheWrite5m: 3.75,  cacheWrite1h: 6.00,  cacheRead: 0.30 },
};

// The same rate under the gateway name, derived rather than copied.
//
// GLM, Qwen, DeepSeek and Kimi are providers in their own right and are keyed
// that way above, but they still EXECUTE on OpenRouter — so a row that recorded
// the gateway name is the same call at the same price.
//
// Two kinds of row need it. Rows already written, because migration 450 moves
// stored CONFIGURATION forward and a usage row is a record of what ran, not a
// thing to rewrite. And rows this platform still writes: OpenRouterProvider is
// PB's own client for the gateway, and a call it makes is a call to OpenRouter
// — that one is not legacy and does not age out. Derived because
// several of these carry conditional rate bands, and two hand-written copies of
// a banded rate eventually disagree about one of the bands, which is the kind of
// difference that shows up as a reconciliation gap rather than an error.
for (const [key, rate] of Object.entries(MODEL_PRICING)) {
  const [provider, ...rest] = key.split(':');
  if (!OPENROUTER_HOSTED_PROVIDERS.includes(provider)) continue;
  const gatewayKey = `openrouter:${rest.join(':')}`;
  if (!MODEL_PRICING[gatewayKey]) MODEL_PRICING[gatewayKey] = rate;
}


// ── DB-sourced rate overlay (Phase 1: model-pricing sync) ───────────────────
// Synced open-weights rates loaded from the `model_pricing` table (migration 285)
// by src/llm/model-pricing-loader.ts on a background TTL refresh. Keyed
// 'provider:model_id'. computeRowCost consults this FIRST and falls back to the
// hardcoded MODEL_PRICING above when a row is absent (offline / first boot /
// non-synced providers such as anthropic/openai/google). null until first load.
let dbRates: Map<string, ModelPricing> | null = null;

/** Install (or clear, with null) the DB-sourced rate map. Called by the loader. */
export function setModelPricingRates(rates: Map<string, ModelPricing> | null): void {
  dbRates = rates;
}

/** The pricing keys `computeRowCost` would look a model up under, in the order
 *  it tries them: the provider-qualified key, then the bare model key the
 *  direct-API entries use.
 *
 *  Exported because three callers need the SAME order and a second copy is how
 *  they start disagreeing — the registry's approval gate, the sync job's
 *  coverage report, and this file's own lookup. It lived in
 *  scripts/sync-model-pricing.ts until the gate needed it too. */
export function pricingKeysFor(provider: string, modelId: string): string[] {
  return [`${provider}:${modelId}`, modelId];
}

/** Whether this estate publishes a STATIC rate for a model.
 *
 *  Static only: the `model_pricing` table is the other half and needs a
 *  database, so a caller that can reach one checks both. Deliberately not
 *  consulting `dbRates` — that overlay is null until the first background load,
 *  so a question asked at boot would get a different answer than the same
 *  question asked a minute later. */
export function hasStaticRate(provider: string, modelId: string): boolean {
  return pricingKeysFor(provider, modelId).some((key) => MODEL_PRICING[key] !== undefined);
}

/** Returns the cost in USD for a single llm_usage_log row. An unknown model
 *  is a code defect that must be fixed (a pricing entry is missing), so it is
 *  logged at error level — but we bill it conservatively at the `'default'`
 *  (Sonnet) rate rather than returning 0. Returning 0 silently under-charges
 *  for every row of an unpriced/NULL model, leaking revenue; conservative
 *  fallback pricing fails safe toward the business while the error log drives
 *  the real fix (adding the missing model). */
export function computeRowCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  at: Date,
): number {
  // Grok is priced under xAI's own id, and configurations written before it left
  // OpenRouter still carry the publisher slug. Without this, `xai:x-ai/grok-4.3`
  // misses every table and the row bills at the conservative Sonnet default —
  // a rate that has nothing to do with the model that ran.
  //
  // Scoped to the xai provider so the other OpenRouter-hosted vendors keep their
  // namespaced keys (`z-ai/glm-5.2`, `qwen/...`), which is where they still bill.
  const model_ = provider === 'xai' ? model.replace(/^x-ai\//, '') : model;

  // Provider-aware lookup. Lets the same model name carry distinct rates
  // across billing surfaces (Voyage direct vs Voyage-via-Vertex Model Garden).
  // Falls back to the model-only key for existing entries (Anthropic, OpenAI,
  // legacy Google).
  const exact =
    dbRates?.get(`${provider}:${model_}`) ??
    MODEL_PRICING[`${provider}:${model_}`] ??
    MODEL_PRICING[model_];
  if (!exact) {
    log.error(
      { provider, model, inputTokens, outputTokens },
      'Unknown model in llm_usage_log — add pricing entry to MODEL_PRICING in src/llm/pricing.ts. Billing this row at the conservative default (Sonnet) rate to avoid under-charging.',
    );
  }
  const base = exact ?? MODEL_PRICING['default'];

  // Resolve conditional overrides BEFORE the arithmetic. The threshold is
  // measured against TOTAL prompt tokens (which for the OpenAI-wire providers
  // already includes the cached portion), not against the fresh-input figure
  // billed below — conflating the two would trip a threshold late on every
  // cache-heavy request.
  const promptTokens = totalPromptTokensFor(provider, inputTokens, cacheReadTokens, cacheCreationTokens);
  const pricing = effectivePricing(base, base.overrides, { promptTokens, at });

  // Fresh input only. OpenAI/OpenRouter/Google report `prompt_tokens` INCLUSIVE
  // of the cached portion and report that portion again separately, so billing
  // `inputTokens` in full alongside `cacheReadTokens` charges the cached tokens
  // twice — once at the full input rate and once at the cache-read rate — and
  // makes this plane disagree with the tenant-runtime, which subtracts
  // correctly, on the cost of the same call.
  // Anthropic rows are unaffected: their input_tokens is already exclusive.
  const freshInputTokens = freshInputTokensFor(provider, inputTokens, cacheReadTokens);

  return (
    (freshInputTokens    * pricing.input        / 1_000_000) +
    (outputTokens        * pricing.output       / 1_000_000) +
    (cacheCreationTokens * pricing.cacheWrite5m / 1_000_000) +
    (cacheReadTokens     * pricing.cacheRead    / 1_000_000)
  );
}
