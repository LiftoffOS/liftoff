-- Migration: Add avatar_url to accounts table
-- Stores the URL of the user's profile photo (uploaded to Firebase Storage)

ALTER TABLE accounts ADD COLUMN avatar_url TEXT;

COMMENT ON COLUMN accounts.avatar_url IS 'URL to the user profile photo stored in Firebase Storage';
