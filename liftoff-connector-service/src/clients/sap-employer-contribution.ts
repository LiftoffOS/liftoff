// Pure SAP Global Benefits employer-contribution math — kept in its own module (no logging /
// telemetry imports) so it is unit-testable without loading the OData client stack.

/** One band of a tiered/banded employer match: the employer matches the portion of the base
 *  (the employee's own contribution) that falls within this tier at `matchPercent`. */
export interface SapMatchTier {
  /** Cumulative upper threshold of the base this tier covers (null/undefined = no upper bound). */
  upTo?: number | null;
  /** Employer match rate (percent) applied to the portion of the base within this tier. */
  matchPercent: number;
}

/** SAP Global Benefits employer-contribution config, as read from PensionEmployerContributionDetail
 *  (+ the savings ER config, BenefitPensionMinMaxContributionLimits, and banding configuration). */
export interface SapEmployerContributionConfig {
  type?: string;                        // employerContributionType (amount | percentage | rule)
  amount?: unknown;                     // employerContributionAmount
  percentage?: unknown;                 // employerContributionPercentage
  statutoryMinimumAmount?: unknown;     // employerStatutoryMinimumAmount
  statutoryMinimumPercentage?: unknown; // employerStatutoryMinimumPercentage
  minAmount?: unknown;                  // BenefitPensionMinMaxContributionLimits — employer floor
  maxAmount?: unknown;                  // BenefitPensionMinMaxContributionLimits — employer cap
  tiers?: SapMatchTier[];               // banded/tiered match (rule type)
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Employer match over a tiered/banded schedule applied to `base` (the employee's contribution).
 *  Each tier matches the slice of the base between the previous threshold and its own `upTo`. */
export function tieredMatch(tiers: SapMatchTier[], base: number): number {
  const sorted = tiers
    .filter((t) => Number.isFinite(t.matchPercent))
    .sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  let prev = 0;
  let total = 0;
  for (const t of sorted) {
    const cap = t.upTo == null ? base : Math.min(base, t.upTo);
    const portion = Math.max(0, cap - prev);
    total += (t.matchPercent / 100) * portion;
    prev = cap;
    if (prev >= base) break;
  }
  return total;
}

/**
 * Compute an employee's per-period employer benefit contribution from SAP Global Benefits
 * employer-contribution config applied to that employee's contribution base (their own
 * per-period contribution / pensionable pay). SAP expresses the employer share three ways via
 * employerContributionType:
 *   - a fixed AMOUNT (employerContributionAmount) → used directly;
 *   - a PERCENTAGE (employerContributionPercentage) → percentage × base;
 *   - a RULE (banded/tiered) → a tiered match over the base (see tieredMatch), from the plan's
 *     banding configuration.
 * The computed value is then clamped to the plan's [minAmount, maxAmount] contribution limits and
 * floored to any statutory minimum. Returns null when nothing definitive can be produced.
 * The percentage/tier BASE (employee contribution vs pensionable pay) is tenant/rule-defined; we
 * apply it to the supplied `base`. This computation needs live-tenant validation (auth-gated).
 */
export function computeSapEmployerContribution(cfg: SapEmployerContributionConfig, base: number): number | null {
  const type = String(cfg.type ?? '').toLowerCase();
  const amount = num(cfg.amount);
  const pct = num(cfg.percentage);
  const minAmt = num(cfg.minAmount);
  const maxAmt = num(cfg.maxAmount);
  const statAmt = num(cfg.statutoryMinimumAmount);
  const statPct = num(cfg.statutoryMinimumPercentage);

  // 1) Base computation by contribution type.
  let computed: number | null = null;
  if (cfg.tiers && cfg.tiers.length > 0 && base > 0) {
    computed = tieredMatch(cfg.tiers, base);            // rule / banded
  } else if ((type.includes('amount') || (amount != null && pct == null)) && amount != null) {
    computed = amount;                                  // fixed amount
  } else if ((type.includes('percent') || pct != null) && pct != null && base > 0) {
    computed = (pct / 100) * base;                      // flat percentage
  }

  // 2) Clamp to the plan's min/max contribution limits.
  if (computed != null) {
    if (maxAmt != null) computed = Math.min(computed, maxAmt);
    if (minAmt != null) computed = Math.max(computed, minAmt);
  }

  // 3) Floor to the statutory minimum (a legal floor wins over everything, even a null computation).
  let out = computed;
  if (statAmt != null) out = out == null ? statAmt : Math.max(out, statAmt);
  if (statPct != null && base > 0) { const sp = (statPct / 100) * base; out = out == null ? sp : Math.max(out, sp); }
  return out;
}
