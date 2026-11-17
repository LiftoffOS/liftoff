-- Migration 029: what the provider's specification says NOW, when that is no
-- longer what this connection was built from.
--
-- A custom API connection is generated from a document fetched once. Nothing
-- read it again, and a provider announces nothing: an API that adds an
-- endpoint never offered it here, and one that renames or drops an endpoint
-- left a connection whose tools call a place that is not there. The key is
-- untouched throughout, so the declared verification call keeps succeeding and
-- the connection keeps saying it is fine. That is the failure this records —
-- not a broken connection, a connection that is quietly describing an API
-- that has moved.
--
-- Two columns rather than a boolean, for two different reasons:
--
--   `spec_drift_hash` is the hash of the document that is there NOW. It is
--   compared against `spec_hash` (what the connection was built from) rather
--   than trusted on its own, so a drift that is later applied clears itself by
--   the two becoming equal, and a flag can never be left set against a
--   connection that has already been brought up to date.
--
--   `spec_drift_checked_at` records that we looked, which is separate from
--   what we found. Without it a connection that has never been checked and one
--   whose provider has not moved are the same row, and the sweep cannot pace
--   itself: it re-reads specifications it looked at a minute ago and starves
--   the ones it has never seen.
--
-- The sweep enumerates with `withAdminScope` (connector_admin, BYPASSRLS),
-- which migration 028 already granted on this table, so there is no
-- SECURITY DEFINER lister here. Every WRITE still goes through the tenant
-- scope, exactly as every other write to this table does.

BEGIN;

ALTER TABLE custom_api_connectors
  ADD COLUMN IF NOT EXISTS spec_drift_hash       TEXT,
  ADD COLUMN IF NOT EXISTS spec_drift_checked_at TIMESTAMPTZ;

-- The sweep's own predicate: never checked, or not checked lately. Partial on
-- `spec_source_url IS NOT NULL` because a connection with no published
-- specification can never drift and must not be swept.
CREATE INDEX IF NOT EXISTS custom_api_connectors_drift_sweep_idx
  ON custom_api_connectors (spec_drift_checked_at NULLS FIRST)
  WHERE spec_source_url IS NOT NULL;

COMMENT ON COLUMN custom_api_connectors.spec_drift_hash IS
  'sha256 of the document at spec_source_url as of the last sweep. Drift is this being present and different from spec_hash; equal means the connection is up to date, and applying a re-read makes them equal.';
COMMENT ON COLUMN custom_api_connectors.spec_drift_checked_at IS
  'When the sweep last read the specification. Records that we looked, not what we found — a connection never checked and one whose provider has not moved are otherwise the same row.';

COMMIT;
