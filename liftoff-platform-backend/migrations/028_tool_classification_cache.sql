-- Migration 028: ONLY schema, NO seed data
CREATE TABLE IF NOT EXISTS tool_classification_cache (
  tool_name TEXT PRIMARY KEY,
  integration_type TEXT NOT NULL,
  tool_description_hash CHAR(12) NOT NULL,
  categories TEXT[] NOT NULL DEFAULT '{}',
  draft_variant TEXT,
  classified_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tool_classification_integration
  ON tool_classification_cache(integration_type);

COMMENT ON TABLE tool_classification_cache IS 'Pre-classified tool categories for HITL gate decisions. Built-in connectors are seeded; user-provided integrations are classified via LLM at connection time.';
COMMENT ON COLUMN tool_classification_cache.categories IS 'Sensitivity categories: customerCommunication, financialActions, dataChanges, externalPublishing, hiringDecisions';
COMMENT ON COLUMN tool_classification_cache.draft_variant IS 'Alternative tool name for communication=draft mode (e.g., gmail_send_email -> gmail_create_draft)';
