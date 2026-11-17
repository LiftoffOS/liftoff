// Coordinator Service Unit Tests
// Tests workflow lifecycle: start, resume, reconcile, compensate

import { CoordinatorService } from './service';
import { pool } from '../infrastructure/database';
import {
  createMockWorkflow,
  createMockTask,
  createMockChildTask,
  createMockWorkflowHierarchy,
  createMockAction,
  createMockCompensationPlan,
  workflowToDbRow,
  taskToDbRow,
  childTaskToDbRow,
  workflowHierarchyToDbRow,
  actionToDbRow,
} from '../test-utils/mocks';

// Mock dependencies
jest.mock('../infrastructure/database');
jest.mock('../infrastructure/logging');
jest.mock('../action-ledger/compensation-service');
jest.mock('../admission/service');

import { AdmissionService } from '../admission/service';
import { AdmissionDeniedError } from '../admission/types';

const mockPool = pool as jest.Mocked<typeof pool>;

// Configure the auto-mocked AdmissionService to return allowed by default
const mockAdmissionInstance = AdmissionService.prototype as jest.Mocked<AdmissionService>;
mockAdmissionInstance.checkAdmission = jest.fn().mockResolvedValue({ allowed: true });

describe('CoordinatorService', () => {
  let service: CoordinatorService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset admission mock to allow by default
    mockAdmissionInstance.checkAdmission = jest.fn().mockResolvedValue({ allowed: true });
    service = new CoordinatorService();
  });

  // checkChildTasksCompletion opens a transactional client via pool.connect()
  // and runs BEGIN / advisory-lock / advance / count(*) / COMMIT. The global
  // client mock returns {rows:[]} for everything, but Postgres always returns a
  // row for count(*); this routes the count query to a real row so the fan-in
  // resolves (no paused parent, no blocked children → all-terminal aggregation).
  async function configureTxClient() {
    const txClient = await (mockPool.connect as jest.Mock)();
    (txClient.query as jest.Mock).mockImplementation((sql: unknown) =>
      Promise.resolve(
        typeof sql === 'string' && sql.includes('count(*)')
          ? { rows: [{ pending: '0' }], rowCount: 1 }
          : { rows: [], rowCount: 0 },
      ),
    );
  }

  // ==========================================
  // Workflow Start Tests
  // ==========================================

  describe('startWorkflow', () => {
    // Valid UUIDs for tests that go through repository validation
    const validTenantId = '00000000-0000-1000-8000-000000000001';
    const validAgentId = '00000000-0000-1000-8000-000000000002';

    it('should create a new workflow successfully', async () => {
      const mockWorkflow = createMockWorkflow({
        tenantId: validTenantId,
        agentId: validAgentId,
      });
      const mockHierarchy = createMockWorkflowHierarchy();

      // Admission is allowed by default (configured in beforeEach)
      (mockPool.query as jest.Mock)
        // checkWorkflowKillSwitch query
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 0,
        } as any)
        // Create workflow
        .mockResolvedValueOnce({
          rows: [workflowToDbRow(mockWorkflow)],
          rowCount: 1,
        } as any)
        // Create hierarchy
        .mockResolvedValueOnce({
          rows: [workflowHierarchyToDbRow(mockHierarchy)],
          rowCount: 1,
        } as any);

      const result = await service.startWorkflow({
        tenantId: validTenantId,
        agentId: validAgentId,
        objective: 'Test workflow objective',
      });

      expect(result).toBeDefined();
      expect(result.id).toBe(mockWorkflow.id);
      expect(result.status).toBe('pending');
    });

    it('should reject workflow when admission control fails', async () => {
      // Override admission to deny
      (service as any).admissionService.checkAdmission = jest.fn().mockResolvedValue({
        allowed: false,
        reason: 'Global freeze active: incident-4412',
        quotaType: 'global_freeze',
      });

      await expect(
        service.startWorkflow({
          tenantId: 'tenant-test-456',
          agentId: 'agent-test-789',
          objective: 'Test workflow objective',
        })
      ).rejects.toThrow('Workflow admission denied');
    });

    it('throws a typed AdmissionDeniedError carrying the reason and the gate', async () => {
      // Every admission gate throws the same type, so the workflow path is
      // classifiable without anyone parsing its message prose.
      (service as any).admissionService.checkAdmission = jest.fn().mockResolvedValue({
        allowed: false,
        reason: 'Tenant is suspended for billing',
        quotaType: 'billing_suspended',
      });

      const start = () => service.startWorkflow({
        tenantId: 'tenant-test-456',
        agentId: 'agent-test-789',
        objective: 'Test workflow objective',
      });

      await expect(start()).rejects.toBeInstanceOf(AdmissionDeniedError);
      await expect(start()).rejects.toMatchObject({
        reason: 'Tenant is suspended for billing',
        quotaType: 'billing_suspended',
        code: 'admission_denied',
      });
    });

    it('should reject workflow when tenant is suspended', async () => {
      // Override admission to deny (suspended tenant)
      (service as any).admissionService.checkAdmission = jest.fn().mockResolvedValue({
        allowed: false,
        reason: 'Tenant suspended',
        quotaType: 'operational_status',
      });

      await expect(
        service.startWorkflow({
          tenantId: 'tenant-test-456',
          agentId: 'agent-test-789',
          objective: 'Test workflow objective',
        })
      ).rejects.toThrow('Workflow admission denied');
    });

    it('should reject workflow when max depth exceeded for nested workflows', async () => {
      const parentHierarchy = createMockWorkflowHierarchy({
        workflowId: 'parent-wf-123',
        depth: 10, // At max depth
      });

      // Admission allowed
      mockAdmissionInstance.checkAdmission = jest.fn().mockResolvedValueOnce({ allowed: true });

      (mockPool.query as jest.Mock)
        // checkWorkflowKillSwitch query (no kill switch active)
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 0,
        } as any)
        // Hierarchy lookup for depth check (depth >= MAX_WORKFLOW_DEPTH → reject)
        .mockResolvedValueOnce({
          rows: [workflowHierarchyToDbRow(parentHierarchy)],
          rowCount: 1,
        } as any);

      await expect(
        service.startWorkflow({
          tenantId: 'tenant-test-456',
          agentId: 'agent-test-789',
          objective: 'Nested workflow',
          parentWorkflowId: 'parent-wf-123',
        })
      ).rejects.toThrow('Maximum workflow nesting depth');
    });
  });

  // ==========================================
  // Workflow Retrieval Tests
  // ==========================================

  describe('getWorkflow', () => {
    it('should return workflow when found', async () => {
      const mockWorkflow = createMockWorkflow();

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [workflowToDbRow(mockWorkflow)],
        rowCount: 1,
      } as any);

      const result = await service.getWorkflow('wf-test-123');

      expect(result).toBeDefined();
      expect(result?.id).toBe(mockWorkflow.id);
    });

    it('should return null when workflow not found', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);

      const result = await service.getWorkflow('non-existent');

      expect(result).toBeNull();
    });
  });

  // ==========================================
  // Child Task Tests
  // ==========================================

  describe('spawnChildTask', () => {
    it('should create child task when parent exists', async () => {
      const mockTask = createMockTask();
      const mockWorkflow = createMockWorkflow();
      const mockChildTask = createMockChildTask();

      (mockPool.query as jest.Mock)
        // Find parent task
        .mockResolvedValueOnce({
          rows: [taskToDbRow(mockTask)],
          rowCount: 1,
        } as any)
        // Find workflow (for ownership check)
        .mockResolvedValueOnce({
          rows: [workflowToDbRow(mockWorkflow)],
          rowCount: 1,
        } as any)
        // Create child task
        .mockResolvedValueOnce({
          rows: [childTaskToDbRow(mockChildTask)],
          rowCount: 1,
        } as any);

      const result = await service.spawnChildTask({
        parentTaskId: 'task-test-123',
        workflowId: 'wf-test-123',
        objective: 'Child task objective',
        inputData: { key: 'value' },
      });

      expect(result).toBeDefined();
      expect(result.parentTaskId).toBe(mockTask.id);
      expect(result.objective).toBe('Child task objective');
    });

    it('should throw error when parent task not found', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);

      await expect(
        service.spawnChildTask({
          parentTaskId: 'non-existent',
          workflowId: 'wf-test-123',
          objective: 'Child task objective',
        })
      ).rejects.toThrow('Parent task non-existent not found');
    });
  });

  describe('completeChildTask', () => {
    it('should mark child task as completed', async () => {
      const mockChildTask = createMockChildTask({ status: 'completed' });

      (mockPool.query as jest.Mock)
        // Update child task
        .mockResolvedValueOnce({
          rows: [childTaskToDbRow(mockChildTask)],
          rowCount: 1,
        } as any)
        // Find sibling tasks for completion check
        .mockResolvedValueOnce({
          rows: [childTaskToDbRow(mockChildTask)],
          rowCount: 1,
        } as any)
        // Update parent task with results
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 1,
        } as any);

      // checkChildTasksCompletion runs its fan-in inside a pool.connect() tx.
      // Postgres always returns one row for SELECT count(*); make the mock
      // client mirror that (no siblings pending → all-terminal aggregation).
      await configureTxClient();

      const result = await service.completeChildTask('child-task-test-123', { success: true });

      expect(result.status).toBe('completed');
    });
  });

  describe('failChildTask', () => {
    it('should mark child task as failed with error', async () => {
      const existingChildTask = createMockChildTask({ status: 'running' });
      const failedChildTask = createMockChildTask({
        status: 'failed',
        error: 'Task failed',
      });

      (mockPool.query as jest.Mock)
        // findById (child task lookup)
        .mockResolvedValueOnce({
          rows: [childTaskToDbRow(existingChildTask)],
          rowCount: 1,
        } as any)
        // fail (UPDATE ... RETURNING *)
        .mockResolvedValueOnce({
          rows: [childTaskToDbRow(failedChildTask)],
          rowCount: 1,
        } as any);

      // failChildTask now also runs checkChildTasksCompletion (fan-in) — same
      // transactional count(*) as completeChildTask.
      await configureTxClient();

      const result = await service.failChildTask('child-task-test-123', 'Task failed');

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Task failed');
    });
  });

  // ==========================================
  // Sub-Workflow Tests
  // ==========================================

  describe('spawnSubWorkflow', () => {
    it('should create sub-workflow when parent task exists', async () => {
      // Valid UUIDs for repository validation
      const validTenantId = '00000000-0000-1000-8000-000000000001';
      const validAgentId = '00000000-0000-1000-8000-000000000002';

      const mockTask = createMockTask();
      const mockParentWorkflow = createMockWorkflow({
        id: 'wf-test-123',
        tenantId: validTenantId,
        agentId: validAgentId,
      });
      const mockSubWorkflow = createMockWorkflow({
        id: 'sub-wf-123',
        tenantId: validTenantId,
        agentId: validAgentId,
      });
      const mockHierarchy = createMockWorkflowHierarchy({
        workflowId: 'sub-wf-123',
        parentWorkflowId: 'wf-test-123',
        depth: 1,
      });
      const mockChildTask = createMockChildTask();

      (mockPool.query as jest.Mock)
        // 1. Find parent task (spawnSubWorkflow)
        .mockResolvedValueOnce({
          rows: [taskToDbRow(mockTask)],
          rowCount: 1,
        } as any)
        // 2. Find parent workflow (ownership check)
        .mockResolvedValueOnce({
          rows: [workflowToDbRow(mockParentWorkflow)],
          rowCount: 1,
        } as any)
        // 3. startWorkflow: checkWorkflowKillSwitch query (no kill switch)
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 0,
        } as any)
        // 4. startWorkflow: hierarchy lookup for depth check (parentWorkflowId)
        .mockResolvedValueOnce({
          rows: [workflowHierarchyToDbRow(createMockWorkflowHierarchy())],
          rowCount: 1,
        } as any)
        // 5. startWorkflow: Create workflow
        .mockResolvedValueOnce({
          rows: [workflowToDbRow(mockSubWorkflow)],
          rowCount: 1,
        } as any)
        // 6. startWorkflow: Hierarchy lookup for depth calculation
        .mockResolvedValueOnce({
          rows: [workflowHierarchyToDbRow(createMockWorkflowHierarchy())],
          rowCount: 1,
        } as any)
        // 7. startWorkflow: Hierarchy lookup for root calculation
        .mockResolvedValueOnce({
          rows: [workflowHierarchyToDbRow(createMockWorkflowHierarchy())],
          rowCount: 1,
        } as any)
        // 8. startWorkflow: Create hierarchy
        .mockResolvedValueOnce({
          rows: [workflowHierarchyToDbRow(mockHierarchy)],
          rowCount: 1,
        } as any)
        // 9. Create child task
        .mockResolvedValueOnce({
          rows: [childTaskToDbRow(mockChildTask)],
          rowCount: 1,
        } as any);

      const result = await service.spawnSubWorkflow({
        parentTaskId: 'task-test-123',
        parentWorkflowId: 'wf-test-123',
        tenantId: validTenantId,
        agentId: validAgentId,
        objective: 'Sub-workflow objective',
      });

      expect(result).toBeDefined();
      expect(result.id).toBe('sub-wf-123');
    });
  });

  // ==========================================
  // Resume Workflow Tests
  // ==========================================

  describe('resumeWorkflow', () => {
    it('should resume workflow from checkpoint', async () => {
      const mockWorkflow = createMockWorkflow({ status: 'running' });
      const mockTask = createMockTask({ status: 'leased' });
      const mockAction = createMockAction({ status: 'completed' });
      const mockCheckpoint = {
        id: 'checkpoint-123',
        workflow_id: 'wf-test-123',
        task_id: 'task-test-123',
        state: { step: 3 },
        created_at: new Date(),
      };

      (mockPool.query as jest.Mock)
        // Find workflow
        .mockResolvedValueOnce({
          rows: [workflowToDbRow(mockWorkflow)],
          rowCount: 1,
        } as any)
        // Find leased/incomplete tasks
        .mockResolvedValueOnce({
          rows: [taskToDbRow(mockTask)],
          rowCount: 1,
        } as any)
        // Find actions for task
        .mockResolvedValueOnce({
          rows: [actionToDbRow(mockAction)],
          rowCount: 1,
        } as any)
        // Find child tasks
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 0,
        } as any)
        // Get checkpoint
        .mockResolvedValueOnce({
          rows: [mockCheckpoint],
          rowCount: 1,
        } as any)
        // Find child workflows
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 0,
        } as any);

      await expect(service.resumeWorkflow('wf-test-123')).resolves.not.toThrow();
    });

    it('should throw error when workflow not found', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);

      await expect(service.resumeWorkflow('non-existent')).rejects.toThrow('Workflow not found');
    });
  });

  // ==========================================
  // Reconciliation Tests
  // ==========================================

  describe('runReconciliation', () => {
    it('should reconcile all active workflows', async () => {
      const mockWorkflow1 = createMockWorkflow({ id: 'wf-1', status: 'running' });
      const mockWorkflow2 = createMockWorkflow({ id: 'wf-2', status: 'pending' });

      (mockPool.query as jest.Mock)
        // Find active workflows
        .mockResolvedValueOnce({
          rows: [
            workflowToDbRow(mockWorkflow1),
            workflowToDbRow(mockWorkflow2),
          ],
          rowCount: 2,
        } as any)
        // Reconcile workflow 1 - find leased tasks
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // Find child workflows for wf-1
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // Reconcile workflow 2 - find leased tasks
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // Find child workflows for wf-2
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await expect(service.runReconciliation()).resolves.not.toThrow();
    });

    it('should handle reconciliation errors gracefully', async () => {
      const mockWorkflow = createMockWorkflow({ status: 'running' });

      (mockPool.query as jest.Mock)
        // Find active workflows
        .mockResolvedValueOnce({
          rows: [workflowToDbRow(mockWorkflow)],
          rowCount: 1,
        } as any)
        // Reconcile fails
        .mockRejectedValueOnce(new Error('Database error'));

      // Should not throw, just log error
      await expect(service.runReconciliation()).resolves.not.toThrow();
    });
  });

  // ==========================================
  // Compensation Tests
  // ==========================================

  describe('compensateWorkflow', () => {
    it('should compensate workflow successfully', async () => {
      const mockWorkflow = createMockWorkflow({ status: 'running' });
      const mockCompensationPlan = createMockCompensationPlan();

      // Mock the compensation service methods
      const mockCompensationService = {
        buildCompensationPlan: jest.fn().mockResolvedValue(mockCompensationPlan),
        executeCompensationPlan: jest.fn().mockResolvedValue({
          success: true,
          results: [],
          errors: [],
        }),
      };

      // Access private property for testing
      (service as any).compensationService = mockCompensationService;

      (mockPool.query as jest.Mock)
        // Find workflow
        .mockResolvedValueOnce({
          rows: [workflowToDbRow(mockWorkflow)],
          rowCount: 1,
        } as any)
        // Update status to compensating
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
        // Find child workflows
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // Update compensation state
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
        // Update status to failed
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await service.compensateWorkflow('wf-test-123', 'User requested');

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should throw error when workflow not found', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);

      await expect(
        service.compensateWorkflow('non-existent', 'User requested')
      ).rejects.toThrow('Workflow non-existent not found');
    });

    it('should compensate child workflows recursively', async () => {
      const mockWorkflow = createMockWorkflow({ id: 'parent-wf', status: 'running' });
      const mockChildWorkflow = createMockWorkflow({ id: 'child-wf', status: 'running' });
      const mockCompensationPlan = createMockCompensationPlan();

      const mockCompensationService = {
        buildCompensationPlan: jest.fn().mockResolvedValue(mockCompensationPlan),
        executeCompensationPlan: jest.fn().mockResolvedValue({
          success: true,
          results: [],
          errors: [],
        }),
      };

      (service as any).compensationService = mockCompensationService;

      (mockPool.query as jest.Mock)
        // Find parent workflow
        .mockResolvedValueOnce({
          rows: [workflowToDbRow(mockWorkflow)],
          rowCount: 1,
        } as any)
        // Update status to compensating
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
        // Find child workflows
        .mockResolvedValueOnce({
          rows: [workflowToDbRow(mockChildWorkflow)],
          rowCount: 1,
        } as any)
        // Find child workflow for recursive compensation
        .mockResolvedValueOnce({
          rows: [workflowToDbRow(mockChildWorkflow)],
          rowCount: 1,
        } as any)
        // Update child status to compensating
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
        // Find child's child workflows (none)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        // Update child compensation state
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
        // Update child status to failed
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
        // Update parent compensation state
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
        // Update parent status to failed
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await service.compensateWorkflow('parent-wf', 'User requested');

      expect(result.success).toBe(true);
    });
  });

  describe('getCompensationStatus', () => {
    it('should return compensation status', async () => {
      const mockCompensationService = {
        getCompensationStatus: jest.fn().mockResolvedValue({
          plan: createMockCompensationPlan(),
          completedCount: 1,
          pendingCount: 0,
          failedCount: 0,
        }),
      };

      (service as any).compensationService = mockCompensationService;

      const result = await service.getCompensationStatus('wf-test-123');

      expect(result.status).toBe('pending');
      expect(result.completedCount).toBe(1);
    });

    it('should return none status when no plan exists', async () => {
      const mockCompensationService = {
        getCompensationStatus: jest.fn().mockResolvedValue({
          plan: null,
          completedCount: 0,
          pendingCount: 0,
          failedCount: 0,
        }),
      };

      (service as any).compensationService = mockCompensationService;

      const result = await service.getCompensationStatus('wf-test-123');

      expect(result.status).toBe('none');
    });
  });

  describe('compensateAction', () => {
    it('should compensate single action', async () => {
      const mockCompensationService = {
        compensateAction: jest.fn().mockResolvedValue({
          success: true,
        }),
      };

      (service as any).compensationService = mockCompensationService;

      const result = await service.compensateAction('action-123', 'Manual compensation');

      expect(result.success).toBe(true);
    });
  });
});
