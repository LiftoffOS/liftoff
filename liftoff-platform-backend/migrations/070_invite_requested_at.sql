-- Access Gate: track invite request timestamps for rate limiting
-- Per implementation plan 1e: DB-backed rate limit for invite requests

ALTER TABLE accounts ADD COLUMN invite_requested_at TIMESTAMP WITH TIME ZONE;
