-- A connector that fails every poll must stop reading `active`.
--
-- The Connections page derives its tile from `connectors.status`: `active` is
-- Connected, `error` is Reconnect (liftoff-react useIntegrations.ts). Until now
-- the ONLY thing that moved a connector to `error` was an OAuthRefreshError —
-- raised when a credential could not be refreshed. A vendor that simply rejects
-- the call raises nothing of the sort, so a connector could 401 on every cycle
-- indefinitely and still render as Connected.
--
-- For example, a client bug that sends an empty bearer makes Gmail polling
-- return 401 on every cycle while the Composio account is ACTIVE and its token
-- fresh. Every signal a person can see says the connector is fine. The failure
-- is loud in Cloud Logging and invisible in the product.
--
-- These columns are the memory a per-cycle poller does not otherwise have: it
-- cannot tell its first failure from its fiftieth, and "fifty in a row" is the
-- fact worth acting on. Kept on `connectors` rather than
-- `connector_sync_state` because the verdict is per CONNECTOR — one bad
-- credential fails every entity it polls, and counting per entity would reach
-- any threshold N times faster for no added truth.

BEGIN;

ALTER TABLE connectors
  -- Consecutive poll cycles whose failure looked credential-shaped (401/403 or
  -- a refresh failure). Reset to 0 by any successful poll, so a blip cannot
  -- accumulate across hours of healthy operation.
  ADD COLUMN IF NOT EXISTS consecutive_poll_auth_failures INTEGER NOT NULL DEFAULT 0,
  -- The most recent poll failure, for triage without a log search. Truncated by
  -- the writer; this is a diagnostic, not an audit trail.
  ADD COLUMN IF NOT EXISTS last_poll_error TEXT,
  ADD COLUMN IF NOT EXISTS last_poll_error_at TIMESTAMPTZ;

COMMENT ON COLUMN connectors.consecutive_poll_auth_failures IS
  'Consecutive credential-shaped poll failures. At the scheduler threshold the '
  'connector is flipped to status=error (Reconnect in the UI). Reset by any '
  'successful poll.';

COMMIT;
