-- Add credential hint columns for UI display
-- These store truncated identifiers (last 4 chars) to show users which credential is configured
-- Actual credentials remain in Secret Manager - hints are non-sensitive identifiers
-- Pattern: industry standard "Show Once, Never Retrieve" (like Stripe, GitHub)

ALTER TABLE external_agents
ADD COLUMN api_key_hint VARCHAR(10),           -- e.g., "...3f2x"
ADD COLUMN bearer_token_hint VARCHAR(10),      -- e.g., "...8k2m"
ADD COLUMN custom_header_keys TEXT[];          -- e.g., ["X-Api-Key", "Authorization"]
