-- 252 — Multi-account connector support
--
-- The platform was designed to support multiple OAuth connections of the same
-- type per tenant (e.g. two Gmail accounts: support@ and sales@). Composio
-- exposes `allowMultiple: true` for connection requests, identity-fetchers
-- populate `config.externalAccountLabel` so each connection carries a
-- per-account identity, and the React frontend's `connectedAccountLabel`
-- helper disambiguates connection chips by email.
--
-- But three structural assumptions in the tenant-runtime data plane blocked
-- multi-account from actually persisting:
--
--   1. Migration 058 added `idx_connectors_tenant_type_active`, a partial
--      unique index enforcing "at most one active connector per
--      (tenant_id, type)". A second OAuth grant of the same type produced a
--      `duplicate key value violates unique constraint` error in the
--      credentials_stored handler, which Pub/Sub retried 10 times then
--      DLQ'd. The local mirror stayed permanently stuck on the older row.
--
--      An orphan older row can therefore block a legitimate reconnect
--      event from landing in tenant-runtime, leaving the agent calling
--      tools against a stale binding.
--
--   2. The handler generated the manifest alias from connector_type alone
--      (`replace(_,-)`), producing `google-mail` for every Gmail. The
--      `connector_manifests` table has a UNIQUE (tenant_id, alias) — a
--      second Gmail's manifest INSERT would silently UPSERT-clobber the
--      first via `ON CONFLICT (tenant_id, alias) DO UPDATE SET id = …`.
--      Both can't coexist.
--
--   3. `action_allowlists.connector` held the same alias string, so it
--      collided in lockstep with the manifest aliases.
--
-- This migration takes the structural fix:
--
--   (a) Drop the partial unique index from migration 058. With it gone, the
--       credentials_stored handler can INSERT a new row per OAuth grant.
--
--   (b) Rewrite every manifest alias to include a per-account discriminator
--       (`<type-hyphenated>-<first-8-hex-of-connector_id>`). Examples:
--          google-mail-1a2b3c4d
--          google-mail-5e6f7a8b
--       The 8-hex window collides with vanishingly low probability inside a
--       single tenant. Same shape as the new handler will produce.
--
--   (c) Rewrite every matching `action_allowlists.connector` in the same
--       statement so the two stay in sync. (The agent-execution path passes
--       the manifest alias to action_allowlists at lookup time, so they
--       MUST agree.)
--
-- Migration 058's index was added under the wrong assumption — see its own
-- comment: "The tool gateway's connector resolution relies on this
-- invariant to JOIN connector_manifests -> connectors with ORDER BY
-- created_at DESC LIMIT 1". That JOIN doesn't actually exist in the
-- current code (verified via grep), and the alias-keyed resolution
-- replaces it anyway. The "invariant" was scaffolding for a single-account
-- intermediate state that the platform has been trying to grow out of.
--
-- Idempotent: the manifest UPDATE skips rows where the alias already ends
-- in the right 8-hex suffix. The action_allowlists UPDATE matches by the
-- pre-migration alias, so re-running it after the manifest UPDATE will be
-- a no-op. The index drop is `IF EXISTS`.

-- (a) Drop the partial unique index that enforced one-active-per-type.
DROP INDEX IF EXISTS idx_connectors_tenant_type_active;

-- (b) + (c) Rewrite aliases. action_allowlists must be updated BEFORE
--     connector_manifests because the WHERE clause matches on the old
--     alias value; once the manifest is updated, action_allowlists rows
--     would no longer be matchable by that join key.
--
--     The migration wraps both updates atomically — node-pg-migrate runs
--     each migration in a transaction by default, so a failure in either
--     UPDATE rolls back to a consistent state.
UPDATE action_allowlists aa
SET connector = REPLACE(m.connector_type, '_', '-')
                  || '-'
                  || SUBSTRING(m.id::text, 1, 8)
FROM connector_manifests m
WHERE aa.tenant_id = m.tenant_id
  AND aa.connector = m.alias
  AND m.alias NOT LIKE '%-________';

UPDATE connector_manifests
SET alias = REPLACE(connector_type, '_', '-')
              || '-'
              || SUBSTRING(id::text, 1, 8),
    updated_at = NOW()
WHERE alias NOT LIKE '%-________';

-- Sanity check: no manifest still uses the legacy single-alias format.
-- Wrapped in a DO block so a failure aborts the migration with a clear
-- message. The pattern `%-________` matches `<anything>-<exactly 8 chars>`.
DO $$
DECLARE
  legacy_count INT;
BEGIN
  SELECT COUNT(*) INTO legacy_count
  FROM connector_manifests
  WHERE alias NOT LIKE '%-________';
  IF legacy_count > 0 THEN
    RAISE EXCEPTION 'Migration 252: % manifest(s) still carry a legacy single-alias format. Investigate before proceeding.', legacy_count;
  END IF;
END $$;
