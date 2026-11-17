// Overage Rules Service Implementation
// Per Section 13: Control plane owns overage rules

import { OverageRule, CreateOverageRuleInput, UpdateOverageRuleInput } from './types';
import { OverageRuleRepository } from './repository';
import { publishEvent } from '../events/publisher';

export class OverageRuleService {
  private repository = new OverageRuleRepository();

  async listAll(): Promise<OverageRule[]> {
    return this.repository.findAll();
  }

  async getById(id: string): Promise<OverageRule | null> {
    return this.repository.findById(id);
  }

  async getByTenantId(tenantId: string): Promise<OverageRule | null> {
    return this.repository.findByTenantId(tenantId);
  }

  async getByPlanId(planId: string): Promise<OverageRule[]> {
    return this.repository.findByPlanId(planId);
  }

  async create(input: CreateOverageRuleInput): Promise<OverageRule> {
    const rule = await this.repository.create(input);

    // Publish event for tenant runtime to update entitlements
    await publishEvent({
      entityType: 'overage_rule',
      entityId: rule.id,
      eventType: 'tenant.entitlement.updated',
      entityVersion: 1,
      eventVersion: 1,
      tenantId: rule.tenantId,
      payload: {
        overageRatePerCredit: rule.overageRatePerCredit,
        overageCeiling: rule.overageCeiling,
        notificationThreshold: rule.notificationThreshold,
      },
    });

    return rule;
  }

  async update(id: string, input: UpdateOverageRuleInput): Promise<OverageRule> {
    const rule = await this.repository.update(id, input);

    // Publish event for tenant runtime to update entitlements
    await publishEvent({
      entityType: 'overage_rule',
      entityId: rule.id,
      eventType: 'tenant.entitlement.updated',
      entityVersion: 1,
      eventVersion: 1,
      tenantId: rule.tenantId,
      payload: {
        overageRatePerCredit: rule.overageRatePerCredit,
        overageCeiling: rule.overageCeiling,
        notificationThreshold: rule.notificationThreshold,
      },
    });

    return rule;
  }

  async delete(id: string): Promise<void> {
    const rule = await this.repository.findById(id);
    if (rule) {
      await publishEvent({
        entityType: 'overage_rule',
        entityId: id,
        eventType: 'tenant.entitlement.updated',
        entityVersion: 1,
        eventVersion: 1,
        tenantId: rule.tenantId,
        payload: {
          overageRatePerCredit: 0,
          overageCeiling: null,
          deleted: true,
        },
      });
    }
    return this.repository.delete(id);
  }

  async upsertForTenant(tenantId: string, input: CreateOverageRuleInput): Promise<OverageRule> {
    const rule = await this.repository.upsertByTenantId(tenantId, input);

    await publishEvent({
      entityType: 'overage_rule',
      entityId: rule.id,
      eventType: 'tenant.entitlement.updated',
      entityVersion: 1,
      eventVersion: 1,
      tenantId: rule.tenantId,
      payload: {
        overageRatePerCredit: rule.overageRatePerCredit,
        overageCeiling: rule.overageCeiling,
        notificationThreshold: rule.notificationThreshold,
      },
    });

    return rule;
  }

  // Check if a tenant would exceed their overage ceiling
  async checkOverageLimit(tenantId: string, currentOverage: number, additionalUsage: number): Promise<{
    allowed: boolean;
    remainingBudget: number | null;
    wouldExceed: boolean;
  }> {
    const rule = await this.repository.findByTenantId(tenantId);

    if (!rule) {
      // No overage rule = no overage allowed
      return {
        allowed: false,
        remainingBudget: 0,
        wouldExceed: true,
      };
    }

    if (rule.overageCeiling === null) {
      // Unlimited overage
      return {
        allowed: true,
        remainingBudget: null,
        wouldExceed: false,
      };
    }

    const projectedOverage = currentOverage + additionalUsage;
    const wouldExceed = projectedOverage > rule.overageCeiling;
    const remainingBudget = Math.max(0, rule.overageCeiling - currentOverage);

    return {
      allowed: !wouldExceed,
      remainingBudget,
      wouldExceed,
    };
  }
}
