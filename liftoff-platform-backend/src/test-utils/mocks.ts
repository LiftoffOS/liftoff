/// <reference types="jest" />
// Shared Mock Factories for Liftoff Platform Backend Tests
// Provides reusable mock implementations for external dependencies

import { Account } from '../accounts/types';
import { Subscription } from '../subscriptions/types';
import { Entitlement } from '../entitlements/types';
import { Tenant } from '../tenants/types';

// ============================================================
// Mock Data Factories
// ============================================================

export function createMockAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc_test_123',
    firebaseUid: 'firebase_test_123',
    firstName: 'Test',
    lastName: 'Account',
    email: 'test@example.com',
    timezone: 'America/Los_Angeles',
    avatarUrl: null,
    stripeCustomerId: 'cus_test_123',
    pendingEmail: null,
    emailVerificationToken: null,
    emailVerificationExpiry: null,
    preferences: {},
    version: 1,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    deletedAt: null,
    isInternal: false,
    isPlatformAdmin: false,
    accessStatus: 'pending',
    ...overrides,
  };
}

export function createMockSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_test_123',
    accountId: 'acc_test_123',
    planId: 'plan_test_123',
    stripeSubscriptionId: 'sub_stripe_123',
    status: 'active',
    version: 1,
    currentPeriodStart: new Date('2024-01-01T00:00:00Z'),
    currentPeriodEnd: new Date('2024-02-01T00:00:00Z'),
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function createMockEntitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    id: 'ent_test_123',
    tenantId: 'tenant_test_123',
    version: 1,
    // Capacity
    teamCount: 10,
    isCustomPricing: false,
    tenantOperationalStatus: 'active',
    agentExecutionAllowed: true,
    // Derived from billing_controls by the snapshot read, not stored on the row.
    billingSuspended: false,
    remainingIncludedCredits: 1000,
    overageAllowed: true,
    includedMonthlyCredits: 1000,
    overageCeiling: 1000,
    // Paid add-on features
    advancedAnalyticsEnabled: false,
    sharedCollaborationEnabled: false,
    humanExpertsEnabled: false,
    prioritySupportEnabled: false,
    dedicatedSupportEnabled: false,
    advancedSecurityEnabled: false,
    complianceEnabled: false,
    ssoEnabled: false,
    overageProtectionEnabled: false,
    customRetentionEnabled: false,
    // Per Phase H3: Autonomous operation features (add-ons)
    scheduledAgentsEnabled: false,
    agentDelegationEnabled: false,
    crossAgentLearningEnabled: false,
    autoReflectionEnabled: false,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function createMockTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 'tenant_test_123',
    accountId: 'acc_test_123',
    name: 'Test Tenant',
    tier: 'standard',
    hostingMode: 'shared',
    status: 'pending',
    gcpProjectId: null,
    databaseName: null,
    runtimeUrl: null,
    migrationStatus: 'pending',
    hasCreatedInternalAgent: false,
    harvestEnabled: true,
    onboardingStep: 0,
    onboardingPersona: null,
    onboardingCompletedAt: null,
    onboardingPath: null,
    onboardingStepId: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ============================================================
// Database Pool Mock
// ============================================================

export interface MockPoolQuery {
  rows: Record<string, unknown>[];
  rowCount?: number;
}

export function createMockPool() {
  const mockQuery = jest.fn<Promise<MockPoolQuery>, [string, unknown[]?]>();

  return {
    query: mockQuery,
    connect: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
    // Helper methods for tests
    mockQueryResult: (result: MockPoolQuery) => {
      mockQuery.mockResolvedValueOnce(result);
    },
    mockQueryError: (error: Error) => {
      mockQuery.mockRejectedValueOnce(error);
    },
  };
}

// ============================================================
// Stripe Mock
// ============================================================

export interface MockStripeCustomer {
  id: string;
  email: string;
  name: string;
  metadata: Record<string, string>;
}

export interface MockStripeSubscription {
  id: string;
  customer: string;
  status: string;
  items: { data: { price: { id: string } }[] };
  pause_collection?: { behavior: string } | null;
}

export function createMockStripe() {
  const mockCustomersCreate = jest.fn<Promise<MockStripeCustomer>, [unknown]>();
  const mockCustomersUpdate = jest.fn<Promise<MockStripeCustomer>, [string, unknown]>();
  const mockSubscriptionsCreate = jest.fn<Promise<MockStripeSubscription>, [unknown]>();
  const mockSubscriptionsUpdate = jest.fn<Promise<MockStripeSubscription>, [string, unknown]>();
  const mockSubscriptionsCancel = jest.fn<Promise<MockStripeSubscription>, [string]>();

  return {
    customers: {
      create: mockCustomersCreate,
      update: mockCustomersUpdate,
    },
    subscriptions: {
      create: mockSubscriptionsCreate,
      update: mockSubscriptionsUpdate,
      cancel: mockSubscriptionsCancel,
    },
    // Helper methods for tests
    mockCustomerCreate: (customer: MockStripeCustomer) => {
      mockCustomersCreate.mockResolvedValueOnce(customer);
    },
    mockCustomerUpdate: (customer: MockStripeCustomer) => {
      mockCustomersUpdate.mockResolvedValueOnce(customer);
    },
    mockSubscriptionCreate: (subscription: MockStripeSubscription) => {
      mockSubscriptionsCreate.mockResolvedValueOnce(subscription);
    },
    mockSubscriptionUpdate: (subscription: MockStripeSubscription) => {
      mockSubscriptionsUpdate.mockResolvedValueOnce(subscription);
    },
    mockSubscriptionCancel: (subscription: MockStripeSubscription) => {
      mockSubscriptionsCancel.mockResolvedValueOnce(subscription);
    },
  };
}

// ============================================================
// PubSub Mock
// ============================================================

export function createMockPubSub() {
  const mockPublishMessage = jest.fn<Promise<string>, [unknown]>();
  const mockTopic = jest.fn(() => ({
    publishMessage: mockPublishMessage,
  }));

  return {
    topic: mockTopic,
    publishMessage: mockPublishMessage,
    // Helper methods for tests
    mockPublish: (messageId: string) => {
      mockPublishMessage.mockResolvedValueOnce(messageId);
    },
    mockPublishError: (error: Error) => {
      mockPublishMessage.mockRejectedValueOnce(error);
    },
  };
}

// ============================================================
// Secret Manager Mock
// ============================================================

export function createMockSecretManager() {
  const mockAccessSecretVersion = jest.fn<Promise<[{ payload: { data: Buffer | string } }]>, [{ name: string }]>();

  return {
    accessSecretVersion: mockAccessSecretVersion,
    // Helper methods for tests
    mockSecret: (secretValue: string) => {
      mockAccessSecretVersion.mockResolvedValueOnce([{
        payload: { data: Buffer.from(secretValue) },
      }]);
    },
    mockSecretError: (error: Error) => {
      mockAccessSecretVersion.mockRejectedValueOnce(error);
    },
  };
}

// ============================================================
// Database Row Mappers (for creating mock DB responses)
// ============================================================

export function accountToDbRow(account: Account): Record<string, unknown> {
  return {
    id: account.id,
    firebase_uid: account.firebaseUid,
    first_name: account.firstName,
    last_name: account.lastName,
    email: account.email,
    timezone: account.timezone,
    avatar_url: account.avatarUrl,
    stripe_customer_id: account.stripeCustomerId,
    pending_email: account.pendingEmail,
    email_verification_token: account.emailVerificationToken,
    email_verification_expiry: account.emailVerificationExpiry,
    preferences: account.preferences,
    version: account.version,
    created_at: account.createdAt,
    updated_at: account.updatedAt,
  };
}

export function subscriptionToDbRow(subscription: Subscription): Record<string, unknown> {
  return {
    id: subscription.id,
    account_id: subscription.accountId,
    plan_id: subscription.planId,
    stripe_subscription_id: subscription.stripeSubscriptionId,
    status: subscription.status,
    version: subscription.version,
    current_period_start: subscription.currentPeriodStart,
    current_period_end: subscription.currentPeriodEnd,
    created_at: subscription.createdAt,
    updated_at: subscription.updatedAt,
  };
}

export function entitlementToDbRow(entitlement: Entitlement): Record<string, unknown> {
  return {
    id: entitlement.id,
    tenant_id: entitlement.tenantId,
    version: entitlement.version,
    // Capacity
    team_count: entitlement.teamCount,
    is_custom_pricing: entitlement.isCustomPricing,
    tenant_operational_status: entitlement.tenantOperationalStatus,
    agent_execution_allowed: entitlement.agentExecutionAllowed,
    remaining_included_credits: entitlement.remainingIncludedCredits,
    overage_allowed: entitlement.overageAllowed,
    included_monthly_credits: entitlement.includedMonthlyCredits,
    overage_ceiling: entitlement.overageCeiling,
    // Paid add-on features
    advanced_analytics_enabled: entitlement.advancedAnalyticsEnabled,
    shared_collaboration_enabled: entitlement.sharedCollaborationEnabled,
    human_experts_enabled: entitlement.humanExpertsEnabled,
    priority_support_enabled: entitlement.prioritySupportEnabled,
    dedicated_support_enabled: entitlement.dedicatedSupportEnabled,
    advanced_security_enabled: entitlement.advancedSecurityEnabled,
    compliance_enabled: entitlement.complianceEnabled,
    sso_enabled: entitlement.ssoEnabled,
    overage_protection_enabled: entitlement.overageProtectionEnabled,
    custom_retention_enabled: entitlement.customRetentionEnabled,
    // Autonomous operation features (add-ons)
    scheduled_agents_enabled: entitlement.scheduledAgentsEnabled,
    agent_delegation_enabled: entitlement.agentDelegationEnabled,
    cross_agent_learning_enabled: entitlement.crossAgentLearningEnabled,
    auto_reflection_enabled: entitlement.autoReflectionEnabled,
    created_at: entitlement.createdAt,
    updated_at: entitlement.updatedAt,
  };
}

export function tenantToDbRow(tenant: Tenant): Record<string, unknown> {
  return {
    id: tenant.id,
    account_id: tenant.accountId,
    name: tenant.name,
    tier: tenant.tier,
    hosting_mode: tenant.hostingMode,
    status: tenant.status,
    gcp_project_id: tenant.gcpProjectId,
    database_name: tenant.databaseName,
    runtime_url: tenant.runtimeUrl,
    migration_status: tenant.migrationStatus,
    has_created_internal_agent: tenant.hasCreatedInternalAgent,
    created_at: tenant.createdAt,
    updated_at: tenant.updatedAt,
  };
}

// ============================================================
// Jest Mock Setup Helpers
// ============================================================

export function setupDatabaseMock(mockPool: ReturnType<typeof createMockPool>) {
  jest.mock('../infrastructure/database', () => ({
    getPool: () => mockPool,
    initDatabase: jest.fn().mockResolvedValue(undefined),
  }));
}

export function setupEventPublisherMock() {
  const mockPublishEvent = jest.fn().mockResolvedValue(undefined);
  jest.mock('../events/publisher', () => ({
    publishEvent: mockPublishEvent,
    publishEvents: jest.fn().mockResolvedValue(undefined),
  }));
  return mockPublishEvent;
}

export function setupSecretsMock() {
  jest.mock('../infrastructure/secrets', () => ({
    getStripeSecretKey: jest.fn().mockResolvedValue('sk_test_mock'),
    getDbPassword: jest.fn().mockResolvedValue('mock_password'),
    getSecret: jest.fn().mockResolvedValue('mock_secret'),
    clearSecretCache: jest.fn(),
    initSecrets: jest.fn().mockResolvedValue(undefined),
  }));
}
