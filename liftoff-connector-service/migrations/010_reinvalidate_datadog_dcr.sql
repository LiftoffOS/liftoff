-- Re-invalidate the Datadog DCR registration so the two-phase re-registration
-- runs on next Connect Datadog attempt. The previous registration (from
-- migration 009) used only our callback URL in redirect_uris; Datadog's
-- authorize endpoint requires service_redirect_uri to be listed first.
-- Deleting here forces a fresh probe + re-register on next auth flow.
DELETE FROM oauth_dynamic_registrations WHERE provider = 'datadog';
