-- Migration 004: Align oauth_dynamic_registrations with the port of
-- platform-backend's oauth-discovery.ts (RFC 7591 DCR).
--
-- The ported discovery flow keys DCR rows by `provider` (the OAuthProvider
-- string like 'notion', 'linear') and needs columns for the discovered
-- endpoints so the callback handler can exchange the code without a second
-- round of discovery. It also stores a metadata JSON blob (issued-at etc.)
-- and a single redirect_uri (not an array).
--
-- Migration 001 created oauth_dynamic_registrations keyed by `issuer` with
-- client_secret + redirect_uris[]. We drop those unused columns and add
-- the provider-oriented columns the router needs. Nothing writes the table
-- before this migration, so it is empty here and an in-place rewrite is safe.

ALTER TABLE oauth_dynamic_registrations
  ADD COLUMN IF NOT EXISTS provider TEXT,
  ADD COLUMN IF NOT EXISTS authorization_endpoint TEXT,
  ADD COLUMN IF NOT EXISTS token_endpoint TEXT,
  ADD COLUMN IF NOT EXISTS registration_endpoint TEXT,
  ADD COLUMN IF NOT EXISTS redirect_uri TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Drop columns + unique-on-issuer that the port does not use. The router
-- guarantees one row per provider via ON CONFLICT(provider).
ALTER TABLE oauth_dynamic_registrations DROP COLUMN IF EXISTS issuer CASCADE;
ALTER TABLE oauth_dynamic_registrations DROP COLUMN IF EXISTS client_secret;
ALTER TABLE oauth_dynamic_registrations DROP COLUMN IF EXISTS redirect_uris;
ALTER TABLE oauth_dynamic_registrations DROP COLUMN IF EXISTS scopes;
ALTER TABLE oauth_dynamic_registrations DROP COLUMN IF EXISTS rotate_after;

-- provider must be non-null + unique (one registration per issuer).
UPDATE oauth_dynamic_registrations SET provider = 'unknown' WHERE provider IS NULL;
ALTER TABLE oauth_dynamic_registrations ALTER COLUMN provider SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_dcr_provider
  ON oauth_dynamic_registrations (provider);

-- Drop the old rotate_after index from migration 001 (column is gone).
DROP INDEX IF EXISTS idx_oauth_dcr_rotate_after;

-- ─── connectors.api_key_hint ─────────────────────────────────────────
--
-- Stores a masked last-4 hint (e.g. "•••abcd") for API-key connectors so
-- the UI can render "which key is connected" without fetching the secret.
-- Same shape as platform-backend's connectors.api_key_hint column.
ALTER TABLE connectors
  ADD COLUMN IF NOT EXISTS api_key_hint TEXT;

