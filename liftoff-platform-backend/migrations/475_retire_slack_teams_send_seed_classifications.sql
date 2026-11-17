-- Retire the seeded sensitivity rows for a message into the workspace's own
-- collaboration surface.
--
-- The classification cache answers the capability gate before the connector
-- registry does. Its global rows for the Slack and Microsoft Teams message
-- functions were seeded as externalPublishing from the vendors' public tool
-- inventories, while the registry — and the runtime, which reads it — hold
-- that a message into the workspace's own Slack or Teams is internal
-- collaboration and is never held for approval. With the rows gone the gate
-- falls through to the registry's answer, and both planes read the same one.
--
-- Global seeds only. A tenant's own row (tenant_id set) and a reviewed
-- override are decisions somebody made and stay. Idempotent: a DELETE that
-- matches nothing is the desired state.

DELETE FROM tool_classification_cache
 WHERE tenant_id IS NULL
   AND is_manual_override = false
   AND reviewed_by = 'mcp-migration-seed'
   AND integration_type IN ('slack', 'microsoft_teams')
   AND tool_name IN ('send_message', 'schedule_message', 'update_message');
