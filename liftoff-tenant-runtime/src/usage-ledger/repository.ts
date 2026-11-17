// Usage Ledger Repository

import { pool } from '../infrastructure/database';
import { UsageEvent, BurnState, RefundInput } from './types';
import { uuidOrNull } from '../agent-execution/run-identity';

export class UsageLedgerRepository {
  async recordEvent(event: UsageEvent): Promise<void> {
    await pool.query(
      `INSERT INTO usage_events (tenant_id, agent_id, workflow_id, action_id, event_type, credits, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.tenantId,
        event.agentId,
        // workflow_id and action_id are nullable uuid columns (migration 081
        // dropped NOT NULL on workflow_id). A blank or a non-uuid label is not
        // an id and the column rejects it; NULL is the correct value for an
        // event with no workflow, and it keeps the record.
        uuidOrNull(event.workflowId),
        uuidOrNull(event.actionId),
        event.eventType,
        event.credits,
        JSON.stringify(event.metadata),
      ]
    );
  }

  // burn_state is no longer written. The decrement lived here; its only callers
  // were recordUsage and processRefund, and the counter it maintained gated
  // nothing after the credit admission check was removed. Reads survive for
  // reporting until the table is dropped.
  async getBurnState(tenantId: string): Promise<BurnState> {
    const result = await pool.query(
      `SELECT * FROM burn_state WHERE tenant_id = $1`,
      [tenantId]
    );

    if (!result.rows[0]) {
      throw new Error('Burn state not found');
    }

    return {
      tenantId: result.rows[0].tenant_id,
      billingPeriodStart: result.rows[0].billing_period_start,
      billingPeriodEnd: result.rows[0].billing_period_end,
      includedCredits: result.rows[0].included_credits,
      usedCredits: result.rows[0].used_credits,
      remainingCredits: result.rows[0].remaining_credits,
      overageCredits: result.rows[0].overage_credits,
      lastUpdated: result.rows[0].last_updated,
    };
  }

  async recordRefund(input: RefundInput): Promise<void> {
    await pool.query(
      `INSERT INTO refunds (tenant_id, action_id, credits, reason)
       VALUES ($1, $2, $3, $4)`,
      [input.tenantId, input.actionId, input.credits, input.reason]
    );
  }

  // getEntitlement() is gone with it. It read the legacy credit columns
  // (overage_allowed / overage_ceiling / overage_credits) purely to feed the
  // ledger's own credit-admission checks, which no longer exist. Entitlement
  // reads belong to entitlements-client, which owns the cache.
}
