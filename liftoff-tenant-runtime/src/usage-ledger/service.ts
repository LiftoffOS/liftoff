// Usage Ledger Service Implementation
//
// The runtime's usage ledger is TELEMETRY, not authority. It records what
// happened (one row per action, in the action-credit unit) and the control
// plane's cost-attribution ingester reads those rows. It decides nothing.
//
// `burn_state` is decommissioned as a decision input. Its `remaining_credits`
// counter was seeded once by migration 033 and decremented by every usage
// event, with no monthly refill anywhere — monotonically negative for any
// active tenant — while the column it drained mixed three incompatible units.
// Nothing may read it to gate execution. The table and its reporting reads
// (burn snapshot, aggregation projections) survive for one release so
// dashboards can be confirmed clean before it is dropped; see the deprecation
// note on the migration.

import { UsageEvent, BurnState, RefundInput } from './types';
import { UsageLedgerRepository } from './repository';
import { creditCostService, CreditCostLookup } from './credit-cost-service';
import { logger } from '../infrastructure/logging';

export class UsageLedgerService {
  private repository = new UsageLedgerRepository();

  // Record usage events.
  //
  // History: this used to also call StripeMeterClient.sendMeterEvent directly,
  // but that was vestigial from the pre-Operating-Units architecture and the
  // try/catch silently swallowed an inevitable "no API key" error on every
  // call because agent-service is not configured with STRIPE_SECRET_KEY (by
  // design — only liftoff-billing talks to Stripe). Canonical flow per the
  // billing memory:
  //   1. TR writes usage_events to ledger here + emits invocation.completed
  //      Pub/Sub event with metadata.cost_micros attached
  //   2. PB cost-attribution subscriber ingests, runs applyOuConsumption +
  //      applyReloadDrain on billing_controls
  //   3. PB→billing spend-subscriber fires stripe.billing.meterEvents.create
  //      under the SINGLE `operating_unit_consumed` meter
  // Removed.
  async recordUsage(event: UsageEvent): Promise<void> {
    // The ledger row IS the record. No burn_state decrement: that counter fed
    // nothing but a dead admission gate, and every write pushed it further into
    // a negative number no refill ever reset.
    await this.repository.recordEvent(event);
  }

  // Reporting only — the burn snapshot rendered on usage surfaces. Never an
  // input to an execution decision.
  async getBurnState(tenantId: string): Promise<BurnState> {
    return this.repository.getBurnState(tenantId);
  }

  // Per Section 13: Refunds/reversals
  async processRefund(input: RefundInput): Promise<void> {
    await this.repository.recordRefund(input);
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
