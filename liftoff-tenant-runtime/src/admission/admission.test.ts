// Admission Service Unit Tests.
//
// Admission decides permission, never money. Tests cover: operational status,
// the control plane's billing hard stop, agent execution, agent lifecycle, kill
// switches — plus regression tests proving the capacity caps AND the legacy
// credit gate no longer block anything.

import { readFileSync } from 'fs';
import { join } from 'path';
import { AdmissionService } from './service';
import { pool } from '../infrastructure/database';
import {
  createMockEntitlement,
  entitlementToDbRow,
} from '../test-utils/mocks';

// Mock dependencies
jest.mock('../infrastructure/database');
jest.mock('../infrastructure/logging');

const mockPool = pool as jest.Mocked<typeof pool>;

describe('AdmissionService', () => {
  let service: AdmissionService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new AdmissionService();
  });

  // Helper to setup standard mocks for the admission flow:
  // 1. getEntitlement query
  // 2. (optional) checkAgentLifecycle query
  // 3. checkGlobalFreeze query
  // 4. (optional) checkWorkflowTypeDisable / checkConnectorKillSwitch query
  const setupMocks = (options: {
    entitlement?: Partial<ReturnType<typeof createMockEntitlement>>;
    agentId?: string;
    agentLifecycle?: string;
    globalFreeze?: boolean;
    globalFreezeReason?: string;
    workflowTypeDisabled?: boolean;
    connectorTypeDisabled?: boolean;
  } = {}) => {
    const entitlement = createMockEntitlement(options.entitlement);
    // Any of the three gates ahead of the lifecycle check short-circuits, so
    // no further query is issued and none must be mocked.
    const passesEntitlementGates =
      entitlement.operationalStatus !== 'suspended'
      && !entitlement.billingSuspended
      && entitlement.agentExecutionAllowed;

    // getEntitlement
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [entitlementToDbRow(entitlement)],
      rowCount: 1,
    } as any);

    // checkAgentLifecycle (only when agentId provided and entitlement allows)
    if (options.agentId && passesEntitlementGates) {
      const lifecycle = options.agentLifecycle ?? 'ACTIVE';
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ lifecycle }],
        rowCount: 1,
      } as any);
    }

    // checkGlobalFreeze (only when entitlement allows)
    if (passesEntitlementGates &&
        !(options.agentId && options.agentLifecycle && options.agentLifecycle !== 'ACTIVE')) {
      if (options.globalFreeze) {
        (mockPool.query as jest.Mock).mockResolvedValueOnce({
          rows: [{ reason: options.globalFreezeReason || 'Emergency freeze' }],
          rowCount: 1,
        } as any);
      } else {
        (mockPool.query as jest.Mock).mockResolvedValueOnce({
          rows: [],
          rowCount: 0,
        } as any);
      }
    }
  };

  // ==========================================
  // Tenant Status Tests
  // ==========================================

  describe('tenant status checks', () => {
    it('should deny when tenant is suspended', async () => {
      setupMocks({
        entitlement: { operationalStatus: 'suspended', agentExecutionAllowed: false },
      });

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'workflow',
      });

      expect(result.allowed).toBe(false);
      // The code is what callers may propagate; the English is log-only.
      expect(result.reason).toBe('operational_status_suspended');
      expect(result.detail).toBe('Tenant is suspended');
      expect(result.quotaType).toBe('operational_status');
    });

    it('should deny when agent execution not allowed', async () => {
      setupMocks({
        entitlement: { operationalStatus: 'active', agentExecutionAllowed: false },
      });

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'workflow',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('agent_execution_not_allowed');
      expect(result.detail).toBe('Agent execution is not allowed');
      expect(result.quotaType).toBe('agent_execution');
    });

    it('should allow when tenant is active and execution allowed', async () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // checkWorkflowTypeDisable
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'workflow',
      });

      expect(result.allowed).toBe(true);
    });
  });

  // ==========================================
  // Agent Lifecycle Tests
  // ==========================================

  describe('agent lifecycle checks', () => {
    it('should deny when agent is PAUSED', async () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkAgentLifecycle
        .mockResolvedValueOnce({
          rows: [{ lifecycle: 'PAUSED' }],
          rowCount: 1,
        } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        agentId: 'agent-456',
        checkType: 'action',
      });

      expect(result.allowed).toBe(false);
      expect(result.quotaType).toBe('agent_lifecycle');
    });

    it('should deny when agent is ARCHIVED', async () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkAgentLifecycle
        .mockResolvedValueOnce({
          rows: [{ lifecycle: 'ARCHIVED' }],
          rowCount: 1,
        } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        agentId: 'agent-456',
        checkType: 'action',
      });

      expect(result.allowed).toBe(false);
      expect(result.quotaType).toBe('agent_lifecycle');
    });

    it('should deny when agent not found', async () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkAgentLifecycle - agent not found
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 0,
        } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        agentId: 'agent-nonexistent',
        checkType: 'action',
      });

      expect(result.allowed).toBe(false);
      expect(result.quotaType).toBe('agent_not_found');
    });

    it('should allow when agent is ACTIVE', async () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkAgentLifecycle
        .mockResolvedValueOnce({
          rows: [{ lifecycle: 'ACTIVE' }],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        agentId: 'agent-456',
        checkType: 'action',
      });

      expect(result.allowed).toBe(true);
    });
  });

  // ==========================================
  // Kill Switch Tests
  // ==========================================

  describe('kill switch checks', () => {
    it('should deny when global freeze is active', async () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze - freeze is active
        .mockResolvedValueOnce({
          rows: [{ reason: 'Emergency maintenance' }],
          rowCount: 1,
        } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'workflow',
      });

      expect(result.allowed).toBe(false);
      expect(result.quotaType).toBe('global_freeze');
      // The operator's kill-switch note must NOT ride on the propagated field.
      expect(result.reason).toBe('global_freeze');
      expect(result.detail).toContain('Global freeze active');
    });

    it('should deny workflow when workflow type is disabled', async () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // checkWorkflowTypeDisable - disabled
        .mockResolvedValueOnce({
          rows: [{ reason: 'Maintenance' }],
          rowCount: 1,
        } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'workflow',
      });

      expect(result.allowed).toBe(false);
      expect(result.quotaType).toBe('workflow_type_disabled');
    });

    it('should deny action when connector type is disabled', async () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // checkConnectorKillSwitch - disabled
        .mockResolvedValueOnce({
          rows: [{ reason: 'Connector suspended' }],
          rowCount: 1,
        } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'action',
        connectorType: 'salesforce',
      });

      expect(result.allowed).toBe(false);
      expect(result.quotaType).toBe('connector_type_disabled');
    });
  });

  // ==========================================
  // Billing suspension (the control plane's hard stop)
  // ==========================================

  describe('billing suspension', () => {
    it('denies when the account is billing-suspended, even with execution allowed', async () => {
      setupMocks({
        entitlement: { operationalStatus: 'active', agentExecutionAllowed: true, billingSuspended: true },
      });

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'workflow',
      });

      expect(result.allowed).toBe(false);
      expect(result.quotaType).toBe('billing_suspended');
      expect(result.reason).toBe('billing_suspended');
      expect(result.detail).toBe('Tenant is suspended for billing');
    });

    it('treats a missing billing_suspended column as NOT suspended', async () => {
      // A cached row written before migration 346: the column reads NULL.
      // "Unknown" must never be rendered as "suspended" — the control plane
      // deploys ahead of the runtime and the field arrives late by design.
      (mockPool.query as jest.Mock)
        // getEntitlement — no billing_suspended key at all
        .mockResolvedValueOnce({
          rows: [{ operational_status: 'active', agent_execution_allowed: true }],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // checkWorkflowTypeDisable
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'workflow',
      });

      expect(result.allowed).toBe(true);
    });
  });

  // ==========================================
  // Credit gate removed (regression)
  //
  // The legacy gate compared burn_state.remaining_credits — a never-refilled
  // counter over a column carrying three incompatible units — against
  // cached_entitlements.overage_ceiling, which nothing maintains, so it could
  // deny a tenant that had consumed a tiny fraction of its allowance. Admission
  // does no money arithmetic now, and these prove it.
  // ==========================================

  describe('credit gate removed', () => {
    // A deeply negative burn_state against a 1,000,000 ceiling. Under the old
    // gate this denied every sandbox call. Admission
    // never reads burn_state now, so the DB is mocked with ONLY the queries
    // the surviving flow makes — an extra credit query would run out of mocks
    // and the assertion would fail.
    it('admits a tenant with a deeply negative burn_state and a healthy entitlement', async () => {
      (mockPool.query as jest.Mock)
        // getEntitlement
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // checkWorkflowTypeDisable
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'workflow',
        // Non-zero on purpose: the field survives on the input type as
        // advisory, and passing it must not resurrect a credit check.
        requiredCredits: 500,
      });

      expect(result.allowed).toBe(true);
      expect(result.quotaType).toBeUndefined();
    });

    it('admits a sandbox action with requiredCredits set', async () => {
      (mockPool.query as jest.Mock)
        // getEntitlement
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'action',
        requiredCredits: 1,
      });

      expect(result.allowed).toBe(true);
    });

    it('never queries burn_state or the legacy credit columns', async () => {
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'workflow',
        requiredCredits: 999999,
      });

      const sql = (mockPool.query as jest.Mock).mock.calls.map(c => String(c[0])).join('\n');
      expect(sql).not.toContain('burn_state');
      expect(sql).not.toContain('remaining_credits');
      expect(sql).not.toContain('overage_ceiling');
    });

    // Source-level: the two symbols must not come back. A behavioural test
    // cannot prove absence — a reintroduced check with different mocks would
    // pass one — so the source is asserted directly.
    it('has no checkCredits / burn_state left in admission/service.ts', () => {
      const source = readFileSync(join(__dirname, 'service.ts'), 'utf8');
      expect(source).not.toContain('checkCredits');
      expect(source).not.toContain('getTenantQuotas');
      // `burn_state` may only appear in prose explaining why it is gone, never
      // in a query.
      expect(source).not.toMatch(/FROM\s+burn_state|JOIN\s+burn_state/i);
    });
  });

  // ==========================================
  // Entitlement Missing Tests
  // ==========================================

  describe('missing entitlement', () => {
    it('should deny when entitlement not found', async () => {
      // getEntitlement - empty result → defaults to pending/false
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await service.checkAdmission({
        tenantId: 'unknown-tenant',
        checkType: 'workflow',
      });

      // Should deny because agentExecutionAllowed defaults to false
      expect(result.allowed).toBe(false);
    });
  });

  // ==========================================
  // Phase 2 Regression Tests: previously denied, now allowed
  // Proves capacity caps no longer block admission.
  // ==========================================

  describe('capacity caps removed (regression)', () => {
    // Standard allowed setup for regression tests
    const setupAllowed = () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // checkWorkflowTypeDisable
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    };

    it('should allow workflow regardless of active workflow count', async () => {
      setupAllowed();

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'workflow',
      });

      expect(result.allowed).toBe(true);
      expect(result.quotaType).not.toBe('max_active_workflows');
      expect(result.quotaType).not.toBe('max_active_agents');
    });

    it('should allow action regardless of actions per minute', async () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'action',
      });

      expect(result.allowed).toBe(true);
      expect(result.quotaType).not.toBe('max_actions_per_minute');
      expect(result.quotaType).not.toBe('max_connector_writes_per_minute');
    });

    it('should allow task regardless of queued task count', async () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // checkWorkflowTypeDisable (task also checks this)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'task',
      });

      expect(result.allowed).toBe(true);
      expect(result.quotaType).not.toBe('max_queued_tasks');
    });

    it('should allow reflection regardless of daily/weekly count', async () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'reflection',
      });

      expect(result.allowed).toBe(true);
      expect(result.quotaType).not.toBe('max_reflection_runs_per_day');
      expect(result.quotaType).not.toBe('max_reflection_runs_per_week');
    });

    it('should not have any cap-related quotaType values in denial', async () => {
      // Only denial types remaining should be: operational_status,
      // billing_suspended, agent_execution, agent_lifecycle, agent_not_found,
      // global_freeze, workflow_type_disabled, connector_type_disabled.
      const capQuotaTypes = [
        'max_active_agents',
        'max_active_workflows',
        'max_queued_tasks',
        'max_actions_per_minute',
        'max_connector_writes_per_minute',
        'max_retries',
        'max_child_tasks',
        'max_workflow_depth',
        'max_external_writes_per_interval',
        'max_task_runtime_duration',
        'max_reflection_runs_per_day',
        'max_reflection_runs_per_week',
        'agent_reflection_frequency',
      ];

      // Verify none of these exist in the service by checking a denied result
      // getEntitlement - suspended
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement({ operationalStatus: 'suspended', agentExecutionAllowed: false }))],
          rowCount: 1,
        } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'workflow',
      });

      expect(result.allowed).toBe(false);
      expect(capQuotaTypes).not.toContain(result.quotaType);
    });
  });

  // ==========================================
  // Edge Cases
  // ==========================================

  describe('edge cases', () => {
    it('should allow unknown check type', async () => {
      (mockPool.query as jest.Mock)
        // getEntitlement
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'unknown' as any,
      });

      expect(result.allowed).toBe(true);
    });

    it('should handle zero advisory credit requirement', async () => {
      (mockPool.query as jest.Mock)
        // getEntitlement
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // checkWorkflowTypeDisable
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'workflow',
        requiredCredits: 0,
      });

      expect(result.allowed).toBe(true);
    });
  });
});
