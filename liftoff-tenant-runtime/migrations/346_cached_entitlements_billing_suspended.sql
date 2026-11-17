-- Migration 346: cache the control plane's billing hard stop alongside the
-- execution signal it belongs with.
--
-- Two gates decide whether a tenant may run agents, and until now they read
-- different rows. The control plane's execution-guard reads
-- `entitlements.agent_execution_allowed` AND `billing_controls.suspended`
-- together; the runtime's admission check only ever saw the first, because
-- `billing_controls` is account-keyed and lives in the other plane. A tenant
-- suspended for non-payment therefore passed runtime admission and was stopped
-- only at whichever surface happened to call the control plane.
--
-- The control plane now folds `billing_controls.suspended` into the entitlement
-- snapshot it serves, and this column is where the runtime caches it, so both
-- gates are computed from the same fact and cannot diverge.
--
-- DEFAULT FALSE is the deliberate rollout posture, not laziness. The control
-- plane deploys before the runtime; between the two deploys the served snapshot
-- may not carry the field yet, and existing cached rows certainly do not. FALSE
-- means "no billing suspension known", which is the pre-change behaviour — the
-- new gate can only ever tighten admission once real values arrive, never
-- loosen it, and never blocks a tenant on a value nobody has written.

ALTER TABLE cached_entitlements
  ADD COLUMN IF NOT EXISTS billing_suspended BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN cached_entitlements.billing_suspended IS
  'Mirror of the control plane''s billing_controls.suspended for this tenant''s account, served on the entitlement snapshot. Admission treats TRUE identically to operational_status = suspended. Defaults FALSE so a snapshot served without the field cannot fabricate a suspension.';
