// Admission Control Service
// Phase 2 entitlements rework: capacity caps removed, credits are the only limiter.
// Kept: operational status, agent execution, agent lifecycle, kill switches, credit checks.

import { pool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { dynamicQuotaService } from './dynamic-quota-service';

// Credit-only tenant quotas — all capacity caps removed in Phase 2.
export interface TenantQuotas {
  remainingCredits: number;
  overageAllowed: boolean;
  overageCeiling: number;
  includedMonthlyCredits: number;
}

export interface AdmissionCheckInput {
  tenantId: string;
  agentId?: string;
  checkType: 'workflow' | 'task' | 'action' | 'reflection';
  requiredCredits?: number;
  connectorType?: string;
}

export interface AdmissionResult {
  allowed: boolean;
  reason?: string;
  quotaType?: string;
}

export class AdmissionService {
  // Abuse detection throttle: at most once per tenant per 30 seconds
  private abuseCheckTimestamps = new Map<string, number>();
  private static readonly ABUSE_CHECK_INTERVAL_MS = 30_000;

  // Unified admission flow: status -> agent lifecycle -> kill switches -> credits
  async checkAdmission(input: AdmissionCheckInput): Promise<AdmissionResult> {
    // 1. Check tenant operational status
    const entitlement = await this.getEntitlement(input.tenantId);
    if (entitlement.operationalStatus === 'suspended') {
      return {
        allowed: false,
        reason: 'Tenant is suspended',
        quotaType: 'operational_status',
      };
    }

    // 2. Check agent execution allowed
    if (!entitlement.agentExecutionAllowed) {
      return {
        allowed: false,
        reason: 'Agent execution is not allowed',
        quotaType: 'agent_execution',
      };
    }

    // 3. Check agent lifecycle (PAUSED/ARCHIVED -> reject)
    if (input.agentId) {
      const lifecycleCheck = await this.checkAgentLifecycle(input.agentId);
      if (!lifecycleCheck.allowed) {
        return lifecycleCheck;
      }
    }

    // 4. Check kill switches
    const globalFreeze = await this.checkGlobalFreeze(input.tenantId);
    if (!globalFreeze.allowed) {
      return globalFreeze;
    }

    if (input.checkType === 'workflow' || input.checkType === 'task') {
      const workflowDisable = await this.checkWorkflowTypeDisable(input.tenantId, input.agentId);
      if (!workflowDisable.allowed) {
        return workflowDisable;
      }
    }

    if (input.checkType === 'action' && input.connectorType) {
      const connectorKillSwitch = await this.checkConnectorKillSwitch(input.tenantId, input.connectorType);
      if (!connectorKillSwitch.allowed) {
        return connectorKillSwitch;
      }
    }

    // 5. Check credits if required
    if (input.requiredCredits !== undefined && input.requiredCredits > 0) {
      const tenantQuotas = await this.getTenantQuotas(input.tenantId);
      const creditCheck = await this.checkCredits(tenantQuotas, input.requiredCredits);
      if (!creditCheck.allowed) {
        return creditCheck;
      }
    }

    // Fire-and-forget abuse detection (throttled, non-blocking)
    this.maybeRunAbuseDetection(input.tenantId);

    return { allowed: true };
  }

  private maybeRunAbuseDetection(tenantId: string): void {
    const now = Date.now();
    const lastCheck = this.abuseCheckTimestamps.get(tenantId) ?? 0;
    if (now - lastCheck < AdmissionService.ABUSE_CHECK_INTERVAL_MS) return;

    this.abuseCheckTimestamps.set(tenantId, now);

    // Async — does not block admission
    dynamicQuotaService.detectAbusePatterns(tenantId).then(async (result) => {
      if (!result.isAbusive) return;

      if (result.recommendedAction === 'suspend') {
        // credential_enumeration: activate kill switch
        await pool.query(
          `INSERT INTO kill_switches (tenant_id, switch_type, enabled, reason, created_at)
           VALUES ($1, 'global_freeze', true, $2, NOW())
           ON CONFLICT (tenant_id, switch_type) DO UPDATE SET enabled = true, reason = $2`,
          [tenantId, `Auto-suspended: ${result.patterns.join(', ')}`]
        );
        logger.error({ tenantId, patterns: result.patterns }, 'Tenant auto-suspended due to abuse detection');
      }
      // 'alert' patterns are already logged inside detectAbusePatterns
    }).catch((err) => {
      logger.warn({ tenantId, err: err.message }, 'Abuse detection check failed (non-blocking)');
    });
  }

  private async checkCredits(quotas: TenantQuotas, required: number): Promise<AdmissionResult> {
    if (quotas.remainingCredits < required) {
      if (!quotas.overageAllowed) {
        return {
          allowed: false,
          reason: 'Insufficient credits and overage not allowed',
          quotaType: 'credits',
        };
      }

      // Check overage ceiling (including credits about to be consumed)
      const overageUsed = Math.abs(quotas.remainingCredits);
      const projectedOverage = overageUsed + required;
      if (projectedOverage > quotas.overageCeiling) {
        return {
          allowed: false,
          reason: `Overage ceiling (${quotas.overageCeiling}) exceeded`,
          quotaType: 'overage_ceiling',
        };
      }
    }

    return { allowed: true };
  }

  private async getTenantQuotas(tenantId: string): Promise<TenantQuotas> {
    const result = await pool.query(
      `SELECT e.included_monthly_credits, e.overage_ceiling, e.overage_allowed,
              b.remaining_credits
       FROM cached_entitlements e
       LEFT JOIN burn_state b ON e.tenant_id = b.tenant_id
       WHERE e.tenant_id = $1`,
      [tenantId]
    );

    if (result.rows.length === 0) {
      // Return conservative defaults
      return {
        remainingCredits: 0,
        overageAllowed: false,
        overageCeiling: 0,
        includedMonthlyCredits: 1000,
      };
    }

    const row = result.rows[0];
    return {
      includedMonthlyCredits: row.included_monthly_credits,
      overageCeiling: row.overage_ceiling,
      overageAllowed: row.overage_allowed,
      remainingCredits: row.remaining_credits || 0,
    };
  }

  private async getEntitlement(tenantId: string): Promise<{
    operationalStatus: string;
    agentExecutionAllowed: boolean;
  }> {
    const result = await pool.query(
      `SELECT operational_status, agent_execution_allowed
       FROM cached_entitlements WHERE tenant_id = $1`,
      [tenantId]
    );

    if (result.rows.length === 0) {
      return { operationalStatus: 'pending', agentExecutionAllowed: false };
    }

    return {
      operationalStatus: result.rows[0].operational_status,
      agentExecutionAllowed: result.rows[0].agent_execution_allowed,
    };
  }

  // Per Section 8: only ACTIVE agents can execute
  private async checkAgentLifecycle(agentId: string): Promise<AdmissionResult> {
    const result = await pool.query(
      `SELECT lifecycle FROM agents WHERE id = $1`,
      [agentId]
    );

    if (result.rows.length === 0) {
      return {
        allowed: false,
        reason: 'Agent not found',
        quotaType: 'agent_not_found',
      };
    }

    const lifecycle = result.rows[0].lifecycle;

    if (lifecycle !== 'ACTIVE') {
      logger.warn({
        agent_id: agentId,
        lifecycle,
      }, 'Agent admission denied: agent is not ACTIVE');

      return {
        allowed: false,
        reason: `Agent is ${lifecycle} - only ACTIVE agents can execute`,
        quotaType: 'agent_lifecycle',
      };
    }

    return { allowed: true };
  }

  // ===========================================
  // Kill Switch Enforcement
  // Three kill switches: connector_type_disabled, workflow_type_disabled, global_freeze
  // ===========================================

  // Check if global freeze is active for tenant
  private async checkGlobalFreeze(tenantId: string): Promise<AdmissionResult> {
    const result = await pool.query(
      `SELECT reason FROM kill_switches
       WHERE tenant_id = $1
         AND switch_type = 'global_freeze'
         AND enabled = true
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [tenantId]
    );

    if (result.rows.length > 0) {
      logger.warn({
        tenant_id: tenantId,
        switch_type: 'global_freeze',
        reason: result.rows[0].reason,
      }, 'Operation blocked by global freeze');

      return {
        allowed: false,
        reason: `Global freeze active: ${result.rows[0].reason || 'All operations suspended'}`,
        quotaType: 'global_freeze',
      };
    }

    return { allowed: true };
  }

  // Check if workflow type is disabled
  private async checkWorkflowTypeDisable(tenantId: string, agentId?: string): Promise<AdmissionResult> {
    const result = await pool.query(
      `SELECT reason FROM kill_switches
       WHERE tenant_id = $1
         AND switch_type = 'workflow_type_disabled'
         AND enabled = true
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (agent_id IS NULL OR agent_id = $2)
       ORDER BY agent_id DESC NULLS LAST
       LIMIT 1`,
      [tenantId, agentId]
    );

    if (result.rows.length > 0) {
      logger.warn({
        tenant_id: tenantId,
        agent_id: agentId,
        switch_type: 'workflow_type_disabled',
        reason: result.rows[0].reason,
      }, 'Workflow blocked by kill switch');

      return {
        allowed: false,
        reason: `Workflow type disabled: ${result.rows[0].reason || 'Workflows suspended'}`,
        quotaType: 'workflow_type_disabled',
      };
    }

    return { allowed: true };
  }

  // ===========================================
  // Kill-switch state snapshot (read-only) for the Preflight response.
  // Loads every active kill_switches row for the tenant in a single query
  // and buckets them into the proto-shaped snapshot. Global rows
  // (tenant_id IS NULL) flip the `global` bit; tenant rows without an
  // agent_id / connector_type flip `tenant`; rows with agent_id go into
  // `agentIds`; connector_type_disabled rows go into `connectorTypes`.
  // ===========================================
  async getKillSwitchState(tenantId: string): Promise<{
    global: boolean;
    tenant: boolean;
    agentIds: string[];
    connectorTypes: string[];
  }> {
    const result = await pool.query(
      `SELECT switch_type, tenant_id, agent_id, connector_type
         FROM kill_switches
        WHERE enabled = true
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (tenant_id IS NULL OR tenant_id = $1)`,
      [tenantId]
    );

    let global = false;
    let tenant = false;
    const agentIds = new Set<string>();
    const connectorTypes = new Set<string>();

    for (const row of result.rows) {
      const isGlobalRow = row.tenant_id == null;
      if (row.switch_type === 'global_freeze') {
        if (isGlobalRow) global = true;
        else tenant = true;
        continue;
      }
      if (row.switch_type === 'connector_type_disabled' && row.connector_type) {
        connectorTypes.add(row.connector_type as string);
        continue;
      }
      if (row.switch_type === 'workflow_type_disabled') {
        if (row.agent_id) agentIds.add(row.agent_id as string);
        else tenant = true;
      }
    }

    return {
      global,
      tenant,
      agentIds: Array.from(agentIds),
      connectorTypes: Array.from(connectorTypes),
    };
  }

  // Check if connector type is disabled
  private async checkConnectorKillSwitch(tenantId: string, connectorType: string): Promise<AdmissionResult> {
    const result = await pool.query(
      `SELECT reason FROM kill_switches
       WHERE tenant_id = $1
         AND switch_type = 'connector_type_disabled'
         AND connector_type = $2
         AND enabled = true
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [tenantId, connectorType]
    );

    if (result.rows.length > 0) {
      logger.warn({
        tenant_id: tenantId,
        connector_type: connectorType,
        switch_type: 'connector_type_disabled',
        reason: result.rows[0].reason,
      }, 'Connector operation blocked by kill switch');

      return {
        allowed: false,
        reason: `Connector ${connectorType} disabled: ${result.rows[0].reason || 'Connector suspended'}`,
        quotaType: 'connector_type_disabled',
      };
    }

    return { allowed: true };
  }
}
