-- Migration: Add Firebase auth columns to accounts
-- Adds firebase_uid, first/last name, timezone, email verification, soft delete

-- Add firebase_uid column
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(128) UNIQUE;

-- Split name into first_name and last_name
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS first_name VARCHAR(255);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_name VARCHAR(255);

-- Migrate existing name data
UPDATE accounts SET
  first_name = SPLIT_PART(name, ' ', 1),
  last_name = CASE
    WHEN POSITION(' ' IN name) > 0
    THEN SUBSTRING(name FROM POSITION(' ' IN name) + 1)
    ELSE ''
  END
WHERE first_name IS NULL;

-- Set not null after migration
ALTER TABLE accounts ALTER COLUMN first_name SET NOT NULL;
ALTER TABLE accounts ALTER COLUMN last_name SET NOT NULL;

-- Add timezone
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS timezone VARCHAR(100) DEFAULT 'America/Los_Angeles';

-- Email verification columns
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pending_email VARCHAR(255);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS verification_token VARCHAR(255);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMP WITH TIME ZONE;

-- Soft delete columns
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deleted_by UUID;

-- Index for firebase_uid lookups
CREATE INDEX IF NOT EXISTS idx_accounts_firebase_uid ON accounts(firebase_uid) WHERE deleted_at IS NULL;

-- Index for verification token lookups
CREATE INDEX IF NOT EXISTS idx_accounts_verification_token ON accounts(verification_token) WHERE verification_token IS NOT NULL;
