-- Internal Agents: pending_integrations
--
-- When the HRBP Agent provisions a workforce plan, each agent spec may list
-- connector types that are not yet connected on the tenant (e.g. the user
-- wants a Salesforce-driven agent but hasn't finished the OAuth flow yet).
-- We create the agent anyway with whatever connectors ARE connected, and
-- record the unconnected ones in `pending_integrations` so they can be
-- auto-granted the moment the user completes the OAuth flow on /Connections.
--
-- Stored as a JSONB array of connector type strings (e.g.
-- `["hubspot", "slack"]`) rather than a separate table because:
--   - The list is small (<10 items per agent in practice)
--   - It's always read atomically with the agent row
--   - No joins or aggregate queries are ever performed against it
--   - Matches the same storage style as the `integrations` column
--
-- On a successful connector OAuth callback, the auto-grant flow scans all
-- internal_agents in the tenant for a matching type in pending_integrations,
-- moves the entry into `integrations` with `selectedObjects: []` (full
-- access matching the teambuilder default), and removes it from the
-- pending list.

ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS pending_integrations JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Lookup index for the auto-grant scan: find all agents in a tenant whose
-- pending_integrations array contains a given connector type. Partial so
-- the index stays small (most agents have no pending integrations).
CREATE INDEX IF NOT EXISTS idx_internal_agents_pending_integrations
  ON internal_agents USING GIN (pending_integrations)
  WHERE pending_integrations <> '[]'::jsonb AND deleted_at IS NULL;
