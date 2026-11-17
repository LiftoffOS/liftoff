-- Internal Agents: GIN index on integrations JSONB
--
-- Supports the connector.deleted scrub path (events/subscriber.ts) which
-- needs to find every agent containing a specific connector UUID and
-- remove the matching element from the integrations array. Without this
-- index the scan would be a full-table seq scan over internal_agents.
--
-- Partial so the index stays small (most agents have non-empty
-- integrations, but the WHERE filter mirrors migration 087's index on
-- pending_integrations for consistency, and ensures soft-deleted agents
-- never participate in the scan).

CREATE INDEX IF NOT EXISTS idx_internal_agents_integrations
  ON internal_agents USING GIN (integrations)
  WHERE integrations <> '[]'::jsonb AND deleted_at IS NULL;
