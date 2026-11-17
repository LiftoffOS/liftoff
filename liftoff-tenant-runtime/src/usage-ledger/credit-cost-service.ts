// Credit Cost Model Service
// Per Section 12: Action-credit ledger with configurable costs
// Uses credit_cost_model table from migration 003

import { pool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

export interface CreditCostModel {
  id: string;
  tenantId: string | null;
  actionType: string;
  connector: string | null;
  creditsPerAction: number;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
}

export interface CreditCostLookup {
  actionType: string;
  connector?: string;
}

// Default credit costs for common actions when no specific model is defined
const DEFAULT_CREDIT_COSTS: Record<string, number> = {
  // Read operations - low cost
  read: 1,
  fetch: 1,
  list: 1,
  search: 2,

  // Write operations - medium cost
  create: 5,
  update: 3,
  patch: 2,

  // Delete operations - medium cost
  delete: 3,

  // Complex operations - higher cost
  bulk_create: 10,
  bulk_update: 8,
  bulk_delete: 6,

  // LLM operations - highest cost (per Section 15)
  llm_instruction_compile: 50,
  llm_planning: 30,
  llm_reflection: 40,
  llm_summary: 20,

  // Notifications - low cost
  notify: 1,
  email: 2,
  sms: 3,

  // Default fallback
  default: 1,
};

// Connector-specific multipliers (some connectors have rate limits/costs)
const CONNECTOR_MULTIPLIERS: Record<string, number> = {
  salesforce: 1.0,
  hubspot: 1.0,
  slack: 0.5, // Slack operations are lighter
  github: 1.0,
  jira: 1.2, // Jira API is heavier
  zendesk: 1.0,
  intercom: 1.0,
  google_calendar: 0.8,
  linear: 0.8,
};

export class CreditCostService {
  private cache: Map<string, { cost: number; expiresAt: Date }> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Per Section 12: Get credit cost for an action
  async getCreditCost(
    tenantId: string,
    lookup: CreditCostLookup
  ): Promise<number> {
    const cacheKey = `${tenantId}:${lookup.actionType}:${lookup.connector || '*'}`;

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > new Date()) {
      return cached.cost;
    }

    // Look up from database
    const cost = await this.lookupCost(tenantId, lookup);

    // Cache the result
    this.cache.set(cacheKey, {
      cost,
      expiresAt: new Date(Date.now() + this.CACHE_TTL_MS),
    });

    return cost;
  }

  // Look up cost from credit_cost_model table with fallback hierarchy:
  // 1. Tenant-specific + connector-specific
  // 2. Tenant-specific + any connector
  // 3. System default + connector-specific
  // 4. System default + any connector
  // 5. Hardcoded defaults
  private async lookupCost(
    tenantId: string,
    lookup: CreditCostLookup
  ): Promise<number> {
    const now = new Date();

    // Query with priority order
    const result = await pool.query(
      `SELECT * FROM credit_cost_model
       WHERE action_type = $1
       AND (tenant_id = $2 OR tenant_id IS NULL)
       AND (connector = $3 OR connector IS NULL)
       AND effective_from <= $4
       AND (effective_until IS NULL OR effective_until > $4)
       ORDER BY
         CASE WHEN tenant_id IS NOT NULL THEN 0 ELSE 1 END,
         CASE WHEN connector IS NOT NULL THEN 0 ELSE 1 END,
         effective_from DESC
       LIMIT 1`,
      [lookup.actionType, tenantId, lookup.connector || null, now]
    );

    if (result.rows.length > 0) {
      logger.debug('Credit cost found in model', {
        tenantId,
        actionType: lookup.actionType,
        connector: lookup.connector,
        credits: result.rows[0].credits_per_action,
      });
      return result.rows[0].credits_per_action;
    }

    // Fall back to hardcoded defaults
    return this.getDefaultCost(lookup);
  }

  private getDefaultCost(lookup: CreditCostLookup): number {
    const baseCost = DEFAULT_CREDIT_COSTS[lookup.actionType] || DEFAULT_CREDIT_COSTS.default;

    // Apply connector multiplier if applicable
    if (lookup.connector) {
      const multiplier = CONNECTOR_MULTIPLIERS[lookup.connector] || 1.0;
      return Math.ceil(baseCost * multiplier);
    }

    return baseCost;
  }

  // Get all cost models for a tenant (for admin UI)
  async listCostModels(tenantId: string): Promise<CreditCostModel[]> {
    const result = await pool.query(
      `SELECT * FROM credit_cost_model
       WHERE tenant_id = $1 OR tenant_id IS NULL
       ORDER BY action_type, connector, effective_from DESC`,
      [tenantId]
    );

    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      actionType: row.action_type,
      connector: row.connector,
      creditsPerAction: row.credits_per_action,
      effectiveFrom: row.effective_from,
      effectiveUntil: row.effective_until,
    }));
  }

  // Create or update a cost model for a tenant
  async upsertCostModel(
    tenantId: string,
    actionType: string,
    creditsPerAction: number,
    connector?: string,
    effectiveFrom?: Date
  ): Promise<CreditCostModel> {
    const effectiveFromDate = effectiveFrom || new Date();

    // End any existing model for this tenant/action/connector
    await pool.query(
      `UPDATE credit_cost_model
       SET effective_until = $4
       WHERE tenant_id = $1
       AND action_type = $2
       AND (connector = $3 OR ($3 IS NULL AND connector IS NULL))
       AND effective_until IS NULL`,
      [tenantId, actionType, connector || null, effectiveFromDate]
    );

    // Insert new model
    const result = await pool.query(
      `INSERT INTO credit_cost_model (tenant_id, action_type, connector, credits_per_action, effective_from)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [tenantId, actionType, connector || null, creditsPerAction, effectiveFromDate]
    );

    // Invalidate cache for this tenant/action/connector
    this.invalidateCache(tenantId, actionType, connector);

    logger.info('Credit cost model updated', {
      tenantId,
      actionType,
      connector,
      creditsPerAction,
    });

    const row = result.rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      actionType: row.action_type,
      connector: row.connector,
      creditsPerAction: row.credits_per_action,
      effectiveFrom: row.effective_from,
      effectiveUntil: row.effective_until,
    };
  }

  // Estimate credits for a planned action (for admission control)
  async estimateCredits(
    tenantId: string,
    actions: CreditCostLookup[]
  ): Promise<{ total: number; breakdown: { action: CreditCostLookup; credits: number }[] }> {
    const breakdown: { action: CreditCostLookup; credits: number }[] = [];
    let total = 0;

    for (const action of actions) {
      const credits = await this.getCreditCost(tenantId, action);
      breakdown.push({ action, credits });
      total += credits;
    }

    return { total, breakdown };
  }

  // Invalidate cache entries
  private invalidateCache(tenantId: string, actionType: string, _connector?: string): void {
    const prefix = `${tenantId}:${actionType}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  // Clear all cache (for testing or bulk updates)
  clearCache(): void {
    this.cache.clear();
  }
}

// Export singleton instance
export const creditCostService = new CreditCostService();
