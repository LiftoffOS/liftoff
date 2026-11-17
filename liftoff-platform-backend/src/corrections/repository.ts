// Correction Protocol Repository
// Database operations for correction registry, audit log queries, config, and budgets
//
// RLS note (migration 200 + FORCE census): the tenant-scoped tables here
// (agent_audit_logs, correction_config, correction_rate_limits,
// correction_rate_usage, correction_budgets, financial_corrections) are
// RLS-enabled. Every method is keyed by an explicit tenantId, so the
// tenantId-bearing single-statement queries run under withTenantScope. The
// four methods that manage their OWN pool.connect()+BEGIN transaction (rate
// usage + budget check/deduct with FOR UPDATE locking) set
// app.current_tenant_id via set_config INSIDE that transaction — wrapping them
// in withTenantScope would nest transactions and break the row locking.
// cleanupOldRateUsage is a cross-tenant cron (no tenant filter) → withAdminScope.
// correction_registry is a GLOBAL, non-RLS tool registry → stays on the default pool.

import { pool, withTenantScope, withAdminScope } from '../infrastructure/database';
import {
  CorrectionRegistryEntry,
  CorrectionConfig,
  CorrectionRateLimits,
  CorrectionBudget,
  FinancialCorrection,
  InsertFinancialCorrectionInput,
  CorrectionHistoryEntry,
  CorrectionType,
} from './types';

export class CorrectionRepository {

  // ==========================================================================
  // Correction Registry Operations (correction_registry is a GLOBAL, non-RLS
  // table — no tenant scope needed)
  // ==========================================================================

  async getRegistryEntryByToolName(toolName: string): Promise<CorrectionRegistryEntry | null> {
    const result = await pool.query(
      `SELECT * FROM correction_registry WHERE tool_name = $1`,
      [toolName]
    );
    return result.rows[0] ? this.mapRegistryRow(result.rows[0]) : null;
  }

  async getRegistryEntryById(id: string): Promise<CorrectionRegistryEntry | null> {
    const result = await pool.query(
      `SELECT * FROM correction_registry WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapRegistryRow(result.rows[0]) : null;
  }

  async listRegistryEntries(integrationType?: string): Promise<CorrectionRegistryEntry[]> {
    let query = `SELECT * FROM correction_registry`;
    const params: string[] = [];

    if (integrationType) {
      query += ` WHERE integration_type = $1`;
      params.push(integrationType);
    }

    query += ` ORDER BY integration_type, tool_name`;

    const result = await pool.query(query, params);
    return result.rows.map(this.mapRegistryRow);
  }

  // ==========================================================================
  // Correction History Queries (via agent_audit_logs — RLS, tenant-scoped)
  // ==========================================================================

  async getCorrectionHistory(tenantId: string, auditLogId: string): Promise<CorrectionHistoryEntry[]> {
    // Get full audit trail: original action + all corrections
    const result = await withTenantScope(tenantId, (client) => client.query(`
      SELECT id, action, correction_of, outcome, triggered_by, created_at, input_args, output_summary
      FROM agent_audit_logs
      WHERE tenant_id = $1 AND (id = $2 OR correction_of = $2)
      ORDER BY created_at ASC
    `, [tenantId, auditLogId]));

    return result.rows.map(this.mapHistoryRow);
  }

  async wasActionCorrected(tenantId: string, auditLogId: string): Promise<boolean> {
    // Check if a correction execution exists (not just a request)
    const result = await withTenantScope(tenantId, (client) => client.query(`
      SELECT 1 FROM agent_audit_logs
      WHERE tenant_id = $1
        AND correction_of = $2
        AND action != 'correction_request'
        AND outcome = 'success'
      LIMIT 1
    `, [tenantId, auditLogId]));

    return result.rows.length > 0;
  }

  async hasPendingCorrectionRequest(tenantId: string, auditLogId: string): Promise<boolean> {
    // Check if there's a correction request without corresponding execution
    const result = await withTenantScope(tenantId, (client) => client.query(`
      SELECT 1 FROM agent_audit_logs r
      WHERE r.tenant_id = $1
        AND r.correction_of = $2
        AND r.action = 'correction_request'
        AND r.outcome = 'success'
        AND NOT EXISTS (
          SELECT 1 FROM agent_audit_logs e
          WHERE e.tenant_id = $1
            AND e.correction_of = $2
            AND e.action != 'correction_request'
        )
      LIMIT 1
    `, [tenantId, auditLogId]));

    return result.rows.length > 0;
  }

  async getCorrectionChainDepth(tenantId: string, auditLogId: string): Promise<number> {
    // BE-010: Recursive CTE with depth limit to prevent expensive queries
    const MAX_CHAIN_DEPTH = 100; // Safety limit
    const result = await withTenantScope(tenantId, (client) => client.query(`
      WITH RECURSIVE chain AS (
        SELECT id, correction_of, 1 as depth
        FROM agent_audit_logs
        WHERE id = $1 AND tenant_id = $2
        UNION ALL
        SELECT a.id, a.correction_of, c.depth + 1
        FROM agent_audit_logs a
        JOIN chain c ON a.id = c.correction_of
        WHERE a.tenant_id = $2 AND c.depth < $3
      )
      SELECT MAX(depth) as max_depth FROM chain
    `, [auditLogId, tenantId, MAX_CHAIN_DEPTH]));

    return result.rows[0]?.max_depth || 1;
  }

  // ==========================================================================
  // Tenant Correction Config Operations
  // ==========================================================================

  async getCorrectionConfig(tenantId: string): Promise<CorrectionConfig | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM correction_config WHERE tenant_id = $1`,
      [tenantId]
    ));
    return result.rows[0] ? this.mapConfigRow(result.rows[0]) : null;
  }

  async upsertCorrectionConfig(
    tenantId: string,
    config: Partial<Omit<CorrectionConfig, 'tenantId' | 'createdAt' | 'updatedAt'>>
  ): Promise<CorrectionConfig> {
    const result = await withTenantScope(tenantId, (client) => client.query(`
      INSERT INTO correction_config (tenant_id, require_approval_all, auto_approve_window, require_original_actor)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (tenant_id)
      DO UPDATE SET
        require_approval_all = COALESCE($2, correction_config.require_approval_all),
        auto_approve_window = COALESCE($3, correction_config.auto_approve_window),
        require_original_actor = COALESCE($4, correction_config.require_original_actor),
        updated_at = NOW()
      RETURNING *
    `, [
      tenantId,
      config.requireApprovalAll ?? false,
      config.autoApproveWindow ?? null,
      config.requireOriginalActor ?? false,
    ]));

    return this.mapConfigRow(result.rows[0]);
  }

  // ==========================================================================
  // Rate Limiting Operations
  // ==========================================================================

  async getRateLimits(tenantId: string): Promise<CorrectionRateLimits> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM correction_rate_limits WHERE tenant_id = $1`,
      [tenantId]
    ));

    if (result.rows[0]) {
      return this.mapRateLimitsRow(result.rows[0]);
    }

    // Return defaults if no custom limits set
    return {
      tenantId,
      maxPerMinute: 10,
      maxPerHour: 100,
      maxPerDay: 500,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  async upsertRateLimits(tenantId: string, limits: Partial<Omit<CorrectionRateLimits, 'tenantId' | 'createdAt' | 'updatedAt'>>): Promise<CorrectionRateLimits> {
    const result = await withTenantScope(tenantId, (client) => client.query(`
      INSERT INTO correction_rate_limits (tenant_id, max_per_minute, max_per_hour, max_per_day)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (tenant_id)
      DO UPDATE SET
        max_per_minute = COALESCE($2, correction_rate_limits.max_per_minute),
        max_per_hour = COALESCE($3, correction_rate_limits.max_per_hour),
        max_per_day = COALESCE($4, correction_rate_limits.max_per_day),
        updated_at = NOW()
      RETURNING *
    `, [
      tenantId,
      limits.maxPerMinute ?? 10,
      limits.maxPerHour ?? 100,
      limits.maxPerDay ?? 500,
    ]));

    return this.mapRateLimitsRow(result.rows[0]);
  }

  async getRateUsage(tenantId: string, windowType: 'minute' | 'hour' | 'day'): Promise<number> {
    const windowStart = this.getWindowStart(windowType);

    const result = await withTenantScope(tenantId, (client) => client.query(`
      SELECT count FROM correction_rate_usage
      WHERE tenant_id = $1 AND window_type = $2 AND window_start = $3
    `, [tenantId, windowType, windowStart]));

    return result.rows[0]?.count || 0;
  }

  async incrementRateUsage(tenantId: string): Promise<void> {
    const windows: Array<{ type: 'minute' | 'hour' | 'day'; start: Date }> = [
      { type: 'minute', start: this.getWindowStart('minute') },
      { type: 'hour', start: this.getWindowStart('hour') },
      { type: 'day', start: this.getWindowStart('day') },
    ];

    // Use a transaction to update all windows atomically
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // RLS: scope this own-transaction to the tenant (FORCE-safe; set_config is
      // transaction-local so it resets on COMMIT/ROLLBACK). Not withTenantScope
      // because this method owns the BEGIN/COMMIT.
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

      for (const window of windows) {
        await client.query(`
          INSERT INTO correction_rate_usage (tenant_id, window_start, window_type, count)
          VALUES ($1, $2, $3, 1)
          ON CONFLICT (tenant_id, window_start, window_type)
          DO UPDATE SET count = correction_rate_usage.count + 1
        `, [tenantId, window.start, window.type]);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * BE-001: Atomically check and increment rate usage
   * Returns whether the operation was allowed (within limits)
   */
  async checkAndIncrementRateUsage(tenantId: string): Promise<{
    allowed: boolean;
    usage: { minute: number; hour: number; day: number };
  }> {
    const limits = await this.getRateLimits(tenantId);
    const windows = {
      minute: this.getWindowStart('minute'),
      hour: this.getWindowStart('hour'),
      day: this.getWindowStart('day'),
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // RLS: scope this own-transaction to the tenant before the FOR UPDATE read.
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

      // Lock and get current usage with FOR UPDATE to prevent concurrent modifications
      const usageResult = await client.query(`
        SELECT window_type, count
        FROM correction_rate_usage
        WHERE tenant_id = $1
          AND ((window_type = 'minute' AND window_start = $2)
            OR (window_type = 'hour' AND window_start = $3)
            OR (window_type = 'day' AND window_start = $4))
        FOR UPDATE
      `, [tenantId, windows.minute, windows.hour, windows.day]);

      const usage = {
        minute: 0,
        hour: 0,
        day: 0,
      };

      for (const row of usageResult.rows) {
        usage[row.window_type as keyof typeof usage] = row.count;
      }

      // Check limits before incrementing
      if (usage.minute >= limits.maxPerMinute ||
          usage.hour >= limits.maxPerHour ||
          usage.day >= limits.maxPerDay) {
        await client.query('ROLLBACK');
        return { allowed: false, usage };
      }

      // Increment all windows atomically
      for (const [windowType, windowStart] of Object.entries(windows)) {
        await client.query(`
          INSERT INTO correction_rate_usage (tenant_id, window_start, window_type, count)
          VALUES ($1, $2, $3, 1)
          ON CONFLICT (tenant_id, window_start, window_type)
          DO UPDATE SET count = correction_rate_usage.count + 1
        `, [tenantId, windowStart, windowType]);
      }

      await client.query('COMMIT');
      return {
        allowed: true,
        usage: {
          minute: usage.minute + 1,
          hour: usage.hour + 1,
          day: usage.day + 1,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * BE-001: Atomically check and increment rate usage for bulk operations
   */
  async checkAndIncrementBulkRateUsage(tenantId: string, count: number): Promise<{
    allowed: boolean;
    usage: { minute: number; hour: number; day: number };
  }> {
    const limits = await this.getRateLimits(tenantId);
    const windows = {
      minute: this.getWindowStart('minute'),
      hour: this.getWindowStart('hour'),
      day: this.getWindowStart('day'),
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // RLS: scope this own-transaction to the tenant before the FOR UPDATE read.
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

      // Lock and get current usage
      const usageResult = await client.query(`
        SELECT window_type, count
        FROM correction_rate_usage
        WHERE tenant_id = $1
          AND ((window_type = 'minute' AND window_start = $2)
            OR (window_type = 'hour' AND window_start = $3)
            OR (window_type = 'day' AND window_start = $4))
        FOR UPDATE
      `, [tenantId, windows.minute, windows.hour, windows.day]);

      const usage = { minute: 0, hour: 0, day: 0 };
      for (const row of usageResult.rows) {
        usage[row.window_type as keyof typeof usage] = row.count;
      }

      // Check if bulk would exceed limits
      if (usage.minute + count > limits.maxPerMinute ||
          usage.hour + count > limits.maxPerHour ||
          usage.day + count > limits.maxPerDay) {
        await client.query('ROLLBACK');
        return { allowed: false, usage };
      }

      // Increment all windows by count
      for (const [windowType, windowStart] of Object.entries(windows)) {
        await client.query(`
          INSERT INTO correction_rate_usage (tenant_id, window_start, window_type, count)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (tenant_id, window_start, window_type)
          DO UPDATE SET count = correction_rate_usage.count + $4
        `, [tenantId, windowStart, windowType, count]);
      }

      await client.query('COMMIT');
      return {
        allowed: true,
        usage: {
          minute: usage.minute + count,
          hour: usage.hour + count,
          day: usage.day + count,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cleanupOldRateUsage(): Promise<number> {
    // Clean up entries older than 2 days. Cross-tenant maintenance sweep (no
    // tenant filter) → withAdminScope.
    const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    const result = await withAdminScope(
      { caller: 'corrections.cleanupOldRateUsage', reason: 'cross-tenant cron: delete correction_rate_usage rows older than 2 days' },
      (client) => client.query(`
        DELETE FROM correction_rate_usage WHERE window_start < $1
      `, [cutoff]),
    );

    return result.rowCount || 0;
  }

  // ==========================================================================
  // Budget Operations
  // ==========================================================================

  async getBudget(tenantId: string): Promise<CorrectionBudget | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM correction_budgets WHERE tenant_id = $1`,
      [tenantId]
    ));
    return result.rows[0] ? this.mapBudgetRow(result.rows[0]) : null;
  }

  async upsertBudget(tenantId: string, budget: Partial<Omit<CorrectionBudget, 'tenantId' | 'createdAt' | 'updatedAt'>>): Promise<CorrectionBudget> {
    const result = await withTenantScope(tenantId, (client) => client.query(`
      INSERT INTO correction_budgets (tenant_id, budget_limit, budget_used, budget_period, period_start)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (tenant_id)
      DO UPDATE SET
        budget_limit = COALESCE($2, correction_budgets.budget_limit),
        budget_used = COALESCE($3, correction_budgets.budget_used),
        budget_period = COALESCE($4, correction_budgets.budget_period),
        period_start = COALESCE($5, correction_budgets.period_start),
        updated_at = NOW()
      RETURNING *
    `, [
      tenantId,
      budget.budgetLimit ?? null,
      budget.budgetUsed ?? 0,
      budget.budgetPeriod ?? 'monthly',
      budget.periodStart ?? new Date(),
    ]));

    return this.mapBudgetRow(result.rows[0]);
  }

  async incrementBudgetUsed(tenantId: string): Promise<void> {
    await withTenantScope(tenantId, (client) => client.query(`
      UPDATE correction_budgets
      SET budget_used = budget_used + 1, updated_at = NOW()
      WHERE tenant_id = $1
    `, [tenantId]));
  }

  /**
   * BE-002: Atomically check and deduct budget
   * Returns whether the operation was allowed (budget available)
   */
  async checkAndDeductBudget(tenantId: string): Promise<{
    allowed: boolean;
    remaining: number | null;
  }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // RLS: scope this own-transaction to the tenant before the FOR UPDATE read.
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

      // Lock the budget row with FOR UPDATE
      const result = await client.query(`
        SELECT budget_limit, budget_used, budget_period, period_start
        FROM correction_budgets
        WHERE tenant_id = $1
        FOR UPDATE
      `, [tenantId]);

      // No budget configured = unlimited
      if (result.rows.length === 0) {
        await client.query('COMMIT');
        return { allowed: true, remaining: null };
      }

      const budget = result.rows[0];

      // Check if we need to reset for new period
      if (this.isNewPeriod(budget.period_start, budget.budget_period)) {
        const newPeriodStart = this.getNewPeriodStart(budget.budget_period);
        await client.query(`
          UPDATE correction_budgets
          SET budget_used = 1, period_start = $2, updated_at = NOW()
          WHERE tenant_id = $1
        `, [tenantId, newPeriodStart]);

        await client.query('COMMIT');
        const remaining = budget.budget_limit ? budget.budget_limit - 1 : null;
        return { allowed: true, remaining };
      }

      // No limit = unlimited
      if (budget.budget_limit === null) {
        await client.query('COMMIT');
        return { allowed: true, remaining: null };
      }

      // Check if budget exhausted
      if (budget.budget_used >= budget.budget_limit) {
        await client.query('ROLLBACK');
        return { allowed: false, remaining: 0 };
      }

      // Deduct and return
      await client.query(`
        UPDATE correction_budgets
        SET budget_used = budget_used + 1, updated_at = NOW()
        WHERE tenant_id = $1
      `, [tenantId]);

      await client.query('COMMIT');
      return {
        allowed: true,
        remaining: budget.budget_limit - budget.budget_used - 1,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private isNewPeriod(periodStart: Date, budgetPeriod: string): boolean {
    const now = new Date();
    switch (budgetPeriod) {
      case 'daily':
        return now.getDate() !== periodStart.getDate() ||
          now.getMonth() !== periodStart.getMonth() ||
          now.getFullYear() !== periodStart.getFullYear();
      case 'weekly': {
        const currentWeekStart = this.getWeekStart(now);
        const periodWeekStart = this.getWeekStart(periodStart);
        return currentWeekStart.getTime() !== periodWeekStart.getTime();
      }
      case 'monthly':
      default:
        return now.getMonth() !== periodStart.getMonth() ||
          now.getFullYear() !== periodStart.getFullYear();
    }
  }

  private getNewPeriodStart(budgetPeriod: string): Date {
    const now = new Date();
    switch (budgetPeriod) {
      case 'daily':
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      case 'weekly':
        return this.getWeekStart(now);
      case 'monthly':
      default:
        return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    }
  }

  private getWeekStart(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day;
    return new Date(d.getFullYear(), d.getMonth(), diff, 0, 0, 0, 0);
  }

  async resetBudget(tenantId: string, periodStart: Date): Promise<void> {
    await withTenantScope(tenantId, (client) => client.query(`
      UPDATE correction_budgets
      SET budget_used = 0, period_start = $2, updated_at = NOW()
      WHERE tenant_id = $1
    `, [tenantId, periodStart]));
  }

  // ==========================================================================
  // Financial Corrections Operations
  // ==========================================================================

  async insertFinancialCorrection(input: InsertFinancialCorrectionInput): Promise<FinancialCorrection> {
    const result = await withTenantScope(input.tenantId, (client) => client.query(`
      INSERT INTO financial_corrections
        (tenant_id, original_audit_log_id, correction_audit_log_id, correction_type,
         amount_cents, currency, reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      input.tenantId,
      input.originalAuditLogId,
      input.correctionAuditLogId,
      input.correctionType,
      input.amountCents,
      input.currency,
      input.reason,
    ]));

    return this.mapFinancialCorrectionRow(result.rows[0]);
  }

  // ==========================================================================
  // Row Mappers
  // ==========================================================================

  private mapRegistryRow(row: any): CorrectionRegistryEntry {
    return {
      id: row.id,
      toolName: row.tool_name,
      integrationType: row.integration_type,
      correctionToolName: row.correction_tool_name,
      correctionType: row.correction_type as CorrectionType,
      timeWindowSeconds: row.time_window_seconds,
      requiresPreviousState: row.requires_previous_state,
      userFacingLabel: row.user_facing_label,
      requiresHitlApproval: row.requires_hitl_approval,
      hitlLevel: row.hitl_level,
      maxCorrectionChain: row.max_correction_chain,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapConfigRow(row: any): CorrectionConfig {
    return {
      tenantId: row.tenant_id,
      requireApprovalAll: row.require_approval_all,
      autoApproveWindow: row.auto_approve_window,
      requireOriginalActor: row.require_original_actor,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRateLimitsRow(row: any): CorrectionRateLimits {
    return {
      tenantId: row.tenant_id,
      maxPerMinute: row.max_per_minute,
      maxPerHour: row.max_per_hour,
      maxPerDay: row.max_per_day,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapBudgetRow(row: any): CorrectionBudget {
    return {
      tenantId: row.tenant_id,
      budgetLimit: row.budget_limit,
      budgetUsed: row.budget_used,
      budgetPeriod: row.budget_period,
      periodStart: row.period_start,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapHistoryRow(row: any): CorrectionHistoryEntry {
    return {
      id: row.id,
      action: row.action,
      correctionOf: row.correction_of,
      outcome: row.outcome,
      triggeredBy: row.triggered_by,
      createdAt: row.created_at,
      inputArgs: row.input_args,
      outputSummary: row.output_summary,
    };
  }

  private mapFinancialCorrectionRow(row: any): FinancialCorrection {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      originalAuditLogId: row.original_audit_log_id,
      correctionAuditLogId: row.correction_audit_log_id,
      correctionType: row.correction_type as CorrectionType,
      amountCents: row.amount_cents,
      currency: row.currency,
      reason: row.reason,
      reconciled: row.reconciled,
      reconciledAt: row.reconciled_at,
      reconciledBy: row.reconciled_by,
      createdAt: row.created_at,
    };
  }

  private getWindowStart(windowType: 'minute' | 'hour' | 'day'): Date {
    const now = new Date();
    switch (windowType) {
      case 'minute':
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0);
      case 'hour':
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0);
      case 'day':
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    }
  }
}

export const correctionRepository = new CorrectionRepository();
