-- Connector Manifests Table
-- Dynamic connector manifest loading
-- Stores tool definitions for each connector, enabling dynamic tool schema generation

-- ---------------------------------------------------------------------------
-- CONNECTOR_MANIFESTS
-- Defines available functions/tools for each connector type per tenant
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connector_manifests (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Connector identification
  connector_type       TEXT        NOT NULL,  -- e.g. 'salesforce', 'slack', 'google_mail'
  alias                TEXT        NOT NULL,  -- Short name used in tool naming (e.g. 'sf', 'slack', 'gmail')
  display_name         TEXT        NOT NULL,  -- Human-readable name

  -- Functions/tools available for this connector
  -- Array of: { name, description, inputSchema, categories, draftVariant?, entityType? }
  functions            JSONB       NOT NULL DEFAULT '[]',

  -- Whether this manifest is active
  enabled              BOOLEAN     NOT NULL DEFAULT true,

  -- Timestamps
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint: one manifest per connector alias per tenant
CREATE UNIQUE INDEX idx_connector_manifests_tenant_alias
  ON connector_manifests (tenant_id, alias);

-- Index for lookup by connector type
CREATE INDEX idx_connector_manifests_type
  ON connector_manifests (tenant_id, connector_type);

-- Index for enabled manifests
CREATE INDEX idx_connector_manifests_enabled
  ON connector_manifests (tenant_id) WHERE enabled = true;

-- RLS
ALTER TABLE connector_manifests ENABLE ROW LEVEL SECURITY;

CREATE POLICY connector_manifests_tenant_isolation ON connector_manifests
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Comments
COMMENT ON TABLE connector_manifests IS
  'Defines available functions/tools for each connector type. Used for dynamic tool schema generation.';

COMMENT ON COLUMN connector_manifests.alias IS
  'Short name used in tool naming, e.g. "sf" results in "sf__create_lead"';

COMMENT ON COLUMN connector_manifests.functions IS
  'Array of function definitions with name, description, inputSchema, categories, draftVariant';

-- ---------------------------------------------------------------------------
-- DEFAULT MANIFESTS
-- Insert default connector manifests for common connectors
-- These can be customized per tenant
-- ---------------------------------------------------------------------------

-- Helper function to get or create a manifest (for idempotent seed data)
-- Note: This is for seed data only, actual tenant manifests will be created via API

-- Example manifest structure in functions JSONB:
-- [
--   {
--     "name": "create_contact",
--     "description": "Create a new contact in Salesforce",
--     "inputSchema": {
--       "type": "object",
--       "properties": {
--         "email": {"type": "string", "description": "Contact email address"},
--         "firstName": {"type": "string", "description": "First name"},
--         "lastName": {"type": "string", "description": "Last name"}
--       },
--       "required": ["email", "lastName"]
--     },
--     "categories": ["write"],
--     "entityType": "contact"
--   },
--   {
--     "name": "delete_contact",
--     "description": "Delete a contact from Salesforce",
--     "inputSchema": {
--       "type": "object",
--       "properties": {
--         "contactId": {"type": "string", "description": "Contact ID to delete"}
--       },
--       "required": ["contactId"]
--     },
--     "categories": ["destructive"],
--     "draftVariant": "delete_contact_draft",
--     "entityType": "contact"
--   }
-- ]
