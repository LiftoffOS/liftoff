// Conditional pricing overrides — the "tiered pricing" evaluator.
//
// OpenRouter models may carry a `pricing.overrides` array that REPLACES base
// rates when the request matches a condition: a prompt-token threshold
// (long-context pricing) or a daily UTC window (time-of-day pricing). Until
// this module existed the sync job read only the top-level rates and
// computeRowCost applied them flat, so every request over a threshold was
// under-attributed — silently, in the one direction that costs the business
// money. Three Qwen models we already serve have thresholds today
// (qwen3.7-flash from 32k, qwen3-coder-plus from 32k, qwen3.7-plus from 256k)
// and every Grok model doubles above 200k.
//
// Five semantics here are counterintuitive and each one is load-bearing.
// Verified against openrouter.ai/docs (guides/overview/models and the
// list-all-models API reference), NOT inferred from the response shape:
//
//   1. `min_prompt_tokens` is STRICTLY GREATER. "applies when the total prompt
//      tokens of a request are strictly greater than this threshold". A prompt
//      of exactly 200,000 does NOT trigger a 200,000 override. Using >= here
//      would over-charge every request that lands exactly on a boundary.
//
//   2. The override is a WHOLE-REQUEST reprice, not a graduated/marginal rate.
//      A 300k-token request over a 200k threshold bills ALL 300k at the
//      override rate, not 200k at base plus 100k at the override. The decisive
//      tell is that overrides restate `completion`, which has nothing to do
//      with prompt length — that only makes sense if the entry replaces the
//      whole rate card.
//
//   3. Applicable entries FOLD, they do not select. "among applicable entries,
//      later entries win per price key; price keys absent from an entry inherit
//      the base price." So this is a per-key reduce in array order, not a
//      "pick the highest matching band" lookup. An entry that sets only
//      `prompt` leaves `completion` at BASE, not at zero and not at the
//      previous entry's value.
//
//   4. UTC windows are half-open [utcStart, utcEnd) in HHMM clock ints, and
//      WRAP past midnight when utcStart > utcEnd.
//
//   5. `utcDays` confines an entry to named UTC weekdays — "applies only on
//      these UTC weekdays, evaluated at the request instant" — and is AND-ed
//      with the window rather than folded into it. Reading an entry without
//      its day list does not lose a condition, it WIDENS one: a weekday-only
//      peak band then charges the peak rate on a Saturday as well.
//
// DeepSeek V4.1 Flash is the first model we serve that is priced by time of
// day; the Qwen and Grok bands are all token thresholds. The window half of
// this schema was implemented before anything needed it, for the reason that
// still holds: handling half of a vendor schema is precisely how the
// token-threshold half came to be missed for months.
//
// Pure and dependency-free on purpose — src/llm/pricing.ts is imported by both
// cost-attribution ingesters and insights data providers and must stay free of
// DB/logging imports. The tenant-runtime carries a byte-equivalent mirror of
// this file so the two planes cannot price the same call differently; a parity
// test in each repo pins them together.

/** Per-million rates. Structurally the subset of ModelPricing an override may
 *  replace, in OUR per-million units — never OpenRouter's per-token units.
 *  The conversion happens once, in the sync job. */
export interface PricingRates {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

/** One conditional override entry, normalized from OpenRouter's wire shape.
 *
 *  Conditions are AND-ed: an entry applies only when EVERY condition field it
 *  declares matches. An entry with no condition fields at all applies
 *  unconditionally (the vendor permits it; treat it as a base replacement).
 *
 *  Rate fields are all optional and independently absent — an omitted key
 *  inherits base rather than defaulting to zero. That distinction is why every
 *  rate field is `?: number` and not `: number` with a 0 default: a 0 rate is a
 *  real, meaningful value (OpenRouter publishes genuine $0 cache-write rates)
 *  and must not be confused with "not specified". */
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

/** Context a request is priced against. Both fields are REQUIRED and neither
 *  has a sensible default:
 *
 *  - `promptTokens` is TOTAL prompt tokens (see totalPromptTokensFor) — the
 *    basis the vendor's threshold is measured against, which is not the same
 *    number as the "fresh input" figure the cost arithmetic multiplies.
 *
 *  - `at` is when the CALL happened, never when the pricing ran. Defaulting it
 *    to now() would price a backfill of last month's rows against today's UTC
 *    window, which is wrong in a way no test that runs inside one window would
 *    ever catch. Both PB ingesters already select the row timestamp. */
export interface PricingContext {
  promptTokens: number;
  at: Date;
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
    // A half-specified window is not a window. Treat it as non-matching rather
    // than guessing the missing bound: guessing would silently apply a rate the
    // vendor never quoted.
    if (o.utcStart == null || o.utcEnd == null) return false;
    if (!inUtcWindow(toHhmmUtc(ctx.at), o.utcStart, o.utcEnd)) return false;
  }
  if (o.utcDays != null) {
    // An empty list names no day and so matches nothing — the same reading the
    // half-specified window gets above, not a special case. Compared
    // case-insensitively because the value is the vendor's own string.
    const today = UTC_DAY_NAMES[ctx.at.getUTCDay()];
    if (!o.utcDays.some((d) => d.toLowerCase() === today)) return false;
  }
  return true;
}

/** Fold every applicable override onto the base rates, in array order, with
 *  last-writer-wins PER KEY and absent keys inheriting base.
 *
 *  Returns `base` unchanged (same values, new object) when nothing applies, so
 *  a model with no overrides prices exactly as it did before this module
 *  existed. That equivalence is pinned by a regression test — it is what makes
 *  this change additive for Anthropic, OpenAI and Google. */
export function effectivePricing<T extends PricingRates>(
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
    // Assign per key, and only when the key is PRESENT on the entry. A missing
    // key inherits base (note 3); `!= null` rather than truthiness because 0 is
    // a legitimate published rate.
    if (o.input        != null) result.input        = o.input;
    if (o.output       != null) result.output       = o.output;
    if (o.cacheWrite5m != null) result.cacheWrite5m = o.cacheWrite5m;
    if (o.cacheWrite1h != null) result.cacheWrite1h = o.cacheWrite1h;
    if (o.cacheRead    != null) result.cacheRead    = o.cacheRead;
  }
  return result ?? base;
}

/** TOTAL prompt tokens for a usage row, per the provider's token-reporting
 *  convention. This is the basis `min_prompt_tokens` is measured against, and
 *  it is deliberately NOT the same quantity the cost arithmetic multiplies:
 *
 *    - Anthropic (direct and via Vertex) reports `input_tokens` EXCLUSIVE of
 *      cache reads and cache writes; the three are disjoint, so the total is
 *      their sum.
 *    - OpenAI, OpenRouter and Google report a prompt total that ALREADY
 *      INCLUDES the cached portion, reported again separately for the discount.
 *      Adding the cache figure here would double-count it and trip a threshold
 *      early.
 *
 *  Shares its provider switch with the fresh-input convention used by
 *  computeRowCost (and by the tenant-runtime's freshInputTokensFor) so the two
 *  readings of the same row cannot drift apart. */
export function totalPromptTokensFor(
  provider: string,
  inputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number {
  if (provider === 'anthropic' || provider === 'anthropic-vertex') {
    return inputTokens + cacheReadTokens + cacheCreationTokens;
  }
  return inputTokens;
}

/** FRESH (uncached, unwritten) input tokens — the quantity billed at the input
 *  rate, as opposed to the total above.
 *
 *  Anthropic's `input_tokens` is already fresh. For the OpenAI-wire providers
 *  the cached portion is included in the prompt total and is billed separately
 *  at the (cheaper) cache-read rate, so it must be subtracted out; billing the
 *  full prompt AND the cache read charges the cached tokens twice.
 *
 *  Clamped at zero. The runtime hit exactly this: an Anthropic row with
 *  input=3, cached=11040 produced freshInput=-11037 and a NEGATIVE cost. The
 *  clamp plus the provider switch is why that cannot recur here. */
export function freshInputTokensFor(
  provider: string,
  inputTokens: number,
  cacheReadTokens: number,
): number {
  if (provider === 'anthropic' || provider === 'anthropic-vertex') {
    return inputTokens;
  }
  return Math.max(0, inputTokens - cacheReadTokens);
}
