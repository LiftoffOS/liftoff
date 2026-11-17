// Action Ledger Service Unit Tests
// Tests action recording, idempotency, and compensation

import { ActionLedgerService } from './service';
import { ActionRepository, CompensationRepository } from './repository';
import { CompensationService } from './compensation-service';
import { pool } from '../infrastructure/database';
import {
  createMockAction,
  createMockCompensationPlan,
  actionToDbRow,
} from '../test-utils/mocks';

// Mock dependencies
jest.mock('../infrastructure/database');
jest.mock('../infrastructure/logging');

const mockPool = pool as jest.Mocked<typeof pool>;

describe('ActionLedgerService', () => {
  let service: ActionLedgerService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ActionLedgerService();
  });

  // ==========================================
  // Record Intent Tests
  // ==========================================

  describe('recordIntent', () => {
    it('should create action record with pending status', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'action-new-123' }],
        rowCount: 1,
      } as any);

      const actionId = await service.recordIntent({
        tenantId: 'tenant-123',
        agentId: 'agent-456',
        workflowId: 'wf-789',
        taskId: 'task-012',
        idempotencyKey: 'idem-key-unique',
        connector: 'salesforce',
        entityType: 'Account',
        actionType: 'update',
        targetRef: 'account-ref-123',
        snapshot: { Name: 'Old Name' },
      });

      expect(actionId).toBe('action-new-123');
      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO actions'),
        expect.arrayContaining([
          'tenant-123',
          'agent-456',
          'wf-789',
          'task-012',
          'idem-key-unique',
          'salesforce',
          'Account',
          'update',
          'account-ref-123',
          JSON.stringify({ Name: 'Old Name' }),
          'pending',
        ])
      );
    });

    it('should store snapshot as JSON', async () => {
      const complexSnapshot = {
        Name: 'Test Account',
        Industry: 'Technology',
        Contacts: [{ id: 'c1' }, { id: 'c2' }],
      };

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'action-123' }],
        rowCount: 1,
      } as any);

      await service.recordIntent({
        tenantId: 'tenant-123',
        agentId: 'agent-456',
        workflowId: 'wf-789',
        taskId: 'task-012',
        idempotencyKey: 'idem-key',
        connector: 'salesforce',
        entityType: 'Account',
        actionType: 'update',
        targetRef: 'ref-123',
        snapshot: complexSnapshot,
      });

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([JSON.stringify(complexSnapshot)])
      );
    });

    it('should handle null snapshot', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'action-123' }],
        rowCount: 1,
      } as any);

      await service.recordIntent({
        tenantId: 'tenant-123',
        agentId: 'agent-456',
        workflowId: 'wf-789',
        taskId: 'task-012',
        idempotencyKey: 'idem-key',
        connector: 'salesforce',
        entityType: 'Account',
        actionType: 'create',
        targetRef: 'new-account',
      });

      expect((mockPool.query as jest.Mock)).toHaveBeenCalled();
    });
  });

  // ==========================================
  // Record Outcome Tests
  // ==========================================

  describe('recordOutcome', () => {
    it('should update action with success status', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      await service.recordOutcome('action-123', {
        success: true,
        data: { id: 'new-record-id', Name: 'Updated Name' },
      });

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE actions SET'),
        expect.arrayContaining([
          'action-123',
          JSON.stringify({ id: 'new-record-id', Name: 'Updated Name' }),
          'completed',
        ])
      );
    });

    it('should update action with failed status on unsuccessful result', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      await service.recordOutcome('action-123', {
        success: false,
        data: null,
        error: 'API error',
      });

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE actions SET'),
        expect.arrayContaining(['failed'])
      );
    });

    it('should set completedAt timestamp', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      await service.recordOutcome('action-123', { success: true, data: {} });

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('completed_at'),
        expect.arrayContaining([expect.any(Date)])
      );
    });
  });

  // ==========================================
  // Record Failure Tests
  // ==========================================

  describe('recordFailure', () => {
    it('should record error message', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      await service.recordFailure('action-123', new Error('Connection timeout'));

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE actions SET'),
        expect.arrayContaining(['action-123', 'Connection timeout', 'failed'])
      );
    });

    it('should handle string errors', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      await service.recordFailure('action-123', 'Simple error string');

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['Simple error string'])
      );
    });
  });

  // ==========================================
  // Retrieval Tests
  // ==========================================

  describe('getById', () => {
    it('should return action when found', async () => {
      const mockAction = createMockAction();

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [actionToDbRow(mockAction)],
        rowCount: 1,
      } as any);

      const result = await service.getById('action-test-123');

      expect(result).toBeDefined();
      expect(result?.id).toBe(mockAction.id);
      expect(result?.connector).toBe('salesforce');
    });

    it('should return null when not found', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);

      const result = await service.getById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getByWorkflowId', () => {
    it('should return all actions for workflow', async () => {
      const mockActions = [
        createMockAction({ id: 'action-1' }),
        createMockAction({ id: 'action-2' }),
        createMockAction({ id: 'action-3' }),
      ];

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: mockActions.map(actionToDbRow),
        rowCount: 3,
      } as any);

      const result = await service.getByWorkflowId('wf-test-123');

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('action-1');
      expect(result[2].id).toBe('action-3');
    });

    it('should return empty array when no actions', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);

      const result = await service.getByWorkflowId('wf-no-actions');

      expect(result).toHaveLength(0);
    });
  });

  // ==========================================
  // Idempotency Tests
  // ==========================================

  describe('getByIdempotencyKey', () => {
    it('should return action by idempotency key', async () => {
      const mockAction = createMockAction({
        idempotencyKey: 'unique-idem-key-123',
        status: 'completed',
      });

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [actionToDbRow(mockAction)],
        rowCount: 1,
      } as any);

      const result = await service.getByIdempotencyKey('unique-idem-key-123');

      expect(result).toBeDefined();
      expect(result?.idempotencyKey).toBe('unique-idem-key-123');
      expect(result?.status).toBe('completed');
    });

    it('should return null for unknown key', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);

      const result = await service.getByIdempotencyKey('unknown-key');

      expect(result).toBeNull();
    });
  });
});

// ==========================================
// ActionRepository Unit Tests
// ==========================================

describe('ActionRepository', () => {
  let repository: ActionRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repository = new ActionRepository();
  });

  describe('createAction', () => {
    it('should insert action and return id', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'new-action-id' }],
        rowCount: 1,
      } as any);

      const id = await repository.createAction({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        workflowId: 'wf-1',
        taskId: 'task-1',
        idempotencyKey: 'key-1',
        connector: 'salesforce',
        entityType: 'Account',
        actionType: 'update',
        targetRef: 'ref-1',
        preActionSnapshot: {},
        status: 'pending',
      });

      expect(id).toBe('new-action-id');
    });
  });

  describe('updateAction', () => {
    it('should update only provided fields', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      await repository.updateAction('action-1', {
        status: 'completed',
      });

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('status'),
        expect.arrayContaining(['action-1', 'completed'])
      );
    });

    it('should not update when no fields provided', async () => {
      await repository.updateAction('action-1', {});

      expect((mockPool.query as jest.Mock)).not.toHaveBeenCalled();
    });
  });

  describe('findByTaskId', () => {
    it('should return actions for task', async () => {
      const mockActions = [
        createMockAction({ id: 'action-1', taskId: 'task-123' }),
        createMockAction({ id: 'action-2', taskId: 'task-123' }),
      ];

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: mockActions.map(actionToDbRow),
        rowCount: 2,
      } as any);

      const result = await repository.findByTaskId('task-123');

      expect(result).toHaveLength(2);
    });
  });

  describe('findCompletedActionsForWorkflow', () => {
    it('should return completed actions in reverse order', async () => {
      const completedActions = [
        createMockAction({
          id: 'action-3',
          status: 'completed',
          completedAt: new Date('2024-01-03'),
        }),
        createMockAction({
          id: 'action-2',
          status: 'completed',
          completedAt: new Date('2024-01-02'),
        }),
        createMockAction({
          id: 'action-1',
          status: 'completed',
          completedAt: new Date('2024-01-01'),
        }),
      ];

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: completedActions.map(actionToDbRow),
        rowCount: 3,
      } as any);

      const result = await repository.findCompletedActionsForWorkflow('wf-123');

      expect(result).toHaveLength(3);
      // Should be in DESC order by completed_at
      expect(result[0].id).toBe('action-3');
    });
  });

  describe('markAsCompensated', () => {
    it('should update status to compensated', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      await repository.markAsCompensated('action-123');

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining("status = 'compensated'"),
        ['action-123']
      );
    });
  });
});

// ==========================================
// CompensationRepository Unit Tests
// ==========================================

describe('CompensationRepository', () => {
  let repository: CompensationRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repository = new CompensationRepository();
  });

  describe('createCompensationAction', () => {
    it('should create compensation action record', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{
          id: 'comp-action-123',
          original_action_id: 'action-123',
          workflow_id: 'wf-123',
          task_id: 'task-123',
          compensation_type: 'restore',
          compensation_data: {},
          status: 'pending',
          error: null,
          created_at: new Date(),
          executed_at: null,
        }],
        rowCount: 1,
      } as any);

      const result = await repository.createCompensationAction({
        originalActionId: 'action-123',
        workflowId: 'wf-123',
        taskId: 'task-123',
        compensationType: 'restore',
        compensationData: { snapshot: { Name: 'Old Name' } },
      });

      expect(result.originalActionId).toBe('action-123');
      expect(result.status).toBe('pending');
    });
  });

  describe('updateCompensationStatus', () => {
    it('should update status and set executed_at for completed', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      await repository.updateCompensationStatus('comp-123', 'completed');

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('status = $2'),
        expect.arrayContaining(['comp-123', 'completed'])
      );
    });

    it('should include error message for failed status', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      await repository.updateCompensationStatus('comp-123', 'failed', 'API error');

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['failed', 'API error'])
      );
    });
  });

  describe('createPlan', () => {
    it('should create compensation plan with steps', async () => {
      const steps = [
        { actionId: 'action-1', compensationType: 'restore' as const, order: 0, status: 'pending' as const },
        { actionId: 'action-2', compensationType: 'semantic' as const, order: 1, status: 'pending' as const },
      ];

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{
          workflow_id: 'wf-123',
          reason: 'Test compensation',
          actions: steps,
          status: 'pending',
          created_at: new Date(),
          completed_at: null,
        }],
        rowCount: 1,
      } as any);

      const plan = await repository.createPlan({
        workflowId: 'wf-123',
        reason: 'Test compensation',
        steps,
      });

      expect(plan.workflowId).toBe('wf-123');
      expect(plan.actions).toHaveLength(2);
    });
  });

  describe('updatePlanStatus', () => {
    it('should update plan status', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      await repository.updatePlanStatus('wf-123', 'completed');

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE compensation_plans'),
        expect.arrayContaining(['wf-123', 'completed'])
      );
    });
  });

  describe('updatePlanStep', () => {
    it('should update specific step status', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      await repository.updatePlanStep('wf-123', 'action-1', 'completed');

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('jsonb_set'),
        expect.arrayContaining(['wf-123', 'action-1', 'completed'])
      );
    });
  });

  describe('findPlanByWorkflowId', () => {
    it('should return plan when found', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{
          workflow_id: 'wf-123',
          reason: 'Test',
          actions: [{ actionId: 'action-1', status: 'pending' }],
          status: 'pending',
          created_at: new Date(),
          completed_at: null,
        }],
        rowCount: 1,
      } as any);

      const plan = await repository.findPlanByWorkflowId('wf-123');

      expect(plan).toBeDefined();
      expect(plan?.workflowId).toBe('wf-123');
    });

    it('should return null when not found', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);

      const plan = await repository.findPlanByWorkflowId('non-existent');

      expect(plan).toBeNull();
    });
  });
});

// ==========================================
// CompensationService Unit Tests
// ==========================================

describe('CompensationService', () => {
  let service: CompensationService;
  let mockActionRepository: any;
  let mockCompensationRepository: any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CompensationService();

    // Mock repositories
    mockActionRepository = {
      findCompletedActionsForWorkflow: jest.fn().mockResolvedValue([]),
      findById: jest.fn(),
      markAsCompensated: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).actionRepository = mockActionRepository;

    mockCompensationRepository = {
      createPlan: jest.fn().mockResolvedValue(createMockCompensationPlan()),
      findPlanByWorkflowId: jest.fn(),
      updatePlanStatus: jest.fn().mockResolvedValue(undefined),
      updatePlanStep: jest.fn().mockResolvedValue(undefined),
      createCompensationAction: jest.fn().mockResolvedValue({
        id: 'comp-action-1',
        status: 'pending',
        compensationData: {},
      }),
      updateCompensationStatus: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).compensationRepository = mockCompensationRepository;
  });

  describe('buildCompensationPlan', () => {
    it('should create plan with actions in reverse order', async () => {
      const completedActions = [
        createMockAction({ id: 'action-1', actionType: 'create', preActionSnapshot: null }),
        createMockAction({ id: 'action-2', actionType: 'update', preActionSnapshot: { Name: 'Old' } }),
      ];

      mockActionRepository.findCompletedActionsForWorkflow.mockResolvedValue(completedActions);

      const _plan = await service.buildCompensationPlan('wf-123', 'Test reason');

      expect(mockCompensationRepository.createPlan).toHaveBeenCalledWith({
        workflowId: 'wf-123',
        reason: 'Test reason',
        steps: expect.arrayContaining([
          expect.objectContaining({ actionId: 'action-1' }),
          expect.objectContaining({ actionId: 'action-2' }),
        ]),
      });
    });

    it('should determine compensation type based on action type', async () => {
      const actions = [
        createMockAction({ id: 'action-create', actionType: 'create', preActionSnapshot: null }),
        createMockAction({ id: 'action-update', actionType: 'update', preActionSnapshot: { data: 'old' } }),
        createMockAction({ id: 'action-send', actionType: 'send', preActionSnapshot: null }),
      ];

      mockActionRepository.findCompletedActionsForWorkflow.mockResolvedValue(actions);

      await service.buildCompensationPlan('wf-123', 'Test');

      expect(mockCompensationRepository.createPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({ compensationType: 'semantic' }), // create -> delete
            expect.objectContaining({ compensationType: 'restore' }), // update with snapshot
            expect.objectContaining({ compensationType: 'manual' }), // send cannot be undone
          ]),
        })
      );
    });
  });

  describe('executeCompensationPlan', () => {
    it('should execute all steps and return results', async () => {
      const plan = createMockCompensationPlan({
        actions: [
          { actionId: 'action-1', compensationType: 'restore', order: 0, status: 'pending' },
        ],
      });

      mockCompensationRepository.findPlanByWorkflowId.mockResolvedValue(plan);
      mockActionRepository.findById.mockResolvedValue(
        createMockAction({ id: 'action-1', preActionSnapshot: { Name: 'Old' } })
      );

      // Mock credential service
      service.setCredentialService({
        getCredentials: jest.fn().mockResolvedValue({
          accessToken: 'token',
          instanceUrl: 'https://test.salesforce.com',
        }),
      });

      const result = await service.executeCompensationPlan('wf-123');

      expect(result.results).toHaveLength(1);
      expect(mockCompensationRepository.updatePlanStatus).toHaveBeenCalledWith('wf-123', 'executing');
    });

    it('should skip manual compensation steps', async () => {
      const plan = createMockCompensationPlan({
        actions: [
          { actionId: 'action-1', compensationType: 'manual', order: 0, status: 'pending' },
        ],
      });

      mockCompensationRepository.findPlanByWorkflowId.mockResolvedValue(plan);

      const result = await service.executeCompensationPlan('wf-123');

      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain('Manual compensation required');
      expect(mockCompensationRepository.updatePlanStep).toHaveBeenCalledWith('wf-123', 'action-1', 'skipped');
    });

    it('should throw when no plan found', async () => {
      mockCompensationRepository.findPlanByWorkflowId.mockResolvedValue(null);

      await expect(service.executeCompensationPlan('wf-123')).rejects.toThrow('No compensation plan found');
    });
  });

  describe('getCompensationStatus', () => {
    it('should return status counts', async () => {
      const plan = createMockCompensationPlan({
        actions: [
          { actionId: 'action-1', compensationType: 'restore', order: 0, status: 'completed' },
          { actionId: 'action-2', compensationType: 'restore', order: 1, status: 'completed' },
          { actionId: 'action-3', compensationType: 'restore', order: 2, status: 'pending' },
          { actionId: 'action-4', compensationType: 'restore', order: 3, status: 'failed' },
        ],
      });

      mockCompensationRepository.findPlanByWorkflowId.mockResolvedValue(plan);

      const status = await service.getCompensationStatus('wf-123');

      expect(status.completedCount).toBe(2);
      expect(status.pendingCount).toBe(1);
      expect(status.failedCount).toBe(1);
    });

    it('should return zeros when no plan exists', async () => {
      mockCompensationRepository.findPlanByWorkflowId.mockResolvedValue(null);

      const status = await service.getCompensationStatus('wf-123');

      expect(status.plan).toBeNull();
      expect(status.completedCount).toBe(0);
      expect(status.pendingCount).toBe(0);
      expect(status.failedCount).toBe(0);
    });
  });
});
