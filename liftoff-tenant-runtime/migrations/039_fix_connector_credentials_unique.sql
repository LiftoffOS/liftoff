-- Migration 039: Add unique constraint on connector_credentials.connector_id
-- Required for ON CONFLICT (connector_id) upsert in handleCredentialsStored

-- First remove any duplicates (keep the newest)
DELETE FROM connector_credentials a USING connector_credentials b
WHERE a.connector_id = b.connector_id AND a.created_at < b.created_at;

-- Add unique constraint
ALTER TABLE connector_credentials ADD CONSTRAINT connector_credentials_connector_id_unique
  UNIQUE (connector_id);
