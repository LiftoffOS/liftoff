-- Per Phase H3: Add team count based pricing and paid add-on features
-- Pricing model: Base price per team count + individually toggled paid add-ons
-- No plan tiers - capacity scales with team count

-- ============================================================================
-- Add new columns to entitlements table
-- ============================================================================

-- Team count and custom pricing
ALTER TABLE entitlements
  ADD COLUMN IF NOT EXISTS team_count INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS is_custom_pricing BOOLEAN NOT NULL DEFAULT false;

-- Paid add-on features (from PricingPage additionalFeatures)
ALTER TABLE entitlements
  ADD COLUMN IF NOT EXISTS advanced_analytics_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shared_collaboration_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS human_experts_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS priority_support_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dedicated_support_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS advanced_security_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS compliance_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sso_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS overage_protection_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS custom_retention_enabled BOOLEAN NOT NULL DEFAULT false;

-- Autonomous operation features (add-ons per Phase H3)
ALTER TABLE entitlements
  ADD COLUMN IF NOT EXISTS scheduled_agents_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_delegation_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cross_agent_learning_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_reflection_enabled BOOLEAN NOT NULL DEFAULT false;

-- Autonomous operation limits
ALTER TABLE entitlements
  ADD COLUMN IF NOT EXISTS max_scheduled_agents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_delegations_per_hour INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_delegation_depth INTEGER NOT NULL DEFAULT 0;

-- ============================================================================
-- Add new columns to entitlement_snapshots table
-- ============================================================================

-- Team count and custom pricing
ALTER TABLE entitlement_snapshots
  ADD COLUMN IF NOT EXISTS team_count INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS is_custom_pricing BOOLEAN NOT NULL DEFAULT false;

-- Paid add-on features
ALTER TABLE entitlement_snapshots
  ADD COLUMN IF NOT EXISTS advanced_analytics_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shared_collaboration_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS human_experts_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS priority_support_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dedicated_support_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS advanced_security_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS compliance_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sso_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS overage_protection_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS custom_retention_enabled BOOLEAN NOT NULL DEFAULT false;

-- Autonomous operation features
ALTER TABLE entitlement_snapshots
  ADD COLUMN IF NOT EXISTS scheduled_agents_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_delegation_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cross_agent_learning_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_reflection_enabled BOOLEAN NOT NULL DEFAULT false;

-- Autonomous operation limits
ALTER TABLE entitlement_snapshots
  ADD COLUMN IF NOT EXISTS max_scheduled_agents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_delegations_per_hour INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_delegation_depth INTEGER NOT NULL DEFAULT 0;

-- ============================================================================
-- Add comments for documentation
-- ============================================================================

COMMENT ON COLUMN entitlements.team_count IS 'Number of autonomous teams purchased (pricing unit)';
COMMENT ON COLUMN entitlements.is_custom_pricing IS 'Enterprise customers with custom contracts via sales';
COMMENT ON COLUMN entitlements.advanced_analytics_enabled IS 'Paid add-on: Advanced Analytics';
COMMENT ON COLUMN entitlements.shared_collaboration_enabled IS 'Paid add-on: Shared Collaboration Environment';
COMMENT ON COLUMN entitlements.human_experts_enabled IS 'Paid add-on: Augment with Experts';
COMMENT ON COLUMN entitlements.priority_support_enabled IS 'Paid add-on: Priority Email Support';
COMMENT ON COLUMN entitlements.dedicated_support_enabled IS 'Paid add-on: Dedicated Support';
COMMENT ON COLUMN entitlements.advanced_security_enabled IS 'Paid add-on: Advanced Security Features';
COMMENT ON COLUMN entitlements.compliance_enabled IS 'Paid add-on: SOC2 & GDPR Compliance';
COMMENT ON COLUMN entitlements.sso_enabled IS 'Paid add-on: SSO, SCIM/SAML, Audit Logs';
COMMENT ON COLUMN entitlements.overage_protection_enabled IS 'Paid add-on: Overage Protection';
COMMENT ON COLUMN entitlements.custom_retention_enabled IS 'Paid add-on: Custom Data Retention';
COMMENT ON COLUMN entitlements.scheduled_agents_enabled IS 'Add-on: Cron-triggered agent execution';
COMMENT ON COLUMN entitlements.agent_delegation_enabled IS 'Add-on: Agent-to-agent delegation (agent.call)';
COMMENT ON COLUMN entitlements.cross_agent_learning_enabled IS 'Add-on: Cross-agent pattern analysis';
COMMENT ON COLUMN entitlements.auto_reflection_enabled IS 'Add-on: Automated daily/weekly reflection';
COMMENT ON COLUMN entitlements.max_scheduled_agents IS 'Limit: Max agents with cron triggers';
COMMENT ON COLUMN entitlements.max_delegations_per_hour IS 'Limit: Rate limit for agent.call()';
COMMENT ON COLUMN entitlements.max_delegation_depth IS 'Limit: Max delegation chain depth';
