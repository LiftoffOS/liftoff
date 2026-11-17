-- 311_oauth_client_type_and_app_type.sql
--
-- MCP 2026-07-28 OAuth client-registration hardening on oauth_clients:
--
--   application_type — OIDC application_type ("native" | "web") sent by clients
--     during Dynamic Client Registration (SEP-837). Persisted for fidelity; we
--     already permit loopback redirect URIs for public clients, so it does not
--     change validation. NULL for pre-existing / omitted registrations.
--
--   client_type — how the client was registered: 'dcr' (opaque liftoff_oc_*
--     clients from /oauth/register) or 'cimd' (URL-form client_id resolved from
--     a Client ID Metadata Document at /oauth/authorize). DCR is deprecated in
--     favor of CIMD but retained for backward compat, so both coexist. Existing
--     rows are all DCR — hence the DEFAULT.
--
--   cimd_cached_until — freshness horizon for a resolved CIMD row. The
--     authorize handler re-fetches + re-validates the client's metadata
--     document once this passes (respecting the document's HTTP cache headers,
--     clamped to a sane [5min, 24h] window), so a client that rotates its
--     redirect_uris is picked up without operator intervention. NULL for DCR
--     clients (they are never re-resolved).
--
-- Additive, idempotent. oauth_clients is platform-global (non-RLS) — no RLS /
-- policy / census change (it is in migration 200's excluded_tables set).
ALTER TABLE oauth_clients
  ADD COLUMN IF NOT EXISTS application_type TEXT,
  ADD COLUMN IF NOT EXISTS client_type TEXT NOT NULL DEFAULT 'dcr',
  ADD COLUMN IF NOT EXISTS cimd_cached_until TIMESTAMPTZ;

COMMENT ON COLUMN oauth_clients.application_type IS
  'OIDC application_type ("native"|"web") from Dynamic Client Registration (MCP 2026-07-28 / SEP-837). NULL when omitted.';
COMMENT ON COLUMN oauth_clients.client_type IS
  'Registration mechanism: ''dcr'' (opaque liftoff_oc_* via /oauth/register) or ''cimd'' (URL client_id resolved from a Client ID Metadata Document). DCR deprecated but retained for backward compat.';
COMMENT ON COLUMN oauth_clients.cimd_cached_until IS
  'For client_type=''cimd'': re-fetch/re-validate the metadata document once NOW() passes this (respects the doc''s HTTP cache headers, clamped to [5min,24h]). NULL for DCR clients.';
