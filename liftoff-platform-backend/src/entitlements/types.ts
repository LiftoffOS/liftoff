// Entitlement Types
// Per Section 13: Runtime-facing entitlement fields
// Per Section 15: Tenant-level quotas
// Per Phase H3: Autonomous agent operation features and limits
//
// Pricing Model:
// - Base: Pay per team count (5, 10, 25, 50, 75, 100, 200+)
// - Add-ons: Individually priced features toggled per tenant
// - Enterprise: Custom pricing via sales (isCustomPricing = true)
// - Credits are the primary usage limiter (capacity caps removed in Phase 1 entitlements rework)

export interface Entitlement {
  id: string;
  tenantId: string;
  version: number;

  // Capacity: Number of autonomous teams purchased
  teamCount: number;
  isCustomPricing: boolean; // Enterprise customers with custom contracts

  // Per Section 13: Runtime-facing entitlement fields
  tenantOperationalStatus: 'pending' | 'active' | 'suspended' | 'churned';
  agentExecutionAllowed: boolean;

  /**
   * `billing_controls.suspended` for this tenant's account, LEFT JOINed onto
   * the served snapshot so the tenant runtime's admission gate and this
   * plane's execution-guard stop on the same fact rather than on two
   * different halves of it.
   *
   * Derived, not stored on `entitlements`: `billing_controls` is account-keyed
   * and remains the only writer. FALSE when the account has no billing_controls
   * row (internal / exempt accounts), matching execution-guard's rule that a
   * missing row never blocks.
   */
  billingSuspended: boolean;

  /**
   * @deprecated Legacy "Section 13" credit fields. Retired from the decision
   * path — they are maintained by nothing (no plan, subscription or
   * billing_controls row has touched them since metering moved to
   * `billing_controls` + OU buckets), and the runtime gate that read them
   * denied a tenant at 0.008% of its real allowance. The columns and this
   * field survive so the wire contract does not break mid-rollout. Read them
   * for nothing new; spend authority is `billing_controls`.
   */
  remainingIncludedCredits: number;
  /** @deprecated See remainingIncludedCredits. */
  overageAllowed: boolean;
  /** @deprecated See remainingIncludedCredits. */
  includedMonthlyCredits: number;
  /** @deprecated See remainingIncludedCredits. */
  overageCeiling: number;

  // Paid add-on features (from PricingPage additionalFeatures)
  advancedAnalyticsEnabled: boolean;        // Advanced Analytics
  sharedCollaborationEnabled: boolean;      // Shared Collaboration Environment
  humanExpertsEnabled: boolean;             // Augment with Experts
  prioritySupportEnabled: boolean;          // Priority Email Support
  dedicatedSupportEnabled: boolean;         // Dedicated Support
  advancedSecurityEnabled: boolean;         // Advanced Security Features
  complianceEnabled: boolean;               // SOC2 & GDPR Compliance
  ssoEnabled: boolean;                      // SSO, SCIM/SAML, Audit Logs
  overageProtectionEnabled: boolean;        // Overage Protection
  customRetentionEnabled: boolean;          // Custom Data Retention

  // Per Phase H3: Autonomous operation FEATURE FLAGS (add-ons)
  scheduledAgentsEnabled: boolean;          // Can use cron-triggered agents
  agentDelegationEnabled: boolean;          // Agents can call other agents
  crossAgentLearningEnabled: boolean;       // Cross-agent pattern analysis
  autoReflectionEnabled: boolean;           // Automated reflection runs

  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateEntitlementInput {
  // Capacity
  teamCount?: number;
  isCustomPricing?: boolean;

  tenantOperationalStatus?: 'pending' | 'active' | 'suspended' | 'churned';
  agentExecutionAllowed?: boolean;

  // Legacy credit fields. Writable only so the admin surface that has always
  // written them keeps working; nothing reads them to decide anything.
  // `billingSuspended` is absent on purpose — it is derived from
  // billing_controls, which stays its only writer.
  /** @deprecated See Entitlement.remainingIncludedCredits. */
  remainingIncludedCredits?: number;
  /** @deprecated See Entitlement.remainingIncludedCredits. */
  overageAllowed?: boolean;
  /** @deprecated See Entitlement.remainingIncludedCredits. */
  includedMonthlyCredits?: number;
  /** @deprecated See Entitlement.remainingIncludedCredits. */
  overageCeiling?: number;

  // Paid add-on features
  advancedAnalyticsEnabled?: boolean;
  sharedCollaborationEnabled?: boolean;
  humanExpertsEnabled?: boolean;
  prioritySupportEnabled?: boolean;
  dedicatedSupportEnabled?: boolean;
  advancedSecurityEnabled?: boolean;
  complianceEnabled?: boolean;
  ssoEnabled?: boolean;
  overageProtectionEnabled?: boolean;
  customRetentionEnabled?: boolean;

  // Per Phase H3: Autonomous operation feature flags
  scheduledAgentsEnabled?: boolean;
  agentDelegationEnabled?: boolean;
  crossAgentLearningEnabled?: boolean;
  autoReflectionEnabled?: boolean;
}

// Per Section 13: Entitlement snapshots for billing disputes
// Captures the entitlement state at a point in time for audit/dispute resolution
export interface EntitlementSnapshot {
  id: string;
  tenantId: string;
  entitlementId: string;
  entitlementVersion: number;

  // Capacity
  teamCount: number;
  isCustomPricing: boolean;

  // Snapshot of entitlement state at the time
  tenantOperationalStatus: 'pending' | 'active' | 'suspended' | 'churned';
  agentExecutionAllowed: boolean;
  remainingIncludedCredits: number;
  overageAllowed: boolean;
  includedMonthlyCredits: number;
  overageCeiling: number;

  // Paid add-on features
  advancedAnalyticsEnabled: boolean;
  sharedCollaborationEnabled: boolean;
  humanExpertsEnabled: boolean;
  prioritySupportEnabled: boolean;
  dedicatedSupportEnabled: boolean;
  advancedSecurityEnabled: boolean;
  complianceEnabled: boolean;
  ssoEnabled: boolean;
  overageProtectionEnabled: boolean;
  customRetentionEnabled: boolean;

  // Per Phase H3: Autonomous operation feature flags
  scheduledAgentsEnabled: boolean;
  agentDelegationEnabled: boolean;
  crossAgentLearningEnabled: boolean;
  autoReflectionEnabled: boolean;

  // Snapshot metadata
  snapshotReason: 'periodic' | 'billing_cycle' | 'entitlement_change' | 'dispute_request';
  billingPeriodStart?: Date;
  billingPeriodEnd?: Date;
  snapshotAt: Date;
  createdAt: Date;
}

// Standard team tiers for pricing (matches PricingPage.tsx)
export const TEAM_TIERS = [5, 10, 25, 50, 75, 100, 200] as const;
export type TeamTier = typeof TEAM_TIERS[number];

// Base monthly price per team (yearly billing)
export const BASE_PRICE_PER_TEAM_YEARLY = 250;
export const BASE_PRICE_PER_TEAM_MONTHLY = 300;
