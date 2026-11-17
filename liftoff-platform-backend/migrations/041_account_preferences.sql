-- Migration: Add preferences JSONB column to accounts table
-- Purpose: Store user preferences like gettingStartedHidden

ALTER TABLE accounts ADD COLUMN preferences JSONB DEFAULT '{}' NOT NULL;

-- Add index for efficient JSONB queries (if needed in future)
CREATE INDEX idx_accounts_preferences ON accounts USING GIN (preferences);
