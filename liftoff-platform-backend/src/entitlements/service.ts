// Entitlement Service Implementation
// Per Section 13: Entitlement snapshots

import { Entitlement, EntitlementSnapshot, UpdateEntitlementInput } from './types';
import { EntitlementRepository, CreateEntitlementInput } from './repository';
import { publishEvent } from '../events/publisher';

export class EntitlementService {
  private repository = new EntitlementRepository();

  async getByTenantId(tenantId: string): Promise<Entitlement | null> {
    return this.repository.findByTenantId(tenantId);
  }

  async listAll(): Promise<Entitlement[]> {
    return this.repository.findAll();
  }

  async create(input: CreateEntitlementInput): Promise<Entitlement> {
    return this.repository.create(input);
  }

  async update(tenantId: string, input: UpdateEntitlementInput): Promise<Entitlement> {
    // Per Section 13: Create snapshot before updating for audit trail
    const existingEntitlement = await this.repository.findByTenantId(tenantId);
    if (existingEntitlement) {
      await this.repository.createSnapshot(existingEntitlement, 'entitlement_change');
    }

    const updated = await this.repository.update(tenantId, input);
    // Re-read through the snapshot query so `billingSuspended` is the joined
    // truth rather than the UPDATE ... RETURNING * placeholder. What we return
    // and what we publish must be the same thing the runtime will fetch.
    const entitlement = (await this.repository.findByTenantId(tenantId)) ?? updated;

    // Per Section 4: Publish tenant.entitlement.updated event
    await publishEvent({
      entityType: 'entitlement',
      entityId: entitlement.id,
      eventType: 'tenant.entitlement.updated',
      entityVersion: entitlement.version,
      eventVersion: 1,
      tenantId,
      payload: {
        tenantOperationalStatus: entitlement.tenantOperationalStatus,
        agentExecutionAllowed: entitlement.agentExecutionAllowed,
        billingSuspended: entitlement.billingSuspended,
        remainingIncludedCredits: entitlement.remainingIncludedCredits,
        overageAllowed: entitlement.overageAllowed,
      },
    });

    return entitlement;
  }

  /**
   * Turn agent execution on for a tenant.
   *
   * The single entry point for `agent_execution_allowed = TRUE`. Three call
   * sites used to issue that UPDATE as raw SQL — tenant activation with an
   * already-active subscription, the subscription-activated webhook, and the
   * provisioning outbox worker. All three bypassed `version = version + 1` and
   * published no event, so a tenant could be cleared to run agents while every
   * consumer of the entitlement snapshot still believed it was not: the
   * runtime's cached copy kept the old value, and (because the cache refresh
   * was version-guarded) had no way to learn otherwise.
   *
   * Routing them through the service means the version moves and
   * `tenant.entitlement.updated` fires, which is what makes the change
   * observable downstream.
   *
   * A no-op when execution is ALREADY allowed. Every caller sits behind a
   * retried webhook or a retried outbox row, and `update` is not free: it
   * writes an entitlement_snapshots row and publishes an event. Only a real
   * flip should produce either. Returns null when there is nothing to do —
   * including when the tenant has no entitlement row, which `update` would
   * throw on.
   */
  async enableAgentExecution(tenantId: string): Promise<Entitlement | null> {
    const existing = await this.repository.findByTenantId(tenantId);
    if (!existing || existing.agentExecutionAllowed) return null;
    return this.update(tenantId, { agentExecutionAllowed: true });
  }

  // Per Section 13: Entitlement snapshots for billing disputes

  // Create snapshot for billing cycle (called at start of billing period)
  async createBillingCycleSnapshot(
    tenantId: string,
    billingPeriodStart: Date,
    billingPeriodEnd: Date
  ): Promise<EntitlementSnapshot> {
    const entitlement = await this.repository.findByTenantId(tenantId);
    if (!entitlement) {
      throw new Error(`Entitlement not found for tenant: ${tenantId}`);
    }
    return this.repository.createSnapshot(
      entitlement,
      'billing_cycle',
      billingPeriodStart,
      billingPeriodEnd
    );
  }

  // Create snapshot on dispute request (for dispute resolution)
  async createDisputeSnapshot(tenantId: string): Promise<EntitlementSnapshot> {
    const entitlement = await this.repository.findByTenantId(tenantId);
    if (!entitlement) {
      throw new Error(`Entitlement not found for tenant: ${tenantId}`);
    }
    return this.repository.createSnapshot(entitlement, 'dispute_request');
  }

  // Get entitlement state at a specific point in time (for dispute resolution)
  async getEntitlementAtTime(
    tenantId: string,
    targetTime: Date
  ): Promise<EntitlementSnapshot | null> {
    return this.repository.findSnapshotAtTime(tenantId, targetTime);
  }

  // Get snapshots for a billing period
  async getSnapshotsForBillingPeriod(
    tenantId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<EntitlementSnapshot[]> {
    return this.repository.findSnapshotsByBillingPeriod(tenantId, periodStart, periodEnd);
  }

  // Get all snapshots for audit
  async getSnapshotHistory(
    tenantId: string,
    limit = 100
  ): Promise<EntitlementSnapshot[]> {
    return this.repository.findSnapshotsByTenantId(tenantId, limit);
  }

  // Sync entitlements from subscription (used for webhook processing)
  async syncFromSubscription(input: {
    accountId: string;
    tenantId: string;
    stripeSubscriptionId: string;
    stripePriceId?: string;
    stripeProductId?: string;
    status: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
  }): Promise<void> {
    const existingEntitlement = await this.repository.findByTenantId(input.tenantId);

    if (existingEntitlement) {
      // Update existing entitlement
      await this.repository.update(input.tenantId, {
        tenantOperationalStatus: input.status === 'active' ? 'active' : 'suspended',
      });
    } else {
      // Create new entitlement with defaults (credits are the limiter now)
      await this.repository.create({
        tenantId: input.tenantId,
        tenantOperationalStatus: 'active',
      });
    }
  }

  // Update operational status (used for webhook processing)
  async updateOperationalStatus(
    tenantId: string,
    status: 'pending' | 'active' | 'suspended' | 'churned'
  ): Promise<void> {
    await this.repository.update(tenantId, { tenantOperationalStatus: status });
  }

  // Revoke entitlements for tenant (used for cancellation)
  async revokeForTenant(tenantId: string): Promise<void> {
    await this.repository.update(tenantId, { tenantOperationalStatus: 'suspended' });
  }
}
