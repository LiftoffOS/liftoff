// Conditional pricing overrides — the "tiered pricing" evaluator.
//
// MIRROR of platform-backend's src/llm/pricing-tiers.ts. The condition
// semantics below (applies / inUtcWindow / toHhmmUtc / totalPromptTokensFor)
// are intentionally identical line for line; only `effectivePricing` differs,
// because this repo's ModelPricing spells its fields *PricePerMillion. A
// parity test in each repo pins the two together — if these drift, the control
// plane and the runtime bill different amounts for the same call, which is the
// precise failure this file exists to prevent.
//
// PricingOverride is the WIRE shape: platform-backend stores it in
// model_pricing.pricing_overrides and serves it verbatim over
// GET /api/internal/model-registry, so this interface must not be "tidied" into
// a different field spelling on one side only.
//
// Five semantics are counterintuitive and each is load-bearing. Verified
// against openrouter.ai/docs, NOT inferred from the response shape:
//
//   1. `min_prompt_tokens` is STRICTLY GREATER. A prompt of exactly 200,000
//      does NOT trigger a 200,000 override.
//   2. The override is a WHOLE-REQUEST reprice, not a graduated/marginal rate.
//      A 300k request over a 200k threshold bills ALL 300k at the override
//      rate. The tell: overrides restate `completion`, which has nothing to do
//      with prompt length.
//   3. Applicable entries FOLD per key in array order (later wins); keys absent
//      from an entry inherit BASE, not zero and not the previous entry.
//   4. UTC windows are half-open [utcStart, utcEnd) in HHMM clock ints and WRAP
//      past midnight when utcStart > utcEnd.
//   5. `utcDays` confines an entry to named UTC weekdays — "applies only on
//      these UTC weekdays, evaluated at the request instant" — AND-ed with the
//      window rather than folded into it. Reading an entry without its day list
//      does not lose a condition, it WIDENS one: a weekday-only peak band then
//      charges the peak rate on a Saturday too. DeepSeek V4.1 Flash is the
//      first model here priced by time of day.

/** One conditional override entry. Wire shape — see the header before renaming.
 *
 *  Rate fields are independently optional: an omitted key inherits base rather
 *  than defaulting to zero. They are `?: number` rather than `: number` with a
 *  0 default precisely because 0 is a real published rate (OpenRouter serves
 *  genuine $0 cache-write rates) and must not be confused with "unspecified". */
export interface PricingOverride {
  /** Applies when total prompt tokens are STRICTLY GREATER than this. */
  minPromptTokens?: number;
  /** Inclusive start of a daily UTC window, HHMM clock int (1630 = 16:30). */
  utcStart?: number;
  /** Exclusive end of a daily UTC window, HHMM clock int. */
  utcEnd?: number;
  /** UTC weekdays this entry is confined to, spelled as the vendor serves them
   *  ("monday" … "sunday"). Absent means every day; present means ONLY these. */
  utcDays?: string[];
  input?: number;
  output?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheRead?: number;
}

/** Context a request is priced against. Both fields REQUIRED, neither defaulted:
 *  `promptTokens` is TOTAL prompt tokens (not the fresh-input figure the cost
 *  arithmetic multiplies), and `at` is when the CALL happened, never now() —
 *  pricing a historical row against today's UTC window is wrong in a way no
 *  test running inside one window would catch. */
export interface PricingContext {
  promptTokens: number;
  at: Date;
}

/** Rate fields an override may replace, in this repo's spelling. */
interface TieredRates {
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cachedInputPricePerMillion: number | null;
  cacheWrite5mPricePerMillion?: number | null;
  cacheWrite1hPricePerMillion?: number | null;
}

/** Is an HHMM clock int inside the half-open window [start, end)?
 *  A window whose end is not after its start wraps past midnight, so it is the
 *  UNION of [start, 2400) and [0, end) rather than an empty range. */
function inUtcWindow(nowHhmm: number, start: number, end: number): boolean {
  if (start === end) return false; // zero-width window matches nothing
  if (start < end) return nowHhmm >= start && nowHhmm < end;
  return nowHhmm >= start || nowHhmm < end;
}

/** HHMM clock int for a Date, in UTC. 16:30 → 1630. */
function toHhmmUtc(at: Date): number {
  return at.getUTCHours() * 100 + at.getUTCMinutes();
}

/** Indexed by Date#getUTCDay (0 = Sunday), spelled as the vendor spells them. */
const UTC_DAY_NAMES = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
] as const;

/** Does every condition this entry declares match the request? */
function applies(o: PricingOverride, ctx: PricingContext): boolean {
  // STRICTLY greater — see note 1 in the header. Do not "fix" to >=.
  if (o.minPromptTokens != null && !(ctx.promptTokens > o.minPromptTokens)) return false;
  if (o.utcStart != null || o.utcEnd != null) {
    // A half-specified window is not a window. Non-matching rather than
    // guessing the missing bound, which would apply a rate never quoted.
    if (o.utcStart == null || o.utcEnd == null) return false;
    if (!inUtcWindow(toHhmmUtc(ctx.at), o.utcStart, o.utcEnd)) return false;
  }
  if (o.utcDays != null) {
    // An empty list names no day and so matches nothing — the same reading the
    // half-specified window gets above. Case-insensitive: the value is the
    // vendor's own string.
    const today = UTC_DAY_NAMES[ctx.at.getUTCDay()];
    if (!o.utcDays.some((d) => d.toLowerCase() === today)) return false;
  }
  return true;
}

/** Fold every applicable override onto the base rates, in array order, with
 *  last-writer-wins PER KEY and absent keys inheriting base.
 *
 *  Returns `base` unchanged when nothing applies, so a model with no overrides
 *  prices exactly as it did before this module existed. */
export function effectivePricing<T extends TieredRates>(
  base: T,
  overrides: PricingOverride[] | undefined,
  ctx: PricingContext,
): T {
  if (!overrides || overrides.length === 0) return base;

  let result: T | null = null;
  for (const o of overrides) {
    if (!applies(o, ctx)) continue;
    // Copy lazily: an override array whose entries all fail leaves `base`
    // untouched and allocation-free on the hot path.
    if (result === null) result = { ...base };
    // `!= null` rather than truthiness because 0 is a legitimate rate.
    if (o.input        != null) result.inputPricePerMillion        = o.input;
    if (o.output       != null) result.outputPricePerMillion       = o.output;
    if (o.cacheRead    != null) result.cachedInputPricePerMillion  = o.cacheRead;
    if (o.cacheWrite5m != null) result.cacheWrite5mPricePerMillion = o.cacheWrite5m;
    if (o.cacheWrite1h != null) result.cacheWrite1hPricePerMillion = o.cacheWrite1h;
  }
  return result ?? base;
}

/** TOTAL prompt tokens for an invocation, per the provider's token-reporting
 *  convention. This is the basis `minPromptTokens` is measured against, and it
 *  is deliberately NOT the same quantity `calculateCost` multiplies:
 *
 *    - Anthropic (direct and via Vertex) reports `input_tokens` EXCLUSIVE of
 *      cache reads/writes; the three are disjoint, so the total is their sum.
 *    - OpenAI, OpenRouter and Google report a prompt total that ALREADY
 *      INCLUDES the cached portion. Adding the cache figure here would
 *      double-count it and trip a threshold early.
 *
 *  The complement of freshInputTokensFor in pricing.ts, and deliberately
 *  sharing its provider switch so the two readings of one row cannot drift. */
export function totalPromptTokensFor(
  provider: string,
  inputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens = 0,
): number {
  if (provider === 'anthropic' || provider === 'anthropic-vertex') {
    return inputTokens + cacheReadTokens + cacheCreationTokens;
  }
  return inputTokens;
}
