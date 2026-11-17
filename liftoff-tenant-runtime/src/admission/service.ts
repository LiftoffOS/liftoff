// Admission Control Service
//
// Admission answers one question: is this tenant/agent permitted to run right
// now. It does NO money math. Spend authority lives entirely in the control
// plane — `billing_controls` plus the OU buckets — and reaches admission as a
// single pre-computed signal (`operational_status` / `agent_execution_allowed`)
// on the cached entitlement.
//
// The legacy "Section 13" credit gate that used to live here is gone. It
// compared `burn_state.remaining_credits` — a counter fed by three mutually
// incompatible units (raw embedding tokens, milli-USD sandbox ticks, action
// counts) and never reset by any monthly refill — against a
// `cached_entitlements.overage_ceiling` that nothing has maintained since the
// billing pipeline moved to the control plane. The result denied real work for
// a reason no longer connected to money. Re-deriving a runtime-side money cap
// would just duplicate the authority again, so it is not replaced: billing
// handles overage, and suspension for non-payment arrives as
// `operational_status = 'suspended'`.
//
// Kept, in order: operational status, agent execution, agent lifecycle,
// kill switches (global freeze, workflow type, connector type).

import { pool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { dynamicQuotaService } from './dynamic-quota-service';
import { admission_denied_total } from '../observability/runtime-extensions-metrics';

export interface AdmissionCheckInput {
  tenantId: string;
  agentId?: string;
  /** `'delegation'` is a child run started by another agent rather than by a
   *  person, a schedule or a trigger. It is a distinct check type only so the
   *  denial metric can tell delegated refusals apart from direct ones; it is
   *  evaluated exactly like any other run, which is the point — a delegated
   *  child used to skip admission entirely, so a billing-suspended or frozen
   *  tenant still got paid LLM work through the side door of one agent asking
   *  another. */
  checkType: 'workflow' | 'task' | 'action' | 'reflection' | 'delegation';
  /** Advisory only — admission performs no credit arithmetic. Callers still
   *  pass it; it is ignored here and is scheduled for removal once every
   *  call site has dropped it. */
  requiredCredits?: number;
  connectorType?: string;
}

/** Why admission refused, as an enumerable value.
 *
 *  `reason` used to be a hand-written English sentence, and for the three kill
 *  switches it INTERPOLATED the operator's free-text note straight into it. That
 *  sentence then travelled: into the caller's error string, into
 *  invocations.error_message, and onto the audit row. So an internal note
 *  ("suspended pending legal review of the Acme contract") reached surfaces
 *  nobody wrote it for, and no two denials of the same kind were comparable
 *  because each carried different words. */
export type AdmissionDenialCode =
  | 'operational_status_suspended'
  | 'billing_suspended'
  | 'agent_execution_not_allowed'
  | 'agent_not_found'
  | 'agent_lifecycle_not_active'
  | 'global_freeze'
  | 'workflow_type_disabled'
  | 'connector_type_disabled';

export interface AdmissionResult {
  allowed: boolean;
  /** Stable, enumerable denial code. THIS is what callers may propagate. */
  reason?: AdmissionDenialCode;
  /** Free-form English for a human reading a log line, including the operator's
   *  own kill-switch note. Deliberately NOT enumerating and deliberately not
   *  part of `reason`: it is for the log, never for a caller to forward. */
  detail?: string;
  quotaType?: string;
}

export class AdmissionService {
  // Abuse detection throttle: at most once per tenant per 30 seconds
  private abuseCheckTimestamps = new Map<string, number>();
  private static readonly ABUSE_CHECK_INTERVAL_MS = 30_000;

  // Unified admission flow: status -> agent execution -> agent lifecycle -> kill switches
  //
  // Every denial is counted here, on the single exit. Before this, the deny
  // path was invisible: nothing was emitted, and the first anyone knew of a
  // wrongly-denied tenant was an agent escalating four months later.
  async checkAdmission(input: AdmissionCheckInput): Promise<AdmissionResult> {
    const result = await this.evaluate(input);
    if (!result.allowed) {
      admission_denied_total.inc({
        reason: result.quotaType ?? 'unknown',
        check_type: input.checkType,
        tenant_id: input.tenantId,
      });
    }
    return result;
  }

  private async evaluate(input: AdmissionCheckInput): Promise<AdmissionResult> {
    // 1. Check tenant operational status
    const entitlement = await this.getEntitlement(input.tenantId);
    if (entitlement.operationalStatus === 'suspended') {
      return {
        allowed: false,
        reason: 'operational_status_suspended',
        detail: 'Tenant is suspended',
        quotaType: 'operational_status',
      };
    }

    // 1b. Billing hard stop. `billing_controls.suspended` in the control plane,
    // mirrored onto the snapshot (migration 346) and treated identically to an
    // operational suspension — the control plane's execution-guard already
    // stops on it, and two gates reading different facts is how they diverge.
    if (entitlement.billingSuspended) {
      return {
        allowed: false,
        reason: 'billing_suspended',
        detail: 'Tenant is suspended for billing',
        quotaType: 'billing_suspended',
      };
    }

    // 2. Check agent execution allowed
    if (!entitlement.agentExecutionAllowed) {
      return {
        allowed: false,
        reason: 'agent_execution_not_allowed',
        detail: 'Agent execution is not allowed',
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

  private async getEntitlement(tenantId: string): Promise<{
    operationalStatus: string;
    agentExecutionAllowed: boolean;
    billingSuspended: boolean;
  }> {
    const result = await pool.query(
      `SELECT operational_status, agent_execution_allowed, billing_suspended
       FROM cached_entitlements WHERE tenant_id = $1`,
      [tenantId]
    );

    if (result.rows.length === 0) {
      return { operationalStatus: 'pending', agentExecutionAllowed: false, billingSuspended: false };
    }

    return {
      operationalStatus: result.rows[0].operational_status,
      agentExecutionAllowed: result.rows[0].agent_execution_allowed,
      // A row cached before migration 346 carries NULL here; "unknown" must
      // read as "not suspended" so the new gate can only ever tighten.
      billingSuspended: result.rows[0].billing_suspended ?? false,
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
        reason: 'agent_not_found',
        detail: 'Agent not found',
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
        reason: 'agent_lifecycle_not_active',
        detail: `Agent is ${lifecycle} - only ACTIVE agents can execute`,
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
        reason: 'global_freeze',
        // The operator's note stays HERE and goes no further — it is already on
        // the log line above, which is the only place it was ever meant for.
        detail: `Global freeze active: ${result.rows[0].reason || 'All operations suspended'}`,
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
        reason: 'workflow_type_disabled',
        detail: `Workflow type disabled: ${result.rows[0].reason || 'Workflows suspended'}`,
        quotaType: 'workflow_type_disabled',
      };
    }

    return { allowed: true };
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
        reason: 'connector_type_disabled',
        detail: `Connector ${connectorType} disabled: ${result.rows[0].reason || 'Connector suspended'}`,
        quotaType: 'connector_type_disabled',
      };
    }

    return { allowed: true };
  }
}
