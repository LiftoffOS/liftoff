// Plan display composition — used by notify helpers in billing-controls-internal-router.ts
// (subscription-confirmation, subscription-ending, subscription-ended, receipt,
// agents-stalled, card-expiring) to produce a user-facing plan name and monthly
// price from canonical schema (plan_catalog for self-serve, enterprise_contracts
// for enterprise).
//
// Verified against migrations/209_ou_native_billing.sql: every Enterprise
// contract is bespoke and intentionally NOT in plan_catalog. Detection:
//   billing_controls.billing_tier='enterprise' AND billing_controls.plan_type IS NULL.

export interface PlanRow {
  email: string;
  first_name: string | null;
  plan_type: string | null;
  billing_tier: string;
  plan_included_ous: string | number;
  is_annual_plan: boolean;
  self_serve_display_name: string | null;
  self_serve_price_cents: string | number | null;
  enterprise_annual_cents: string | number | null;
  enterprise_included_ous: string | number | null;
  enterprise_included_rate: string | number | null;
  enterprise_precommit_ous: string | number | null;
  enterprise_precommit_rate: string | number | null;
}

export const STANDARD_PLAN_JOIN_SQL = `
  SELECT
    a.email, a.first_name,
    bc.plan_type, bc.billing_tier, bc.plan_included_ous, bc.is_annual_plan,
    pc.display_name              AS self_serve_display_name,
    pc.base_price_usd_cents      AS self_serve_price_cents,
    ec.annual_total_usd_cents    AS enterprise_annual_cents,
    ec.included_ous              AS enterprise_included_ous,
    ec.included_rate_usd_per_ou  AS enterprise_included_rate,
    ec.precommit_extra_ous       AS enterprise_precommit_ous,
    ec.precommit_rate_usd_per_ou AS enterprise_precommit_rate
  FROM accounts a
  JOIN billing_controls bc          ON bc.account_id = a.id
  LEFT JOIN plan_catalog pc         ON pc.id = bc.plan_type
  LEFT JOIN enterprise_contracts ec ON ec.account_id = a.id
  WHERE a.id = $1
`;

export function composePlanDisplay(row: PlanRow): { planName: string; planPriceUsd: number } {
  if (row.billing_tier === 'enterprise') {
    const monthlyCents = row.enterprise_annual_cents != null
      ? Math.round(Number(row.enterprise_annual_cents) / 12)
      : Math.round(
          (Number(row.enterprise_included_ous ?? 0) * Number(row.enterprise_included_rate ?? 0) +
           Number(row.enterprise_precommit_ous ?? 0) * Number(row.enterprise_precommit_rate ?? 0)) * 100
        );
    return { planName: 'Enterprise', planPriceUsd: monthlyCents / 100 };
  }
  return {
    planName: row.self_serve_display_name ?? 'Liftoff',
    planPriceUsd: Number(row.self_serve_price_cents ?? 0) / 100,
  };
}
