-- Migration 538: the precommit rate is a round fraction of a dollar.
--
-- Fix-forward on 537, which is applied and must not be edited.
--
-- The precommit rate prices the "extra Operating Units" slider on the pricing
-- page: a workspace commits to capacity above its plan's allowance and the cost
-- is baked into the monthly fee. So the rate is not only a margin, it is an
-- arithmetic constraint on what the slider can display — a stop shows a total
-- allowance and a total price, and both have to be figures a person would
-- recognise.
--
-- 0.015217 satisfies a margin and nothing else. A whole dollar of precommit
-- costs 1/0.015217 = 65.72 Operating Units, so no round quantity has a round
-- price: 500 OUs came to $7.61, 1,250 to $19.02, 2,000 to $30.43.
--
-- 0.015 IS a round fraction: 1,000 Operating Units cost exactly $15.00 and
-- 2,000 cost exactly $30.00. Every slider stop is then a whole number of
-- Operating Units at a whole number of dollars.
--
-- Its margin is 1 - 0.01/0.015 = 33.33%, against 34.28% at the old value. That
-- is the whole cost of the change, and it is confined to precommit: the three
-- included rates and the reload rate are untouched, so the plan margins stay at
-- 30 / 27 / 24 per cent and the uncommitted rate at 38.
--
-- The ladder still holds — every included rate (0.013158 to 0.014286) < 0.015 <
-- reload 0.016129 — which is what keeps committing capacity in advance cheaper
-- per unit than not committing.

UPDATE plan_catalog
   SET precommit_rate_usd_per_ou = 0.015000
 WHERE precommit_rate_usd_per_ou = 0.015217;

-- Same guard as 537's: a row still carrying the value 537 wrote moves, and a
-- hand-tuned rate is left alone. Re-running is a no-op.
UPDATE billing_controls
   SET precommit_rate_usd_per_ou = 0.015000,
       updated_at                = NOW()
 WHERE plan_type IN ('core', 'growth', 'scale')
   AND precommit_rate_usd_per_ou = 0.015217;
