// Entitlement Repository
// Per Section 13: Entitlement snapshots
// Per Section 15: Tenant-level quotas

import type { PoolClient } from 'pg';
import { billingStoppedSql, prepaidSpendFloorUsd } from '../billing/prepaid-floor';
import { getBillingProvider } from '../billing/provider';
import { withTenantScope, withAdminScope } from '../infrastructure/database';
import { Entitlement, EntitlementSnapshot, UpdateEntitlementInput } from './types';

// RLS note (FORCE census): `entitlements` and `entitlement_snapshots` are
// RLS-enabled. tenantId-bearing methods → withTenantScope. The operator
// list-all (findAll) carries no tenant context → withAdminScope. The *InTx
// variants take a caller-supplied client already scoped by the enclosing
// withAdminScope transaction (TenantService.provision), so they are untouched.

export interface CreateEntitlementInput {
  tenantId: string;
  // Capacity
  teamCount?: number;
  isCustomPricing?: boolean;
  tenantOperationalStatus?: 'pending' | 'active' | 'suspended' | 'churned';
  includedMonthlyCredits?: number;
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
  // Autonomous operation features
  scheduledAgentsEnabled?: boolean;
  agentDelegationEnabled?: boolean;
  crossAgentLearningEnabled?: boolean;
  autoReflectionEnabled?: boolean;
}

export class EntitlementRepository {
  // The served entitlement snapshot, plus the billing hard stop that belongs
  // with it.
  //
  // `billing_controls.suspended` is account-keyed and lives outside this table,
  // which is why the runtime's admission gate never saw it: the runtime reads a
  // cached copy of THIS row, while execution-guard reads
  // agent_execution_allowed AND billing_controls.suspended together. Two gates,
  // two different sets of facts, guaranteed to disagree eventually. Joining it
  // in here means both are computed from the same snapshot.
  //
  // LEFT JOIN, and COALESCE to FALSE: internal and exempt accounts have no
  // billing_controls row at all, and a missing row must never read as
  // suspended — that is the same rule execution-guard already follows.
  //
  // `billing_suspended` is the served stop signal, not the stored flag alone:
  // a pre-pay workspace past its allowance with a reload balance under the
  // prepaid floor reads as suspended too (billing/prepaid-floor.ts), so the
  // runtime's gates refuse new work before the balance is actually gone.
  async findByTenantId(tenantId: string): Promise<Entitlement | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT e.*, ${billingStoppedSql('$2')} AS billing_suspended
         FROM entitlements e
         JOIN tenants t ON t.id = e.tenant_id
         LEFT JOIN billing_controls bc ON bc.account_id = t.account_id
        WHERE e.tenant_id = $1`,
      [tenantId, prepaidSpendFloorUsd()]
    ));
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findAll(): Promise<Entitlement[]> {
    const result = await withAdminScope(
      { caller: 'entitlements.findAll', reason: 'operator list-all entitlements across tenants (no tenant filter)' },
      (client) => client.query(
        `SELECT e.*, ${billingStoppedSql('$1')} AS billing_suspended
           FROM entitlements e
           JOIN tenants t ON t.id = e.tenant_id
           LEFT JOIN billing_controls bc ON bc.account_id = t.account_id
          ORDER BY e.created_at DESC`,
        [prepaidSpendFloorUsd()],
      ),
    );
    return result.rows.map(this.mapRow);
  }

  async create(input: CreateEntitlementInput): Promise<Entitlement> {
    return withTenantScope(input.tenantId, (client) => this.insertRow(client, input));
  }

  // Transaction-scoped variant for use inside withAdminScope BEGIN/COMMIT.
  // Used by TenantService.provision for atomic tenant+member+entitlement creation.
  async createInTx(client: PoolClient, input: CreateEntitlementInput): Promise<Entitlement> {
    return this.insertRow(client, input);
  }

  private async insertRow(
    runner: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
    input: CreateEntitlementInput,
  ): Promise<Entitlement> {
    const result = await runner.query(
      `INSERT INTO entitlements (
        tenant_id,
        team_count,
        is_custom_pricing,
        tenant_operational_status,
        agent_execution_allowed,
        remaining_included_credits,
        overage_allowed,
        included_monthly_credits,
        overage_ceiling,
        advanced_analytics_enabled,
        shared_collaboration_enabled,
        human_experts_enabled,
        priority_support_enabled,
        dedicated_support_enabled,
        advanced_security_enabled,
        compliance_enabled,
        sso_enabled,
        overage_protection_enabled,
        custom_retention_enabled,
        scheduled_agents_enabled,
        agent_delegation_enabled,
        cross_agent_learning_enabled,
        auto_reflection_enabled
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      RETURNING *`,
      [
        input.tenantId,
        input.teamCount || 5, // Default to smallest tier
        input.isCustomPricing || false,
        input.tenantOperationalStatus || 'pending',
        // agent_execution_allowed. Under Stripe this starts FALSE and
        // provisionSubscription flips it once Stripe acknowledges a
        // subscription, so the flag records that a payment relationship exists.
        // With no billing system there is nothing to flip it, and a hardcoded
        // FALSE left every self-hosted tenant permanently unable to run an
        // agent — a workspace that accepts a request and then refuses to
        // execute it, for a reason no surface shows.
        getBillingProvider().agentExecutionAllowedOnProvision,
        input.includedMonthlyCredits || 0,
        true, // overage_allowed defaults to true
        input.includedMonthlyCredits || 0,
        input.overageCeiling || 1000,
        // Paid add-on features (all default to false)
        input.advancedAnalyticsEnabled || false,
        input.sharedCollaborationEnabled || false,
        input.humanExpertsEnabled || false,
        input.prioritySupportEnabled || false,
        input.dedicatedSupportEnabled || false,
        input.advancedSecurityEnabled || false,
        input.complianceEnabled || false,
        input.ssoEnabled || false,
        input.overageProtectionEnabled || false,
        input.customRetentionEnabled || false,
        // Autonomous operation features (all default to false)
        input.scheduledAgentsEnabled || false,
        input.agentDelegationEnabled || false,
        input.crossAgentLearningEnabled || false,
        input.autoReflectionEnabled || false,
      ]
    );
    return this.mapRow(result.rows[0] as Record<string, unknown>);
  }

  async update(tenantId: string, input: UpdateEntitlementInput): Promise<Entitlement> {
    return withTenantScope(tenantId, (client) => this.updateRow(client, tenantId, input));
  }

  // Transaction-scoped variant. Use from inside withAdminScope when the caller
  // doesn't have app.current_tenant_id set (e.g. TenantService.activate /
  // suspend / reactivate at signup time or admin-initiated state changes).
  async updateInTx(client: PoolClient, tenantId: string, input: UpdateEntitlementInput): Promise<Entitlement> {
    return this.updateRow(client, tenantId, input);
  }

  private async updateRow(
    runner: { query: <T = unknown>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> },
    tenantId: string,
    input: UpdateEntitlementInput,
  ): Promise<Entitlement> {
    const result = await runner.query<Record<string, unknown>>(
      `UPDATE entitlements SET
        team_count = COALESCE($2, team_count),
        is_custom_pricing = COALESCE($3, is_custom_pricing),
        tenant_operational_status = COALESCE($4, tenant_operational_status),
        agent_execution_allowed = COALESCE($5, agent_execution_allowed),
        remaining_included_credits = COALESCE($6, remaining_included_credits),
        overage_allowed = COALESCE($7, overage_allowed),
        included_monthly_credits = COALESCE($8, included_monthly_credits),
        overage_ceiling = COALESCE($9, overage_ceiling),
        advanced_analytics_enabled = COALESCE($10, advanced_analytics_enabled),
        shared_collaboration_enabled = COALESCE($11, shared_collaboration_enabled),
        human_experts_enabled = COALESCE($12, human_experts_enabled),
        priority_support_enabled = COALESCE($13, priority_support_enabled),
        dedicated_support_enabled = COALESCE($14, dedicated_support_enabled),
        advanced_security_enabled = COALESCE($15, advanced_security_enabled),
        compliance_enabled = COALESCE($16, compliance_enabled),
        sso_enabled = COALESCE($17, sso_enabled),
        overage_protection_enabled = COALESCE($18, overage_protection_enabled),
        custom_retention_enabled = COALESCE($19, custom_retention_enabled),
        scheduled_agents_enabled = COALESCE($20, scheduled_agents_enabled),
        agent_delegation_enabled = COALESCE($21, agent_delegation_enabled),
        cross_agent_learning_enabled = COALESCE($22, cross_agent_learning_enabled),
        auto_reflection_enabled = COALESCE($23, auto_reflection_enabled),
        version = version + 1,
        updated_at = NOW()
       WHERE tenant_id = $1 RETURNING *`,
      [
        tenantId,
        input.teamCount,
        input.isCustomPricing,
        input.tenantOperationalStatus,
        input.agentExecutionAllowed,
        input.remainingIncludedCredits,
        input.overageAllowed,
        input.includedMonthlyCredits,
        input.overageCeiling,
        input.advancedAnalyticsEnabled,
        input.sharedCollaborationEnabled,
        input.humanExpertsEnabled,
        input.prioritySupportEnabled,
        input.dedicatedSupportEnabled,
        input.advancedSecurityEnabled,
        input.complianceEnabled,
        input.ssoEnabled,
        input.overageProtectionEnabled,
        input.customRetentionEnabled,
        input.scheduledAgentsEnabled,
        input.agentDelegationEnabled,
        input.crossAgentLearningEnabled,
        input.autoReflectionEnabled,
      ]
    );
    if (!result.rows[0]) {
      throw new Error(`Entitlement not found for tenant: ${tenantId}`);
    }
    return this.mapRow(result.rows[0] as Record<string, unknown>);
  }

  // Per Section 13: Create entitlement snapshot for billing disputes
  async createSnapshot(
    entitlement: Entitlement,
    reason: 'periodic' | 'billing_cycle' | 'entitlement_change' | 'dispute_request',
    billingPeriodStart?: Date,
    billingPeriodEnd?: Date
  ): Promise<EntitlementSnapshot> {
    const result = await withTenantScope(entitlement.tenantId, (client) => client.query(
      `INSERT INTO entitlement_snapshots (
        tenant_id,
        entitlement_id,
        entitlement_version,
        team_count,
        is_custom_pricing,
        tenant_operational_status,
        agent_execution_allowed,
        remaining_included_credits,
        overage_allowed,
        included_monthly_credits,
        overage_ceiling,
        advanced_analytics_enabled,
        shared_collaboration_enabled,
        human_experts_enabled,
        priority_support_enabled,
        dedicated_support_enabled,
        advanced_security_enabled,
        compliance_enabled,
        sso_enabled,
        overage_protection_enabled,
        custom_retention_enabled,
        scheduled_agents_enabled,
        agent_delegation_enabled,
        cross_agent_learning_enabled,
        auto_reflection_enabled,
        snapshot_reason,
        billing_period_start,
        billing_period_end,
        snapshot_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, NOW())
      RETURNING *`,
      [
        entitlement.tenantId,
        entitlement.id,
        entitlement.version,
        entitlement.teamCount,
        entitlement.isCustomPricing,
        entitlement.tenantOperationalStatus,
        entitlement.agentExecutionAllowed,
        entitlement.remainingIncludedCredits,
        entitlement.overageAllowed,
        entitlement.includedMonthlyCredits,
        entitlement.overageCeiling,
        entitlement.advancedAnalyticsEnabled,
        entitlement.sharedCollaborationEnabled,
        entitlement.humanExpertsEnabled,
        entitlement.prioritySupportEnabled,
        entitlement.dedicatedSupportEnabled,
        entitlement.advancedSecurityEnabled,
        entitlement.complianceEnabled,
        entitlement.ssoEnabled,
        entitlement.overageProtectionEnabled,
        entitlement.customRetentionEnabled,
        entitlement.scheduledAgentsEnabled,
        entitlement.agentDelegationEnabled,
        entitlement.crossAgentLearningEnabled,
        entitlement.autoReflectionEnabled,
        reason,
        billingPeriodStart || null,
        billingPeriodEnd || null,
      ]
    ));
    return this.mapSnapshotRow(result.rows[0]);
  }

  // Per Section 13: Get snapshot at a specific point in time (for dispute resolution)
  async findSnapshotAtTime(tenantId: string, targetTime: Date): Promise<EntitlementSnapshot | null> {
    // Find the most recent snapshot before the target time
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM entitlement_snapshots
       WHERE tenant_id = $1 AND snapshot_at <= $2
       ORDER BY snapshot_at DESC
       LIMIT 1`,
      [tenantId, targetTime]
    ));
    return result.rows[0] ? this.mapSnapshotRow(result.rows[0]) : null;
  }

  // Per Section 13: Get snapshots for a billing period
  async findSnapshotsByBillingPeriod(
    tenantId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<EntitlementSnapshot[]> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM entitlement_snapshots
       WHERE tenant_id = $1
         AND ((billing_period_start = $2 AND billing_period_end = $3)
              OR (snapshot_at BETWEEN $2 AND $3))
       ORDER BY snapshot_at DESC`,
      [tenantId, periodStart, periodEnd]
    ));
    return result.rows.map(this.mapSnapshotRow);
  }

  // Per Section 13: Get all snapshots for a tenant (for audit)
  async findSnapshotsByTenantId(
    tenantId: string,
    limit = 100
  ): Promise<EntitlementSnapshot[]> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM entitlement_snapshots
       WHERE tenant_id = $1
       ORDER BY snapshot_at DESC
       LIMIT $2`,
      [tenantId, limit]
    ));
    return result.rows.map(this.mapSnapshotRow);
  }

  private mapRow(row: Record<string, unknown>): Entitlement {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      version: row.version as number,
      // Capacity
      teamCount: row.team_count as number,
      isCustomPricing: row.is_custom_pricing as boolean,
      tenantOperationalStatus: row.tenant_operational_status as 'pending' | 'active' | 'suspended' | 'churned',
      agentExecutionAllowed: row.agent_execution_allowed as boolean,
      // Only the READ paths join billing_controls. A row returned straight from
      // an INSERT/UPDATE ... RETURNING * carries no opinion on billing
      // suspension, and false is the safe rendering of "unknown" — the same
      // rule the LEFT JOIN's COALESCE follows. EntitlementService.update
      // re-reads the snapshot so what it returns and publishes is never this
      // placeholder.
      billingSuspended: (row.billing_suspended as boolean | undefined) ?? false,
      remainingIncludedCredits: row.remaining_included_credits as number,
      overageAllowed: row.overage_allowed as boolean,
      includedMonthlyCredits: row.included_monthly_credits as number,
      overageCeiling: row.overage_ceiling as number,
      // Paid add-on features
      advancedAnalyticsEnabled: row.advanced_analytics_enabled as boolean,
      sharedCollaborationEnabled: row.shared_collaboration_enabled as boolean,
      humanExpertsEnabled: row.human_experts_enabled as boolean,
      prioritySupportEnabled: row.priority_support_enabled as boolean,
      dedicatedSupportEnabled: row.dedicated_support_enabled as boolean,
      advancedSecurityEnabled: row.advanced_security_enabled as boolean,
      complianceEnabled: row.compliance_enabled as boolean,
      ssoEnabled: row.sso_enabled as boolean,
      overageProtectionEnabled: row.overage_protection_enabled as boolean,
      customRetentionEnabled: row.custom_retention_enabled as boolean,
      // Autonomous operation features
      scheduledAgentsEnabled: row.scheduled_agents_enabled as boolean,
      agentDelegationEnabled: row.agent_delegation_enabled as boolean,
      crossAgentLearningEnabled: row.cross_agent_learning_enabled as boolean,
      autoReflectionEnabled: row.auto_reflection_enabled as boolean,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }

  private mapSnapshotRow(row: Record<string, unknown>): EntitlementSnapshot {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      entitlementId: row.entitlement_id as string,
      entitlementVersion: row.entitlement_version as number,
      // Capacity
      teamCount: row.team_count as number,
      isCustomPricing: row.is_custom_pricing as boolean,
      tenantOperationalStatus: row.tenant_operational_status as 'pending' | 'active' | 'suspended' | 'churned',
      agentExecutionAllowed: row.agent_execution_allowed as boolean,
      remainingIncludedCredits: row.remaining_included_credits as number,
      overageAllowed: row.overage_allowed as boolean,
      includedMonthlyCredits: row.included_monthly_credits as number,
      overageCeiling: row.overage_ceiling as number,
      // Paid add-on features
      advancedAnalyticsEnabled: row.advanced_analytics_enabled as boolean,
      sharedCollaborationEnabled: row.shared_collaboration_enabled as boolean,
      humanExpertsEnabled: row.human_experts_enabled as boolean,
      prioritySupportEnabled: row.priority_support_enabled as boolean,
      dedicatedSupportEnabled: row.dedicated_support_enabled as boolean,
      advancedSecurityEnabled: row.advanced_security_enabled as boolean,
      complianceEnabled: row.compliance_enabled as boolean,
      ssoEnabled: row.sso_enabled as boolean,
      overageProtectionEnabled: row.overage_protection_enabled as boolean,
      customRetentionEnabled: row.custom_retention_enabled as boolean,
      // Autonomous operation features
      scheduledAgentsEnabled: row.scheduled_agents_enabled as boolean,
      agentDelegationEnabled: row.agent_delegation_enabled as boolean,
      crossAgentLearningEnabled: row.cross_agent_learning_enabled as boolean,
      autoReflectionEnabled: row.auto_reflection_enabled as boolean,
      // Snapshot metadata
      snapshotReason: row.snapshot_reason as 'periodic' | 'billing_cycle' | 'entitlement_change' | 'dispute_request',
      billingPeriodStart: row.billing_period_start as Date | undefined,
      billingPeriodEnd: row.billing_period_end as Date | undefined,
      snapshotAt: row.snapshot_at as Date,
      createdAt: row.created_at as Date,
    };
  }
}
