-- Force re-registration for Datadog so the connector service fetches a fresh
-- DCR response that includes service_redirect_uri. Without this field the
-- authorization URL uses our own callback URL, which Datadog's MCP auth server
-- rejects. On the next Connect Datadog attempt the service will re-run DCR and
-- persist service_redirect_uri in metadata.
DELETE FROM oauth_dynamic_registrations WHERE provider = 'datadog';
