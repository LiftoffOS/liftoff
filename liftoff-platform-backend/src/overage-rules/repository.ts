// Overage Rules Repository
// Per Section 13: Control plane owns overage rules
//
// RLS note (FORCE census): `overage_rules` is RLS-enabled. tenantId-bearing
// methods → withTenantScope. Operator by-PK ops (findById/update/delete),
// list-all (findAll), and the by-plan cross-tenant read (findByPlanId) carry no
// tenant context → withAdminScope.

import { withTenantScope, withAdminScope } from '../infrastructure/database';
import { OverageRule, CreateOverageRuleInput, UpdateOverageRuleInput } from './types';

export class OverageRuleRepository {
  async findAll(): Promise<OverageRule[]> {
    const result = await withAdminScope(
      { caller: 'overage-rules.findAll', reason: 'operator list-all overage rules across tenants (no tenant filter)' },
      (client) => client.query(`SELECT * FROM overage_rules ORDER BY created_at DESC`),
    );
    return result.rows.map(this.mapRow);
  }

  async findById(id: string): Promise<OverageRule | null> {
    const result = await withAdminScope(
      { caller: 'overage-rules.findById', reason: 'operator by-PK overage rule lookup (no tenant context)' },
      (client) => client.query(`SELECT * FROM overage_rules WHERE id = $1`, [id]),
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByTenantId(tenantId: string): Promise<OverageRule | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM overage_rules WHERE tenant_id = $1`,
      [tenantId]
    ));
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByPlanId(planId: string): Promise<OverageRule[]> {
    const result = await withAdminScope(
      { caller: 'overage-rules.findByPlanId', reason: 'cross-tenant read of overage rules for a plan (no tenant filter)' },
      (client) => client.query(`SELECT * FROM overage_rules WHERE plan_id = $1`, [planId]),
    );
    return result.rows.map(this.mapRow);
  }

  async create(input: CreateOverageRuleInput): Promise<OverageRule> {
    const result = await withTenantScope(input.tenantId, (client) => client.query(
      `INSERT INTO overage_rules (
        tenant_id, plan_id, overage_rate_per_credit, overage_ceiling,
        billing_threshold, notification_threshold
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        input.tenantId,
        input.planId,
        input.overageRatePerCredit,
        input.overageCeiling || null,
        input.billingThreshold || null,
        input.notificationThreshold || null,
      ]
    ));
    return this.mapRow(result.rows[0]);
  }

  async update(id: string, input: UpdateOverageRuleInput): Promise<OverageRule> {
    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.overageRatePerCredit !== undefined) {
      setClauses.push(`overage_rate_per_credit = $${paramIndex++}`);
      values.push(input.overageRatePerCredit);
    }
    if (input.overageCeiling !== undefined) {
      setClauses.push(`overage_ceiling = $${paramIndex++}`);
      values.push(input.overageCeiling);
    }
    if (input.billingThreshold !== undefined) {
      setClauses.push(`billing_threshold = $${paramIndex++}`);
      values.push(input.billingThreshold);
    }
    if (input.notificationThreshold !== undefined) {
      setClauses.push(`notification_threshold = $${paramIndex++}`);
      values.push(input.notificationThreshold);
    }

    values.push(id);

    const result = await withAdminScope(
      { caller: 'overage-rules.update', reason: 'operator by-PK overage rule update (no tenant context)' },
      (client) => client.query(
        `UPDATE overage_rules SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        values
      ),
    );

    if (!result.rows[0]) {
      throw new Error(`Overage rule not found: ${id}`);
    }

    return this.mapRow(result.rows[0]);
  }

  async delete(id: string): Promise<void> {
    const result = await withAdminScope(
      { caller: 'overage-rules.delete', reason: 'operator by-PK overage rule delete (no tenant context)' },
      (client) => client.query(`DELETE FROM overage_rules WHERE id = $1`, [id]),
    );
    if (result.rowCount === 0) {
      throw new Error(`Overage rule not found: ${id}`);
    }
  }

  async upsertByTenantId(tenantId: string, input: CreateOverageRuleInput): Promise<OverageRule> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `INSERT INTO overage_rules (
        tenant_id, plan_id, overage_rate_per_credit, overage_ceiling,
        billing_threshold, notification_threshold
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id) DO UPDATE SET
        plan_id = EXCLUDED.plan_id,
        overage_rate_per_credit = EXCLUDED.overage_rate_per_credit,
        overage_ceiling = EXCLUDED.overage_ceiling,
        billing_threshold = EXCLUDED.billing_threshold,
        notification_threshold = EXCLUDED.notification_threshold,
        updated_at = NOW()
      RETURNING *`,
      [
        tenantId,
        input.planId,
        input.overageRatePerCredit,
        input.overageCeiling || null,
        input.billingThreshold || null,
        input.notificationThreshold || null,
      ]
    ));
    return this.mapRow(result.rows[0]);
  }

  private mapRow(row: Record<string, unknown>): OverageRule {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      planId: row.plan_id as string,
      overageRatePerCredit: parseFloat(row.overage_rate_per_credit as string),
      overageCeiling: row.overage_ceiling as number | null,
      billingThreshold: row.billing_threshold as number | null,
      notificationThreshold: row.notification_threshold as number | null,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}
