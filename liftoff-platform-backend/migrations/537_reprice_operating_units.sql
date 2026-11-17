-- Migration 537: the self-serve rate ladder.
--
-- An Operating Unit is one cent of the platform's own cost
-- (`ou_definition_rate_usd` = 0.01); a workspace pays its own rate per OU. The
-- ratio between the two is the markup on platform work — inference, the
-- sandbox, embeddings. Pass-through work does not price this way: it takes
-- `pass_through_premium` and is untouched here.
--
-- Because `included_ous x included_rate` equals the base fee to the cent, at
-- full consumption that ratio IS the plan's gross margin:
--
--   band                rate        margin at full consumption
--   Core included       0.014286    30.00%
--   Growth included     0.013699    27.00%
--   Scale included      0.013158    24.00%
--   precommit (all)     0.015217    34.29%
--   reload / PAYG       0.016129    38.00%
--
-- THE MARGIN IS SET BY THE ALLOWANCE, NOT BY THE RATE. `(fee - included_ous x
-- 0.01) / fee` is exact. The rate columns are NUMERIC(10,6) and carry the
-- rounded quotient (0.014286, not 0.0142857...), which moves a booked
-- `customer_cost_usd` by fractions of a cent and the margin not at all. Never
-- adjust an allowance to make a rate divide evenly.
--
-- THE LADDER MUST STAY MONOTONE: every included rate < precommit < reload.
-- Precommit exists to buy a discount for committing capacity in advance; at or
-- above the uncommitted rate the slider sells a worse deal than doing nothing.
--
-- `plan_catalog.included_ous` IS READ BY NOTHING and is kept correct anyway.
-- For a self-serve subscription the allowance comes from liftoff-billing's
-- `SELF_SERVE_PLANS.basePlanOus`, which stamps it into Stripe subscription
-- metadata; the event processor reads that back and forwards it to
-- `subscription-activated`, which writes `billing_controls.plan_included_ous`.
-- Only the three RATES here are read. Changing this table alone cannot reprice
-- anyone, and is reverted the next time a `customer.subscription.updated`
-- event re-reads the old metadata.
--
-- Not retrospective: events already written keep the price they were booked at.

UPDATE plan_catalog
   SET included_ous               = v.new_ous,
       included_rate_usd_per_ou   = v.new_included_rate,
       precommit_rate_usd_per_ou  = 0.015217,
       reload_rate_usd_per_ou     = 0.016129
  FROM (VALUES
          ('core',   1400::BIGINT,  0.014286::NUMERIC),
          ('growth', 3650::BIGINT,  0.013699::NUMERIC),
          ('scale',  15200::BIGINT, 0.013158::NUMERIC)
       ) AS v(plan, new_ous, new_included_rate)
 WHERE plan_catalog.id = v.plan;

-- The rate a workspace with no plan pays, kept equal to the reload rate: credit
-- costs the same per unit whether it covers overflow past an allowance or funds
-- a workspace that never bought one.
--
-- DO UPDATE rather than DO NOTHING: this row exists, and a row still reading
-- 0.031250 after this migration is the wrong price.
INSERT INTO billing_system_settings (key, value)
VALUES ('payg_rate_usd_per_ou', 0.016129)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Carry the ladder onto workspaces that already hold a copy of it.
-- `billing_controls` is the canonical per-tenant rate ledger; plan_catalog only
-- seeds a subscription at activation, so without this pass an existing
-- workspace keeps its old rates until it next changes plan.
--
-- THE LARGER ALLOWANCE LANDS IMMEDIATELY, IN THE CURRENT PERIOD.
-- `ous_consumed_this_period` is deliberately NOT touched: raising
-- `plan_included_ous` against an unchanged counter is what makes the extra
-- capacity spendable the moment this runs, rather than at the next renewal.
-- Zeroing the counter here would also hand back allowance already consumed,
-- which is a second, unasked-for grant.
--
-- GUARDED ON THE OLD DEFAULTS, and the two halves are guarded differently
-- because they mean different things:
--
--   * The three RATES are properties of the plan. They move wherever all three
--     still equal that plan's old defaults. A row whose rates were hand-tuned
--     (a negotiated discount) matches nothing and keeps its terms rather than
--     being silently reset to list.
--   * The ALLOWANCE is what the customer bought, so it moves only where it also
--     still equals the plan's old default. A row an operator set deliberately
--     keeps its number and takes the new rates.
--
-- Enterprise rows carry `plan_type IS NULL` — their rates come from a bespoke
-- contract via /provision-enterprise — so the join excludes them by shape.
--
-- Re-running is a no-op: after the first pass no row matches the old defaults.
UPDATE billing_controls bc
   SET included_rate_usd_per_ou  = v.new_included_rate,
       precommit_rate_usd_per_ou = 0.015217,
       reload_rate_usd_per_ou    = 0.016129,
       plan_included_ous         = CASE WHEN bc.plan_included_ous = v.old_ous
                                        THEN v.new_ous
                                        ELSE bc.plan_included_ous END,
       updated_at                = NOW()
  FROM (VALUES
          ('core',   800::BIGINT,  1400::BIGINT,  0.025000::NUMERIC, 0.014286::NUMERIC),
          ('growth', 2150::BIGINT, 3650::BIGINT,  0.023256::NUMERIC, 0.013699::NUMERIC),
          ('scale',  9200::BIGINT, 15200::BIGINT, 0.021739::NUMERIC, 0.013158::NUMERIC)
       ) AS v(plan, old_ous, new_ous, old_included_rate, new_included_rate)
 WHERE bc.plan_type                 = v.plan
   AND bc.included_rate_usd_per_ou  = v.old_included_rate
   AND bc.precommit_rate_usd_per_ou = 0.028000
   AND bc.reload_rate_usd_per_ou    = 0.031250;
