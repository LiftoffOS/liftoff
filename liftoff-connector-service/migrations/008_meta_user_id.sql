ALTER TABLE connector_credentials ADD COLUMN meta_user_id TEXT;

CREATE INDEX idx_connector_credentials_meta_user_id
  ON connector_credentials (meta_user_id)
  WHERE meta_user_id IS NOT NULL;
