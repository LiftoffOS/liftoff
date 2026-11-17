// composePlanDisplay tests — verifies that the JOIN-row → (planName, priceUsd)
// composition handles the four shapes the standard JOIN can return:
//   1. Self-serve plans (Core/Growth/Scale) — plan_catalog row present, no enterprise_contracts row
//   2. Enterprise with annual_total_usd_cents — bypass per-OU math
//   3. Enterprise without annual_total — compute from included + precommit rates × OUs
//   4. Missing plan_catalog row (deleted or unknown plan_type) — fall back to 'Liftoff'

import { composePlanDisplay, type PlanRow } from '../plan-display';

function baseRow(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    email: 'ada@example.com',
    first_name: 'Ada',
    plan_type: null,
    billing_tier: 'standard',
    plan_included_ous: 0,
    is_annual_plan: false,
    self_serve_display_name: null,
    self_serve_price_cents: null,
    enterprise_annual_cents: null,
    enterprise_included_ous: null,
    enterprise_included_rate: null,
    enterprise_precommit_ous: null,
    enterprise_precommit_rate: null,
    ...overrides,
  };
}

describe('composePlanDisplay', () => {
  it('returns plan_catalog display_name + price for self-serve Core', () => {
    const out = composePlanDisplay(
      baseRow({
        plan_type: 'core',
        billing_tier: 'standard',
        self_serve_display_name: 'Core',
        self_serve_price_cents: 2000,
      }),
    );
    expect(out.planName).toBe('Core');
    expect(out.planPriceUsd).toBeCloseTo(20.0, 2);
  });

  it('returns Growth ($50) and Scale ($200) prices from catalog cents', () => {
    expect(
      composePlanDisplay(
        baseRow({
          plan_type: 'growth',
          self_serve_display_name: 'Growth',
          self_serve_price_cents: 5000,
        }),
      ).planPriceUsd,
    ).toBeCloseTo(50.0, 2);

    expect(
      composePlanDisplay(
        baseRow({
          plan_type: 'scale',
          self_serve_display_name: 'Scale',
          self_serve_price_cents: 20000,
        }),
      ).planPriceUsd,
    ).toBeCloseTo(200.0, 2);
  });

  it('returns Enterprise + monthly price from annual_total_usd_cents (divided by 12)', () => {
    const out = composePlanDisplay(
      baseRow({
        billing_tier: 'enterprise',
        plan_type: null,
        enterprise_annual_cents: 1_200_000, // $12,000/year → $1,000/month
      }),
    );
    expect(out.planName).toBe('Enterprise');
    expect(out.planPriceUsd).toBeCloseTo(1000.0, 2);
  });

  it('returns Enterprise + computed monthly price when annual_total is absent', () => {
    // 1000 included OUs × $0.50/OU + 500 precommit OUs × $0.40/OU = $700
    const out = composePlanDisplay(
      baseRow({
        billing_tier: 'enterprise',
        plan_type: null,
        enterprise_annual_cents: null,
        enterprise_included_ous: 1000,
        enterprise_included_rate: 0.5,
        enterprise_precommit_ous: 500,
        enterprise_precommit_rate: 0.4,
      }),
    );
    expect(out.planName).toBe('Enterprise');
    expect(out.planPriceUsd).toBeCloseTo(700.0, 2);
  });

  it('falls back to "Liftoff" + $0 when plan_catalog row is missing', () => {
    const out = composePlanDisplay(
      baseRow({
        plan_type: 'unknown',
        billing_tier: 'standard',
        self_serve_display_name: null,
        self_serve_price_cents: null,
      }),
    );
    expect(out.planName).toBe('Liftoff');
    expect(out.planPriceUsd).toBe(0);
  });

  it('handles string numerics (pg numeric columns) without precision loss', () => {
    // pg returns NUMERIC columns as strings. Verify Number() coercion works.
    const out = composePlanDisplay(
      baseRow({
        billing_tier: 'enterprise',
        plan_type: null,
        enterprise_annual_cents: '1200000' as unknown as string,
        enterprise_included_ous: '0' as unknown as string,
        enterprise_included_rate: '0' as unknown as string,
        enterprise_precommit_ous: '0' as unknown as string,
        enterprise_precommit_rate: '0' as unknown as string,
      }),
    );
    // 1,200,000 cents annual ÷ 12 = 100,000 cents/month = $1,000.00
    expect(out.planPriceUsd).toBeCloseTo(1000.0, 2);
  });
});
