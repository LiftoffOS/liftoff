-- Add description and plan/cost fields to claude_code_proxy_keys
-- Description is auto-populated on creation; plan is set by user in update page.

ALTER TABLE claude_code_proxy_keys ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE claude_code_proxy_keys ADD COLUMN IF NOT EXISTS plan_type TEXT
  CHECK (plan_type IN ('free', 'pro', 'max_5x', 'max_20x', 'team_standard', 'team_premium', 'enterprise', 'api'));
ALTER TABLE claude_code_proxy_keys ADD COLUMN IF NOT EXISTS cost_per_month NUMERIC;
