// Usage Ledger Service Implementation
// Per Section 12: Tenant runtime owns usage events, action-credit ledger,
// refunds/reversals, live burn state, runtime admission decisions

import { UsageEvent, BurnState, RefundInput } from './types';
import { UsageLedgerRepository } from './repository';
import { StripeMeterClient } from '../infrastructure/stripe-meter';
import { creditCostService, CreditCostLookup } from './credit-cost-service';
import { logger } from '../infrastructure/logging';

export class UsageLedgerService {
  private repository = new UsageLedgerRepository();
  private stripeMeter = new StripeMeterClient();

  // Per Section 13: Record usage events
  // Per Section 13: Stripe meters / meter events for usage billing
  async recordUsage(event: UsageEvent): Promise<void> {
    // Record in internal ledger first (source of truth per Section 13)
    await this.repository.recordEvent(event);

    // Update live burn state
    await this.repository.updateBurnState(event.tenantId, event.credits);

    // Per Section 13: Send meter event to Stripe for billing
    // Note: Meter events are processed asynchronously on Stripe's side
    try {
      await this.stripeMeter.sendMeterEvent({
        tenantId: event.tenantId,
        eventType: event.eventType,
        credits: event.credits,
        timestamp: new Date(),
        idempotencyKey: event.id || `${event.tenantId}-${event.actionId}-${Date.now()}`,
      });
    } catch (error) {
      // Per Section 13: Internal ledger remains the runtime source of truth
      // Log error but don't fail the operation - reconciliation will catch discrepancies
      logger.error({
        message: 'Failed to send meter event to Stripe',
        tenant_id: event.tenantId,
        error: (error as Error).message,
      });
    }
  }

  // Per Section 13: Live burn state
  async getBurnState(tenantId: string): Promise<BurnState> {
    return this.repository.getBurnState(tenantId);
  }

  // Per Section 13: Runtime admission decisions based on remaining credits
  async getRemainingCredits(tenantId: string): Promise<number> {
    const burn = await this.repository.getBurnState(tenantId);
    return burn.remainingCredits;
  }

  // Per Section 13: Refunds/reversals
  async processRefund(input: RefundInput): Promise<void> {
    await this.repository.recordRefund(input);

    // Update burn state
    await this.repository.updateBurnState(input.tenantId, -input.credits);
  }

  // Per Section 15: Admission control check
  async checkAdmission(tenantId: string, requiredCredits: number): Promise<boolean> {
    const remaining = await this.getRemainingCredits(tenantId);
    const entitlement = await this.repository.getEntitlement(tenantId);

    if (remaining < requiredCredits) {
      // Check if overage is allowed
      if (!entitlement.overageAllowed) {
        return false;
      }
    }

    return true;
  }

  // Per Section 12: Record usage with automatic credit cost lookup
  async recordUsageWithCostLookup(
    tenantId: string,
    agentId: string,
    workflowId: string,
    actionId: string,
    actionType: string,
    connector?: string,
    metadata: Record<string, any> = {}
  ): Promise<{ recorded: boolean; credits: number }> {
    // Look up credit cost for this action
    const credits = await creditCostService.getCreditCost(tenantId, {
      actionType,
      connector,
    });

    const event: UsageEvent = {
      tenantId,
      agentId,
      workflowId,
      actionId,
      eventType: actionType,
      credits,
      metadata: {
        ...metadata,
        connector,
        costLookup: true,
      },
    };

    await this.recordUsage(event);

    logger.info('Usage recorded with cost lookup', {
      tenantId,
      actionType,
      connector,
      credits,
    });

    return { recorded: true, credits };
  }

  // Per Section 12: Estimate credits for planned actions
  async estimateCredits(
    tenantId: string,
    actions: CreditCostLookup[]
  ): Promise<{ total: number; breakdown: { action: CreditCostLookup; credits: number }[] }> {
    return creditCostService.estimateCredits(tenantId, actions);
  }

  // Per Section 12: Admission check with automatic cost estimation
  async checkAdmissionWithEstimate(
    tenantId: string,
    plannedActions: CreditCostLookup[]
  ): Promise<{ admitted: boolean; estimatedCredits: number; remainingCredits: number; reason?: string }> {
    // Estimate total credits needed
    const estimate = await this.estimateCredits(tenantId, plannedActions);
    const remaining = await this.getRemainingCredits(tenantId);
    const entitlement = await this.repository.getEntitlement(tenantId);

    if (remaining < estimate.total) {
      // Check if overage is allowed
      if (!entitlement.overageAllowed) {
        return {
          admitted: false,
          estimatedCredits: estimate.total,
          remainingCredits: remaining,
          reason: 'Insufficient credits and overage not allowed',
        };
      }

      // Check overage ceiling if applicable
      const overageCeiling = entitlement.overageCeiling || 0;
      const currentOverage = entitlement.overageCredits || 0;
      const projectedOverage = estimate.total - remaining;

      if (currentOverage + projectedOverage > overageCeiling) {
        return {
          admitted: false,
          estimatedCredits: estimate.total,
          remainingCredits: remaining,
          reason: 'Would exceed overage ceiling',
        };
      }
    }

    return {
      admitted: true,
      estimatedCredits: estimate.total,
      remainingCredits: remaining,
    };
  }

  // Get current cost model for a tenant
  async getCostModels(tenantId: string) {
    return creditCostService.listCostModels(tenantId);
  }

  // Update cost model for a tenant
  async updateCostModel(
    tenantId: string,
    actionType: string,
    creditsPerAction: number,
    connector?: string
  ) {
    return creditCostService.upsertCostModel(
      tenantId,
      actionType,
      creditsPerAction,
      connector
    );
  }
}

// Singleton instance for use across the runtime (same pattern as invocationsService)
export const usageLedgerService = new UsageLedgerService();
