// Usage Ledger Repository

import { pool } from '../infrastructure/database';
import { UsageEvent, BurnState, RefundInput } from './types';

export class UsageLedgerRepository {
  async recordEvent(event: UsageEvent): Promise<void> {
    await pool.query(
      `INSERT INTO usage_events (tenant_id, agent_id, workflow_id, action_id, event_type, credits, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.tenantId,
        event.agentId,
        event.workflowId,
        event.actionId,
        event.eventType,
        event.credits,
        JSON.stringify(event.metadata),
      ]
    );
  }

  async updateBurnState(tenantId: string, creditsDelta: number): Promise<void> {
    await pool.query(
      `UPDATE burn_state
       SET used_credits = used_credits + $2,
           remaining_credits = remaining_credits - $2,
           last_updated = NOW()
       WHERE tenant_id = $1`,
      [tenantId, creditsDelta]
    );
  }

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

  async getEntitlement(tenantId: string): Promise<any> {
    const result = await pool.query(
      `SELECT * FROM cached_entitlements WHERE tenant_id = $1`,
      [tenantId]
    );
    const row = result.rows[0];
    if (!row) return {};
    return {
      overageAllowed: row.overage_allowed ?? row.overageAllowed,
      overageCeiling: row.overage_ceiling ?? row.overageCeiling,
      overageCredits: row.overage_credits ?? row.overageCredits,
    };
  }
}
