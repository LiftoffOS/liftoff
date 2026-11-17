-- migrations/031_passkey_sign_count.sql
-- Made idempotent to handle partial migration state
ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS sign_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_passkeys_sign_count ON passkeys(id, sign_count);
