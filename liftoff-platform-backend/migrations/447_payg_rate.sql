-- The pay-as-you-go rate: what one Operating Unit costs a workspace that funds
-- itself with credit instead of subscribing to a plan.
--
-- Set to the reload rate the three self-serve plans already share, so credit
-- costs the same per unit whether it is covering overflow past a plan allowance
-- or funding a workspace that has no plan at all. It sits above every included
-- rate by design: a plan is a prepaid commitment that buys a discount, and the
-- discount only means anything if the uncommitted rate is higher.
--
-- Lives here rather than in plan_catalog because it is a platform-wide
-- constant, not a plan. plan_catalog is constrained to the three self-serve
-- subscription plans and exists to seed a subscription's rates; a workspace on
-- this rate has no subscription to seed. Enterprise writes its negotiated rates
-- straight onto billing_controls for the same reason.
--
-- billing_controls stays the canonical per-tenant rate ledger. This is only the
-- value copied onto a row at provision time.
--
-- Idempotent, and DO NOTHING rather than DO UPDATE: an operator who has tuned
-- the rate keeps their value, and a from-scratch rebuild agrees with an applied
-- database.

INSERT INTO billing_system_settings (key, value)
VALUES ('payg_rate_usd_per_ou', 0.031250)
ON CONFLICT (key) DO NOTHING;
