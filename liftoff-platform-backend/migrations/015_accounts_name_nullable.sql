-- Migration: Make accounts.name column nullable
-- The name column is replaced by first_name and last_name columns
-- This migration makes name nullable so new accounts don't need to set it

-- Drop NOT NULL constraint on name column
ALTER TABLE accounts ALTER COLUMN name DROP NOT NULL;

-- Set default to null for new records
ALTER TABLE accounts ALTER COLUMN name SET DEFAULT NULL;
