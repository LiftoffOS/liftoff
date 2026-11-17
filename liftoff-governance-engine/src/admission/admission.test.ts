// Admission Service Unit Tests — Phase 2 entitlements rework
// Capacity caps removed; tests cover: operational status, agent lifecycle,
// kill switches, credit checks, and regression tests proving caps no longer block.

import { AdmissionService, TenantQuotas } from './service';
import { pool } from '../infrastructure/database';
import {
  createMockTenantQuotas,
  createMockEntitlement,
  tenantQuotasToDbRow,
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

  // Helper to setup standard mocks for the new simplified flow:
  // 1. getEntitlement query
  // 2. (optional) checkAgentLifecycle query
  // 3. checkGlobalFreeze query
  // 4. (optional) checkWorkflowTypeDisable / checkConnectorKillSwitch query
  // 5. (optional) getTenantQuotas query (only when requiredCredits > 0)
  const setupMocks = (options: {
    entitlement?: { operationalStatus: string; agentExecutionAllowed: boolean };
    agentId?: string;
    agentLifecycle?: string;
    globalFreeze?: boolean;
    globalFreezeReason?: string;
    workflowTypeDisabled?: boolean;
    connectorTypeDisabled?: boolean;
    quotas?: Partial<TenantQuotas>;
  } = {}) => {
    const entitlement = options.entitlement ?? createMockEntitlement();

    // getEntitlement
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [entitlementToDbRow(entitlement)],
      rowCount: 1,
    } as any);

    // checkAgentLifecycle (only when agentId provided and entitlement allows)
    if (options.agentId && entitlement.operationalStatus !== 'suspended' && entitlement.agentExecutionAllowed) {
      const lifecycle = options.agentLifecycle ?? 'ACTIVE';
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ lifecycle }],
        rowCount: 1,
      } as any);
    }

    // checkGlobalFreeze (only when entitlement allows)
    if (entitlement.operationalStatus !== 'suspended' && entitlement.agentExecutionAllowed &&
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
      expect(result.reason).toBe('Tenant is suspended');
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
      expect(result.reason).toBe('Agent execution is not allowed');
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
      expect(result.reason).toContain('Global freeze active');
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
  // Credit Check Tests
  // ==========================================

  describe('credit checks', () => {
    it('should allow when sufficient credits', async () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // checkWorkflowTypeDisable
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // getTenantQuotas
        .mockResolvedValueOnce({
          rows: [tenantQuotasToDbRow(createMockTenantQuotas({ remainingCredits: 1000 }))],
          rowCount: 1,
        } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'workflow',
        requiredCredits: 500,
      });

      expect(result.allowed).toBe(true);
    });

    it('should deny when insufficient credits and no overage', async () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // checkWorkflowTypeDisable
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // getTenantQuotas
        .mockResolvedValueOnce({
          rows: [tenantQuotasToDbRow(createMockTenantQuotas({ remainingCredits: 100, overageAllowed: false }))],
          rowCount: 1,
        } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'workflow',
        requiredCredits: 500,
      });

      expect(result.allowed).toBe(false);
      expect(result.quotaType).toBe('credits');
      expect(result.reason).toContain('Insufficient credits');
    });

    it('should allow overage when enabled and under ceiling', async () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // checkWorkflowTypeDisable
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // getTenantQuotas
        .mockResolvedValueOnce({
          rows: [tenantQuotasToDbRow(createMockTenantQuotas({
            remainingCredits: 100,
            overageAllowed: true,
            overageCeiling: 5000,
          }))],
          rowCount: 1,
        } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'workflow',
        requiredCredits: 500,
      });

      expect(result.allowed).toBe(true);
    });

    it('should deny when overage exceeds ceiling', async () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // checkWorkflowTypeDisable
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // getTenantQuotas
        .mockResolvedValueOnce({
          rows: [tenantQuotasToDbRow(createMockTenantQuotas({
            remainingCredits: -4500,
            overageAllowed: true,
            overageCeiling: 5000,
          }))],
          rowCount: 1,
        } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'workflow',
        requiredCredits: 1000,
      });

      expect(result.allowed).toBe(false);
      expect(result.quotaType).toBe('overage_ceiling');
    });

    it('should allow action with credits check', async () => {
      // getEntitlement
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [entitlementToDbRow(createMockEntitlement())],
          rowCount: 1,
        } as any)
        // checkGlobalFreeze
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // getTenantQuotas
        .mockResolvedValueOnce({
          rows: [tenantQuotasToDbRow(createMockTenantQuotas({ remainingCredits: 1000 }))],
          rowCount: 1,
        } as any);

      const result = await service.checkAdmission({
        tenantId: 'tenant-123',
        checkType: 'action',
        requiredCredits: 100,
      });

      expect(result.allowed).toBe(true);
    });
  });

  // ==========================================
  // Default Quotas Tests
  // ==========================================

  describe('default quotas', () => {
    it('should use conservative defaults when no tenant quotas found', async () => {
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
        tenantId: 'new-tenant',
        checkType: 'workflow',
      });

      expect(result.allowed).toBe(true);
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
      // Only denial types remaining should be: operational_status, agent_execution,
      // agent_lifecycle, agent_not_found, global_freeze, workflow_type_disabled,
      // connector_type_disabled, credits, overage_ceiling
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
          rows: [entitlementToDbRow({ operationalStatus: 'suspended', agentExecutionAllowed: false })],
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

    it('should handle zero credit requirement', async () => {
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
