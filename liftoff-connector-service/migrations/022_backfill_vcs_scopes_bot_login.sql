-- Backfill config.scopes + config.bot_login for github/gitlab connections that
-- predate the connect flow recording them (buildIdentityConfig, added with the
-- version_control work). platform-backend team-provisioning validates a role's
-- required version-control scopes (github 'repo', gitlab 'api') and needs
-- bot_login for the self-event exclusion, so a pre-fix connection currently
-- fails-closed and cannot stand up the software-delivery-team.
--
-- bot_login = the connection's login/username, already stored on every
-- identity-bearing connection as externalAccountLabel (github's label IS its
-- login; gitlab's is its username — see src/oauth/identity-config.ts).
-- scopes = the fixed set github/gitlab OAuth is always connected with (the grant
-- equals the request for these providers), so recording the catalog set is
-- accurate for an existing connection.
--
-- Idempotent: only rows that have an externalAccountLabel and are missing/empty
-- scopes are touched. Status-agnostic (this only completes config); provisioning
-- still requires status='active', so a connection in 'error' (dead/unrefreshable
-- token) must be reconnected — the backfill cannot revive its token.

BEGIN;

UPDATE connectors
SET config = config
      || jsonb_build_object('bot_login', config->>'externalAccountLabel')
      || jsonb_build_object(
           'scopes',
           CASE type
             WHEN 'github' THEN '["repo","read:user","user:email","read:org"]'::jsonb
             ELSE '["api","mcp"]'::jsonb   -- gitlab
           END
         ),
    updated_at = now()
WHERE type IN ('github', 'gitlab')
  AND config->>'externalAccountLabel' IS NOT NULL
  AND (config->'scopes' IS NULL OR config->'scopes' = '[]'::jsonb);

COMMIT;
